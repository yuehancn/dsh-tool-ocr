// Runtime test for dsh-tool-ocr pure logic, using the real schemastery module.
// The plugin's Config schema is built at load time, so a faithful stub is not
// enough — we import the genuine module from the profile's dependency set.
import { readFile } from "node:fs/promises";
import { extname, basename, resolve, join } from "node:path";

const src = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
// Drop the imports (they resolve in the plugin's own node_modules) and rebuild
// the module with real schemastery + a passthrough defineTool, so Config
// constructs for real and the helpers come back out.
const body = src
	.replace(/^import .*$/gm, "")
	.replace(/^export \{.*\};$/m, "");
const z = (await import("@deepseek-ai/schemastery")).default;
const defineTool = (def) => def;
const factory = new Function(
	"z",
	"defineTool",
	"extname",
	"basename",
	"resolve",
	"join",
	`${body}\nreturn { parsePageRange, classify, expandArgs, resolveEngine, Config };`
);
const { parsePageRange, classify, expandArgs, resolveEngine, Config } =
	factory(z, defineTool, extname, basename, resolve, join);

let pass = 0;
let fail = 0;
function t(label, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	console.log(ok ? "  PASS" : "  FAIL", label, ok ? "" : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
	if (ok) pass += 1; else fail += 1;
}

console.log("classify:");
t("png upper", classify("/a/b.PNG"), "image");
t("pdf", classify("/a/b.pdf"), "pdf");
t("txt", classify("/a/b.txt"), "unknown");
t("tiff", classify("x.tif"), "image");

console.log("expandArgs:");
t("placeholders", expandArgs(["{input}", "{output}", "-l", "{lang}"], { input: "/i.png", output: "/o.txt", lang: "chi_sim" }),
	["/i.png", "/o.txt", "-l", "chi_sim"]);
t("empty lang", expandArgs(["-l", "{lang}"], { lang: "" }), ["-l", ""]);
t("no placeholders", expandArgs(["run", "--x"], {}), ["run", "--x"]);

console.log("parsePageRange:");
const notes = [];
t("undefined", parsePageRange(undefined, 50, notes), undefined);
t("blank", parsePageRange("  ", 50, notes), undefined);
t("single", parsePageRange("3", 50, notes), { indices: [2], count: 1 });
t("range", parsePageRange("1-3", 50, notes), { indices: [0, 1, 2], count: 3 });
t("combo", parsePageRange("2,5", 50, notes), { indices: [1, 4], count: 2 });
t("reversed", parsePageRange("5-3", 50, notes), { indices: [2, 3, 4], count: 3 });
const clampNotes = [];
t("clamp count", parsePageRange("1-100", 3, clampNotes).count, 3);
t("clamp notes", clampNotes.length > 0, true);

console.log("resolveEngine:");
const engines = [{ id: "a" }, { id: "c", isDefault: true }, { id: "b" }];
t("default", resolveEngine(engines, undefined).id, "c");
t("named", resolveEngine(engines, "b").id, "b");
t("no default -> first", resolveEngine([{ id: "x" }, { id: "y" }], undefined).id, "x");
try {
	resolveEngine(engines, "zz");
	t("unknown throws", false, true);
} catch (error) {
	t("unknown throws", /unknown engine/u.test(error.message), true);
}
try {
	resolveEngine([], undefined);
	t("empty throws", false, true);
} catch (error) {
	t("empty throws", /no OCR engine/u.test(error.message), true);
}

console.log("Config schema (real schemastery):");
t("Config builds", typeof Config === "function", true);
const parsed = new Config({
	engines: [{ id: "t", command: "tesseract", args: ["{input}", "{output}"] }]
});
t("defaults backend to native", parsed.backend, "native");
t("defaults outputDir", parsed.outputDir, "ocr-output");
t("defaults maxPages", parsed.maxPages, 50);
t("defaults read true", parsed.read, true);
t("defaults status true", parsed.status, true);
t("defaults keepIntermediate false", parsed.keepIntermediate, false);
t("accepts engines array", parsed.engines.length, 1);
t("engine id preserved", parsed.engines[0].id, "t");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);