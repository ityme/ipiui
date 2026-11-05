import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
let hostRoot = process.env.PI_TEST_HOST_ROOT;
if (!hostRoot) {
	try {
		hostRoot = path.resolve(path.dirname(require.resolve("@earendil-works/pi-coding-agent")), "../../..");
	} catch {
		hostRoot = path.join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
	}
}
const hostPackage = path.join(hostRoot, "@earendil-works/pi-coding-agent");
// Keep all generated files inside the workspace, away from personal Pi settings.
const workRoot = path.join(projectRoot, "test");
await mkdir(workRoot, { recursive: true });
const temporary = await mkdtemp(path.join(workRoot, "package-check-"));
const env = {
	...process.env,
	PI_CODING_AGENT_DIR: path.join(temporary, "agent"),
	PI_CODING_AGENT_SESSION_DIR: path.join(temporary, "sessions"),
	PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
};

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { cwd: temporary, env, encoding: "utf8", timeout: 60_000, ...options });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

try {
	assert.ok(process.env.npm_execpath, "Run this check using npm run check:package");
	const metadata = JSON.parse(run(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
		cwd: projectRoot,
	}))[0];
	const paths = metadata.files.map(file => file.path);
	for (const required of ["package.json", "index.ts", "src/index.ts", "src/tab-title.ts", "README.md", "LICENSE", "CHANGELOG.md"]) {
		assert.ok(paths.includes(required), `Release archive is missing ${required}`);
	}
	assert.ok(!paths.some(file => /^(?:test|tests|scripts|node_modules|\.agent|\.git)\//.test(file)), "Release includes development or local files");
	run("tar", ["-xzf", path.join(temporary, metadata.filename), "-C", temporary]);
	const packedRoot = path.join(temporary, "package");
	const manifest = JSON.parse(await readFile(path.join(packedRoot, "package.json"), "utf8"));
	assert.equal(manifest.license, "GPL-3.0-only");
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);

	const cli = path.join(hostPackage, "dist/cli.js");
	run(process.execPath, [cli, "install", packedRoot]);
	const settings = JSON.parse(await readFile(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
	assert.ok(settings.packages.some(source => typeof source === "string" && path.resolve(env.PI_CODING_AGENT_DIR, source) === packedRoot), "pi install did not save the local package");
	run(process.execPath, [cli, "list"]);

	const { SettingsManager } = await import(pathToFileURL(path.join(hostPackage, "dist/core/settings-manager.js")));
	const { DefaultPackageManager } = await import(pathToFileURL(path.join(hostPackage, "dist/core/package-manager.js")));
	const { loadExtensions } = await import(pathToFileURL(path.join(hostPackage, "dist/core/extensions/loader.js")));
	const manager = new DefaultPackageManager({ cwd: temporary, agentDir: env.PI_CODING_AGENT_DIR,
		settingsManager: SettingsManager.create(temporary, env.PI_CODING_AGENT_DIR) });
	const resources = await manager.resolve();
	const extensionPaths = resources.extensions.filter(resource => resource.enabled).map(resource => resource.path);
	assert.deepEqual(extensionPaths, [path.join(packedRoot, "index.ts")]);
	const loaded = await loadExtensions(extensionPaths, temporary);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	assert.ok(loaded.extensions[0].commands.has("ipiui"), "Packaged extension did not register /ipiui");
	run(process.execPath, [cli, "remove", packedRoot]);
	const removed = JSON.parse(await readFile(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), "utf8"));
	assert.ok(!removed.packages?.length, "pi remove did not remove the package declaration");
	console.log(`Package verified: ${metadata.filename}, ${paths.length} files, ${metadata.size} bytes.`);
	console.log("Pi install/list/discovery/load/remove passed using an isolated configuration directory.");
} finally {
	await rm(temporary, { recursive: true, force: true });
}
