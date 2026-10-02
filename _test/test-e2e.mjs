// End-to-end test: drive ocr_read through a REAL subprocess engine.
// The mock engine stands in for tesseract and honors the same {input}/{output}
// contract, so this exercises spawn, arg templating, output reading, and the
// structured result — everything except the recognition model itself.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { apply } from "../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const engineScript = resolve(here, "fixtures/mock-ocr.mjs");
const fixtureImage = resolve(here, "fixtures/receipt.png");
const outDir = resolve(here, "fixtures/e2e-out");

let pass = 0;
let fail = 0;
function t(label, cond, extra = "") {
	console.log(cond ? "  PASS" : "  FAIL", label, cond ? "" : extra);
	if (cond) pass += 1; else fail += 1;
}

await rm(outDir, { recursive: true, force: true });

const registered = new Map();
const ctx = { tools: { register: (tool) => registered.set(tool.name, tool) } };

apply(ctx, {
	// The mock engine is invoked as: node mock-ocr.mjs {input} {output}
	engines: [{
		id: "mock",
		label: "Mock OCR",
		command: node,
		args: [engineScript, "{input}", "{output}"],
		isDefault: true
	}],
	backend: "command",
	outputDir: outDir,
	timeoutMs: 30000,
	read: true,
	status: true,
	maxPages: 50
});

const read = registered.get("ocr_read");
const status = registered.get("ocr_status");
const exec = { signal: undefined };

console.log("e2e: ocr_read on an image through a real subprocess");
let result;
try {
	result = await read.execute({ path: fixtureImage }, exec);
	t("execute resolved", true);
} catch (error) {
	t("execute resolved", false, String(error?.stack ?? error));
}

if (result !== undefined) {
	t("kind is image", result.kind === "image", `got=${result.kind}`);
	t("engine is mock", result.engine === "mock", `got=${result.engine}`);
	t("text is non-empty", result.text.trim().length > 0);
	t("text carries engine output", result.text.includes("MOCK-OCR-RESULT"), `got=${result.text.slice(0, 80)}`);
	t("text carries the CJK line", result.text.includes("发票号码 12345678"), `got=${result.text.slice(0, 120)}`);
	t("source is the fixture path", result.source === fixtureImage, `got=${result.source}`);
	t("render produces text", Array.isArray(read.output.render({}, result)) && read.output.render({}, result)[0].text.length > 0);
}

console.log("e2e: saveAs writes the text file");
let saved;
try {
	saved = await read.execute({ path: fixtureImage, saveAs: "receipt-ocr.txt" }, exec);
	t("saveAs run resolved", true);
} catch (error) {
	t("saveAs run resolved", false, String(error?.message ?? error));
}
if (saved?.textPath !== undefined) {
	const written = await readFile(saved.textPath, "utf8");
	t("textPath file exists", written.length > 0);
	t("file content matches result", written.includes("MOCK-OCR-RESULT"));
}

console.log("e2e: engine selection and lang templating");
// Point a second engine at the mock with a lang flag, and select it by name.
const reg2 = new Map();
apply({ tools: { register: (tool) => reg2.set(tool.name, tool) } }, {
	engines: [
		{ id: "first", command: node, args: [engineScript, "{input}", "{output}"] },
		{ id: "second", command: node, args: [engineScript, "{input}", "{output}", "-l", "{lang}"] }
	],
	backend: "command",
	outputDir: outDir,
	timeoutMs: 30000,
	read: true,
	status: true,
	maxPages: 50
});
const read2 = reg2.get("ocr_read");
const picked = await read2.execute({ path: fixtureImage, engine: "second", lang: "chi_sim+eng" }, exec);
t("named engine is used", picked.engine === "second", `got=${picked.engine}`);
const defaulted = await read2.execute({ path: fixtureImage }, exec);
t("un-named call takes first engine", defaulted.engine === "first", `got=${defaulted.engine}`);

console.log("e2e: unknown engine is rejected before spawning");
let engineError;
try {
	await read2.execute({ path: fixtureImage, engine: "nope" }, exec);
} catch (error) {
	engineError = error;
}
t("unknown engine throws", engineError !== undefined);
t("message names the configured engines", /first, second/u.test(engineError?.message ?? ""), `got=${engineError?.message}`);

console.log("e2e: no engines configured falls back to a clear error");
const reg3 = new Map();
apply({ tools: { register: (tool) => reg3.set(tool.name, tool) } }, {
	engines: [],
	backend: "native",
	outputDir: outDir,
	timeoutMs: 30000,
	read: true,
	status: true,
	maxPages: 50
});
let noEngineError;
try {
	await reg3.get("ocr_read").execute({ path: fixtureImage }, exec);
} catch (error) {
	noEngineError = error;
}
t("no-engine throws", noEngineError !== undefined);
t("message explains how to configure one", /no OCR engine is configured/u.test(noEngineError?.message ?? "") && /"engines"/u.test(noEngineError?.message ?? ""), `got=${noEngineError?.message}`);

console.log("e2e: engine failure surfaces stderr");
const reg4 = new Map();
apply({ tools: { register: (tool) => reg4.set(tool.name, tool) } }, {
	engines: [{ id: "broken", command: node, args: ["-e", "process.stderr.write('boom: missing model\\n'); process.exit(3)"], isDefault: true }],
	backend: "command",
	outputDir: outDir,
	timeoutMs: 30000,
	read: true,
	status: true,
	maxPages: 50
});
let brokenError;
try {
	await reg4.get("ocr_read").execute({ path: fixtureImage }, exec);
} catch (error) {
	brokenError = error;
}
t("failing engine throws", brokenError !== undefined);
t("message carries the exit code", /exited with code 3/u.test(brokenError?.message ?? ""), `got=${brokenError?.message}`);
t("message carries stderr", /missing model/u.test(brokenError?.message ?? ""), `got=${brokenError?.message}`);

console.log("e2e: ocr_status probes the engine");
const statusResult = await status.execute({}, exec);
t("status returns backend", statusResult.backend === "command", `got=${statusResult.backend}`);
t("status probed the mock engine", Array.isArray(statusResult.engines) && statusResult.engines.length === 1);
t("status reports availability", typeof statusResult.engines[0]?.available === "boolean");

await rm(outDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);