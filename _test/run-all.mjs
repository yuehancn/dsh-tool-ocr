// Test runner: executes every suite against the real dsh modules.
// node_modules/ must hold @deepseek-ai/{dsh-tools,schemastery,cordis,...} —
// see the README's "Running the tests" section for how to seed it.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const suites = ["test-logic.mjs", "test-integration.mjs", "test-e2e.mjs"];

let failed = 0;
for (const suite of suites) {
	console.log(`\n=== ${suite} ===`);
	const code = await new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(here, suite)], { stdio: "inherit" });
		child.on("close", resolvePromise);
	});
	if (code !== 0) failed += 1;
}

console.log(failed === 0 ? "\nAll suites passed." : `\n${failed} suite(s) failed.`);
process.exit(failed === 0 ? 0 : 1);