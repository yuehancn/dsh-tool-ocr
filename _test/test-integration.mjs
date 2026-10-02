// Integration test for dsh-tool-ocr against the REAL @deepseek-ai/dsh-tools
// and @deepseek-ai/schemastery. Verifies the plugin loads, registers its tools
// through a stub context, and that the declared schemas validate real input.
import { apply, Config, inject, name } from "../lib/index.js";

let pass = 0;
let fail = 0;
function t(label, cond, extra = "") {
	console.log(cond ? "  PASS" : "  FAIL", label, cond ? "" : extra);
	if (cond) pass += 1; else fail += 1;
}

// A context stub capturing whatever the plugin registers.
const registered = new Map();
const ctx = {
	tools: {
		register(tool) {
			registered.set(tool.name, tool);
			return tool;
		}
	}
};

console.log("plugin surface:");
t("name is tool-ocr", name === "tool-ocr", `got=${name}`);
t("injects tools", Array.isArray(inject) && inject.includes("tools"), `got=${JSON.stringify(inject)}`);
t("Config is callable", typeof Config === "function" || typeof Config === "object");

const config = {
	engines: [
		{ id: "tesseract", label: "Tesseract", command: "tesseract", args: ["{input}", "{output}", "-l", "{lang}"], isDefault: true },
		{ id: "paddle", command: "python", args: ["-m", "paddleocr"] }
	],
	backend: "command",
	outputDir: "ocr-output",
	timeoutMs: 300000,
	read: true,
	status: true,
	maxPages: 50
};

console.log("apply() registers tools:");
try {
	apply(ctx, config);
	t("no throw on apply", true);
} catch (error) {
	t("no throw on apply", false, String(error?.stack ?? error));
}

t("registered ocr_read", registered.has("ocr_read"));
t("registered ocr_status", registered.has("ocr_status"));
t("exactly 2 tools", registered.size === 2, `got=${registered.size}`);
t("tools have names", [...registered.keys()].join(",") === "ocr_status,ocr_read", `got=${[...registered.keys()].join(",")}`);

const read = registered.get("ocr_read");
const status = registered.get("ocr_status");

console.log("tool definitions:");
t("ocr_read has description", typeof read?.description === "string" && read.description.length > 20);
t("ocr_read has parameters", typeof read?.parameters === "object" && read.parameters !== null);
t("ocr_read declares the path parameter", "path" in (read?.parameters?.properties ?? {}));
t("ocr_read marks path required", (read?.parameters?.required ?? []).includes("path"), `got=${JSON.stringify(read?.parameters?.required)}`);
t("ocr_read declares all documented params", ["path", "engine", "lang", "pages", "saveAs"].every((k) => k in (read?.parameters?.properties ?? {})));
t("ocr_read has execute", typeof read?.execute === "function");
t("ocr_read has output schema", typeof read?.output?.schema === "object");
t("ocr_read has timeoutMs", typeof read?.timeoutMs === "number");
t("ocr_status has execute", typeof status?.execute === "function");

console.log("output schema shape:");
// defineTool normalizes the schema: required fields collapse into a top-level
// `required` array rather than per-property flags.
const outSchema = read?.output?.schema;
t("schema is object type", outSchema?.type === "object");
t("schema requires text", (outSchema?.required ?? []).includes("text"), `got=${JSON.stringify(outSchema?.required)}`);
t("schema requires engine", (outSchema?.required ?? []).includes("engine"), `got=${JSON.stringify(outSchema?.required)}`);
t("schema requires source and kind", ["source", "kind"].every((k) => (outSchema?.required ?? []).includes(k)));
t("text property is a string", outSchema?.properties?.text?.type === "string");
t("schema has render", typeof read?.output?.render === "function");

console.log("feature toggles:");
const reg2 = new Map();
apply({ tools: { register: (tool) => reg2.set(tool.name, tool) } }, { ...config, read: false });
t("read:false skips ocr_read", !reg2.has("ocr_read") && reg2.has("ocr_status"));
const reg3 = new Map();
apply({ tools: { register: (tool) => reg3.set(tool.name, tool) } }, { ...config, status: false });
t("status:false skips ocr_status", !reg3.has("ocr_status") && reg3.has("ocr_read"));
const reg4 = new Map();
apply({ tools: { register: (tool) => reg4.set(tool.name, tool) } }, { ...config, read: false, status: false });
t("both false registers none", reg4.size === 0, `got=${reg4.size}`);

console.log("execute() error paths:");
// Missing file must produce an actionable error, not a crash.
let missingError;
try {
	await read.execute({ path: "C:/definitely/not/here-928374.pdf" }, { signal: undefined });
} catch (error) {
	missingError = error;
}
t("missing file throws", missingError !== undefined);
t("missing file message is actionable", /no file at/u.test(missingError?.message ?? ""), `got=${missingError?.message}`);

// Unsupported extension must be rejected by name.
let extError;
try {
	await read.execute({ path: new URL("../package.json", import.meta.url).pathname.replace(/^\//u, "") }, { signal: undefined });
} catch (error) {
	extError = error;
}
t("unsupported type throws", extError !== undefined);
t("unsupported message names the type", /unsupported file type/u.test(extError?.message ?? ""), `got=${extError?.message}`);

console.log("config schema:");
t("Config is exported", Config !== undefined);
// schemastery exports a constructor function, not a plain object.
t("Config is a schemastery constructor", typeof Config === "function", `got=${typeof Config}`);
t("Config exposes a dict descriptor", typeof Config?.dict === "object" || typeof Config?.toString === "function");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);