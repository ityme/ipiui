import path from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
let hostRoot = process.env.PI_TEST_HOST_ROOT;
if (!hostRoot) {
	try {
		hostRoot = path.resolve(path.dirname(require.resolve("@earendil-works/pi-coding-agent")), "../../..");
	} catch {
		hostRoot = path.join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
	}
}
const config = ts.readConfigFile(path.join(cwd, "tsconfig.json"), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, cwd);
const options = {
	...parsed.options, noEmit: true, allowImportingTsExtensions: true, baseUrl: cwd,
	paths: Object.fromEntries(["pi-coding-agent", "pi-tui"].map(name => [
		`@earendil-works/${name}`, [path.join(hostRoot, `@earendil-works/${name}/dist/index.d.ts`)],
	])),
	typeRoots: [path.join(hostRoot, "@types")],
};
const program = ts.createProgram([...parsed.fileNames, path.join(cwd, "index.ts")], options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
console.log(diagnostics.length ? ts.formatDiagnosticsWithColorAndContext(diagnostics, {
	getCanonicalFileName: file => file, getCurrentDirectory: () => cwd, getNewLine: () => "\n",
}) : "Typecheck passed (Pi host declarations).");
process.exitCode = diagnostics.length ? 1 : 0;
