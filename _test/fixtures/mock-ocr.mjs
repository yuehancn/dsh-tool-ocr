// Mimics a real OCR engine's CLI contract: takes the input image path and the
// output text path, writes recognized text to the output file.
import { writeFile } from "node:fs/promises";
const [input, output] = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (!input || !output) { process.stderr.write("usage: mock-ocr <input> <output>\n"); process.exit(2); }
// Emit text keyed off the input filename so the test can assert provenance.
const stem = input.replace(/\\/gu, "/").split("/").pop();
await writeFile(output, `MOCK-OCR-RESULT for ${stem}\n发票号码 12345678\n金额 ¥1,234.00\n`, "utf8");
