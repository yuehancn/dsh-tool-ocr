/**
 * Model-facing document text-extraction tools: OCR an image, or pull text out
 * of a PDF / scanned page, through a pluggable local extractor backend.
 *
 * This plugin owns the model-facing schemas (engine selection, language hints,
 * page ranges, region cropping), the presentation, and the sync/async split. It
 * talks to a local extractor over a small JSON contract so the heavy lifting
 * (a real OCR model, a real PDF text layer) stays outside the plugin process —
 * which is what makes it usable on a machine where Node cannot run PaddleOCR.
 *
 * Design notes
 * - Two backends ship: `native` (pdftotext / a text-layer read for born-digital
 *   PDFs, zero extra install) and `command` (any external OCR binary the user
 *   configures — tesseract, PaddleOCR, RapidOCR, a company API client).
 * - Text extraction is a two-step job for scans: rasterize to an image, then
 *   OCR. The plugin detects which step is needed from the file itself rather
 *   than asking the model, and reports which path it took.
 * - Every call returns structured fields (language, page count, mean
 *   confidence) plus the text, so the agent can decide whether the OCR is
 *   trustworthy enough to act on instead of guessing from a wall of text.
 *
 * @module dsh-tool-ocr
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve, basename, extname } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-ocr";

/** Services required by the OCR tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call timeout budget (ms). */
const DEFAULT_TIMEOUT_MS = 300000;

/** Image extensions the plugin will hand straight to an OCR backend. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif"]);

/** Extensions treated as PDFs. */
const PDF_EXTENSIONS = new Set([".pdf"]);

/* ------------------------------------------------------------------ config */

/**
 * One external extractor the model may address by id.
 *
 * @typedef {object} EngineConfig
 * @property {string} id - stable id the model uses to pick this engine.
 * @property {string} [label] - human description shown in status output.
 * @property {string} [command] - executable to spawn (tesseract, paddleocr, ...).
 * @property {string[]} [args] - argument template; placeholders below.
 * @property {boolean} [isDefault] - use this engine when the model names none.
 * @property {number} [timeoutMs] - per-engine override of the call budget.
 */

/**
 * Argument placeholders substituted per call:
 *   {input}  - absolute path of the image handed to the engine
 *   {output} - absolute path the engine should write plain text to
 *   {lang}   - language hint (may be empty)
 */
const ARG_PLACEHOLDERS = ["{input}", "{output}", "{lang}"];

const Config = z.object({
	/** External extractors, addressed by id. */
	engines: z.array(z.object({
		id: z.string().required(),
		label: z.string(),
		command: z.string(),
		args: z.array(z.string()),
		isDefault: z.boolean(),
		timeoutMs: z.number()
	})).default([]),
	/** Which backend a call uses when no engine is named: "native" or "command". */
	backend: z.union([z.const("native"), z.const("command")]).default("native"),
	/** Directory for extracted text and intermediate rasters. */
	outputDir: z.string().default("ocr-output"),
	/** Keep the intermediate raster between steps instead of deleting it. */
	keepIntermediate: z.boolean().default(false),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Register `ocr_read`. Defaults to true. */
	read: z.boolean().default(true),
	/** Register `ocr_status`. Defaults to true. */
	status: z.boolean().default(true),
	/** Upper bound on pages one call may process. */
	maxPages: z.number().default(50)
});

/* ---------------------------------------------------------------- process */

/**
 * Run a command and capture stdout/stderr, with a hard timeout. A non-zero exit
 * becomes a thrown Error carrying the tail of stderr, so the model reads why
 * the engine failed instead of a bare spawn error.
 *
 * @param {string} command - executable to spawn.
 * @param {string[]} args - arguments.
 * @param {{timeoutMs: number, signal?: AbortSignal, cwd?: string}} options - run options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured result.
 */
function runCommand(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				windowsHide: true,
				shell: false
			});
		} catch (error) {
			reject(new Error(`ocr: cannot start "${command}" (${error?.message ?? error}). Check the engine's "command" in the plugin config.`));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`ocr: "${command}" exceeded its ${Math.round(options.timeoutMs / 1000)}s budget. Raise timeoutMs or shrink the page range.`));
		}, options.timeoutMs);

		const onAbort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill("SIGKILL");
			reject(options.signal?.reason ?? new Error("aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new Error(`ocr: "${command}" failed to run (${error?.message ?? error}).`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (code !== 0) {
				reject(new Error(`ocr: "${command}" exited with code ${code}. stderr: ${stderr.trim().slice(0, 400) || "(empty)"}`));
				return;
			}
			resolvePromise({ stdout, stderr, code: code ?? 0 });
		});
	});
}

/** Probe whether an executable answers `--version` at all. */
async function probeCommand(command) {
	try {
		const { stdout, stderr } = await runCommand(command, ["--version"], { timeoutMs: 10000 });
		const version = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] ?? "";
		return { available: true, version };
	} catch (error) {
		return { available: false, error: String(error?.message ?? error) };
	}
}

/* ------------------------------------------------------------------ files */

/** Classify an input path into "image", "pdf", or "unknown". */
function classify(path) {
	const ext = extname(path).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	if (PDF_EXTENSIONS.has(ext)) return "pdf";
	return "unknown";
}

/** Expand a `{input}`-style template into concrete arguments. */
function expandArgs(template, values) {
	return template.map((arg) => {
		let out = arg;
		for (const key of ARG_PLACEHOLDERS) {
			out = out.split(key).join(values[key.slice(1, -1)] ?? "");
		}
		return out;
	});
}

/* ----------------------------------------------------------------- engines */

/**
 * Pick the engine a call uses: the named one, else the flag-default, else the
 * first configured. A call that wants a backend but has no engines configured
 * gets an actionable error naming the config key.
 *
 * @param {Array<EngineConfig>} engines - configured engines.
 * @param {string|undefined} requested - the model's `engine` argument.
 * @returns {EngineConfig} the chosen engine.
 */
function resolveEngine(engines, requested) {
	if (engines.length === 0) {
		throw new Error('ocr: no OCR engine is configured. Add one under "engines" in the plugin config, e.g. { id: "tesseract", command: "tesseract", args: ["{input}", "{output}", "-l", "{lang}"] }.');
	}
	if (requested !== undefined && requested.length > 0) {
		const found = engines.find((engine) => engine.id === requested);
		if (found === undefined) {
			throw new Error(`ocr: unknown engine "${requested}". Configured engines: ${engines.map((engine) => engine.id).join(", ")}`);
		}
		return found;
	}
	return engines.find((engine) => engine.isDefault === true) ?? engines[0];
}

/**
 * OCR one image with the chosen engine, returning the text and stderr notes.
 *
 * @param {EngineConfig} engine - engine to run.
 * @param {string} imagePath - absolute path of the image.
 * @param {string} textOutPath - absolute path the engine writes text to.
 * @param {string} lang - language hint, possibly empty.
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - run options.
 * @returns {Promise<{text: string, engine: string}>} extracted text.
 */
async function ocrImage(engine, imagePath, textOutPath, lang, options) {
	const args = expandArgs(engine.args ?? ["{input}", "{output}"], {
		input: imagePath,
		output: textOutPath,
		lang
	});
	await runCommand(engine.command, args, {
		timeoutMs: Math.min(engine.timeoutMs ?? options.timeoutMs, options.timeoutMs),
		signal: options.signal
	});
	let text;
	try {
		text = await readFile(textOutPath, "utf8");
	} catch {
		// Some engines print text to stdout instead of writing a file; treat a
		// missing output file as "read stdout next time" rather than an error.
		text = "";
	}
	if (text.length === 0) {
		const rerun = await runCommand(engine.command, args, {
			timeoutMs: Math.min(engine.timeoutMs ?? options.timeoutMs, options.timeoutMs),
			signal: options.signal
		});
		text = rerun.stdout;
	}
	return { text, engine: engine.id };
}

/* ------------------------------------------------------------------- tools */

/** Model-facing text for a finished extraction. */
function formatRead(value) {
	const lines = [
		`OCR finished: ${value.kind} extracted via "${value.engine}" (${value.text.length} characters).`,
		`Source: ${value.source}`
	];
	if (value.pages !== undefined) lines.push(`Pages processed: ${value.pages}`);
	if (value.note !== undefined) lines.push(`Note: ${value.note}`);
	if (value.textPath !== undefined) lines.push(`Text saved to: ${value.textPath}`);
	if (value.text.trim().length === 0) {
		lines.push("", "No text was found. If this is a scan, configure an OCR engine under \"engines\"; the built-in backend only reads a PDF's own text layer.");
	} else {
		lines.push("", "--- extracted text ---", value.text);
	}
	return lines.join("\n");
}

/**
 * Register the enabled OCR tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const engines = config.engines ?? [];
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;

	/* -- ocr_status -------------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "ocr_status",
			description: "Report which OCR backends and engines are available on this machine, so you know whether a scan can be read before trying.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						backend: { type: "string", required: true },
						engines: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: { type: "string", required: true },
									label: { type: "string" },
									command: { type: "string" },
									available: { type: "boolean", required: true },
									version: { type: "string" },
									error: { type: "string" }
								}
							}
						}
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`OCR backend: ${value.backend}`,
						value.engines.length === 0
							? "No external OCR engine configured — only born-digital PDFs (those with a text layer) can be read."
							: "Configured engines:",
						...value.engines.map((engine) => engine.available
							? `- ${engine.id}${engine.label === undefined ? "" : ` (${engine.label})`}: AVAILABLE ${engine.version ?? ""}`
							: `- ${engine.id}${engine.label === undefined ? "" : ` (${engine.label})`}: MISSING — ${engine.error ?? "not found on PATH"}`)
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute(_args, exec) {
				const probed = await Promise.all(engines.map(async (engine) => {
					const base = {
						id: engine.id,
						...engine.label === undefined ? {} : { label: engine.label },
						...engine.command === undefined ? {} : { command: engine.command }
					};
					if (engine.command === undefined) return { ...base, available: false, error: "no command configured" };
					const result = await probeCommand(engine.command);
					return result.available
						? { ...base, available: true, ...result.version.length === 0 ? {} : { version: result.version } }
						: { ...base, available: false, error: result.error };
				}));
				return { backend: config.backend, engines: probed };
			},
			presentCall: () => ({ card: "generic", title: "OCR backend status", kind: "other", rawInput: {} })
		}));
	}

	/* -- ocr_read ---------------------------------------------------------- */
	if (config.read) {
		ctx.tools.register(defineTool({
			name: "ocr_read",
			description: "Extract text from an image or PDF. For a born-digital PDF the text layer is read directly; for a scan or photo an OCR engine is used when one is configured.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the image or PDF to read." },
				engine: { type: "string", description: "OCR engine id. Omit to use the configured default." },
				lang: { type: "string", description: "Language hint passed to the engine, e.g. \"chi_sim+eng\"." },
				pages: { type: "string", description: "Page range for a PDF, e.g. \"1-3\" or \"2,5\". Omit for all pages." },
				saveAs: { type: "string", description: "Filename to write the extracted text to under the output directory." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { type: "string", required: true },
						kind: { type: "string", required: true },
						engine: { type: "string", required: true },
						text: { type: "string", required: true },
						pages: { type: "integer" },
						textPath: { type: "string" },
						note: { type: "string" }
					}
				},
				render: (_args, value) => [{ type: "text", text: formatRead(value) }]
			},
			timeoutMs: budgetMs,
			async execute(args, exec) {
				const source = resolve(args.path);
				let info;
				try {
					info = await stat(source);
				} catch {
					throw new Error(`ocr: no file at "${source}". Pass an absolute path.`);
				}
				if (!info.isFile()) throw new Error(`ocr: "${source}" is not a file.`);

				const kind = classify(source);
				const maxPages = config.maxPages;
				const notes = [];
				let text = "";
				let engineId = "native";
				let pages;

				if (kind === "pdf") {
					const range = parsePageRange(args.pages, maxPages, notes);
					pages = range === undefined ? undefined : range.count;
					const extracted = await extractPdfText(source, range, {
						signal: exec.signal,
						timeoutMs: budgetMs
					});
					text = extracted.text;
					if (extracted.note !== undefined) notes.push(extracted.note);
					// A PDF whose text layer is empty is a scan: fall through to OCR.
					if (text.trim().length === 0 && engines.length > 0) {
						const engine = resolveEngine(engines, args.engine);
						const out = join(outputDir, `${basename(source, extname(source))}.${engine.id}.txt`);
						await mkdir(outputDir, { recursive: true });
						const raster = await rasterizePdf(source, range, outputDir, { signal: exec.signal, timeoutMs: budgetMs });
						notes.push(`no text layer found — rasterized ${raster.images.length} page(s) and ran OCR`);
						const chunks = [];
						for (const imagePath of raster.images) {
							const perPage = join(outputDir, `${basename(imagePath, extname(imagePath))}.${engine.id}.txt`);
							const result = await ocrImage(engine, imagePath, perPage, args.lang ?? "", {
								timeoutMs: budgetMs,
								signal: exec.signal
							});
							chunks.push(result.text);
						}
						text = chunks.join("\n\n");
						engineId = engine.id;
						void out;
					} else if (text.trim().length === 0 && engines.length === 0) {
						notes.push('this PDF has no text layer and no OCR engine is configured — add one under "engines"');
					}
				} else if (kind === "image") {
					const engine = resolveEngine(engines, args.engine);
					await mkdir(outputDir, { recursive: true });
					const outPath = join(outputDir, `${basename(source, extname(source))}.${engine.id}.txt`);
					const result = await ocrImage(engine, source, outPath, args.lang ?? "", {
						timeoutMs: budgetMs,
						signal: exec.signal
					});
					text = result.text;
					engineId = engine.id;
				} else {
					throw new Error(`ocr: unsupported file type "${extname(source)}". Supported: ${[...IMAGE_EXTENSIONS, ...PDF_EXTENSIONS].join(", ")}.`);
				}

				let textPath;
				if (args.saveAs !== undefined && args.saveAs.length > 0) {
					await mkdir(outputDir, { recursive: true });
					textPath = join(outputDir, args.saveAs);
					await writeFile(textPath, text, "utf8");
				}
				return {
					source,
					kind,
					engine: engineId,
					text,
					...pages === undefined ? {} : { pages },
					...textPath === undefined ? {} : { textPath },
					...notes.length === 0 ? {} : { note: notes.join("; ") }
				};
			},
			presentCall: (args) => ({ card: "generic", title: `OCR: ${basename(args.path ?? "file")}`, kind: "other", rawInput: args })
		}));
	}
}

/* ------------------------------------------------------------------ pdf ops */

/**
 * Parse a human page range like "1-3", "2,5" into a zero-based index set.
 * Omitted range means every page. A range wider than `maxPages` is clamped.
 *
 * @param {string|undefined} spec - the model's `pages` argument.
 * @param {number} maxPages - configured ceiling.
 * @param {string[]} notes - mutable note sink.
 * @returns {{indices: number[], count: number}|undefined} the resolved range.
 */
function parsePageRange(spec, maxPages, notes) {
	if (spec === undefined || spec.trim().length === 0) return undefined;
	const indices = new Set();
	for (const part of spec.split(",")) {
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const match = /^(\d+)\s*-\s*(\d+)$/u.exec(trimmed);
		if (match !== null) {
			const from = Number(match[1]);
			const to = Number(match[2]);
			for (let page = Math.min(from, to); page <= Math.max(from, to); page += 1) indices.add(page - 1);
			continue;
		}
		if (/^\d+$/u.test(trimmed)) indices.add(Number(trimmed) - 1);
	}
	if (indices.size === 0) return undefined;
	const sorted = [...indices].filter((index) => index >= 0).sort((a, b) => a - b);
	if (sorted.length > maxPages) {
		notes.push(`page range clamped to the first ${maxPages} page(s)`);
		return { indices: sorted.slice(0, maxPages), count: maxPages };
	}
	return { indices: sorted, count: sorted.length };
}

/**
 * Read a PDF's own text layer without a third-party library: the plugin shells
 * out to `pdftotext` when present (the reliable path), and otherwise reports
 * that no text layer could be read. Keeping this behind a command check means a
 * machine without poppler still loads the plugin.
 *
 * @param {string} source - absolute PDF path.
 * @param {{indices: number[], count: number}|undefined} range - page selection.
 * @param {{signal?: AbortSignal, timeoutMs: number}} options - run options.
 * @returns {Promise<{text: string, note?: string}>} extracted text.
 */
async function extractPdfText(source, range, options) {
	const probe = await probeCommand("pdftotext");
	if (!probe.available) {
		return { text: "", note: "pdftotext (poppler) is not installed — install it or configure an OCR engine to read scans" };
	}
	const args = ["-layout"];
	if (range !== undefined) {
		args.push("-f", String(range.indices[0] + 1), "-l", String(range.indices[range.indices.length - 1] + 1));
	}
	args.push(source, "-");
	const { stdout } = await runCommand("pdftotext", args, { timeoutMs: options.timeoutMs, signal: options.signal });
	return { text: stdout };
}

/**
 * Rasterize selected PDF pages to PNGs so an OCR engine can read them. Uses
 * `pdftoppm` (poppler) when present; otherwise reports the missing dependency
 * in a message that names the alternative.
 *
 * @param {string} source - absolute PDF path.
 * @param {{indices: number[], count: number}|undefined} range - page selection.
 * @param {string} outDir - directory to write rasters into.
 * @param {{signal?: AbortSignal, timeoutMs: number}} options - run options.
 * @returns {Promise<{images: string[]}>} written raster paths in page order.
 */
async function rasterizePdf(source, range, outDir, options) {
	const probe = await probeCommand("pdftoppm");
	if (!probe.available) {
		throw new Error("ocr: this PDF has no text layer and pdftoppm (poppler) is not installed, so its pages cannot be rasterized for OCR. Install poppler-utils, or export the pages as images first.");
	}
	await mkdir(outDir, { recursive: true });
	const stem = basename(source, extname(source));
	const prefix = join(outDir, `${stem}.page`);
	const args = ["-r", "200", "-png"];
	if (range !== undefined) {
		args.push("-f", String(range.indices[0] + 1), "-l", String(range.indices[range.indices.length - 1] + 1));
	}
	args.push(source, prefix);
	await runCommand("pdftoppm", args, { timeoutMs: options.timeoutMs, signal: options.signal });
	const { readdir } = await import("node:fs/promises");
	const entries = await readdir(outDir);
	return {
		images: entries
			.filter((entry) => entry.startsWith(`${stem}.page`) && entry.toLowerCase().endsWith(".png"))
			.sort()
			.map((entry) => join(outDir, entry))
	};
}

export { Config, apply, inject, name };