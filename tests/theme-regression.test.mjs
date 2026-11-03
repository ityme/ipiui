import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
// Use installed development peers when available, otherwise the supported Pi host.
let hostRoot = process.env.PI_TEST_HOST_ROOT;
if (!hostRoot) {
	try {
		hostRoot = path.resolve(path.dirname(require.resolve("@earendil-works/pi-coding-agent")), "../../..");
	} catch {
		hostRoot = path.join(homedir(), ".pi/agent/install/releases/1.5.0/node_modules");
	}
}
assert.ok(existsSync(hostRoot), "Set PI_TEST_HOST_ROOT to Pi 1.5.0's node_modules directory");
const hostRequire = createRequire(path.join(hostRoot, "__ipiui_tests.cjs"));
const { createJiti } = hostRequire("jiti");
const jiti = createJiti(path.join(projectRoot, "index.ts"), {
	alias: {
		"@earendil-works/pi-tui": path.join(hostRoot, "@earendil-works/pi-tui/dist/index.js"),
	},
});
const { default: extension, TopStatusBarComponent } = jiti(path.join(projectRoot, "index.ts"));
const { getThemeByName } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")));
const { visibleWidth, stripTerminalSequences } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-tui/dist/index.js")));
const context = {
	getContextUsage: () => ({ tokens: 24500, contextWindow: 128000, percent: 19.140625 }),
};

for (const themeName of ["dark", "light", "system"]) {
	const theme = getThemeByName(themeName);
	assert.ok(theme, `Missing built-in theme: ${themeName}`);
	for (const [status, label] of [
		["idle", "READY"], ["running", "RUNNING"], ["error", "ERROR"], ["aborted", "STOPPED"],
	]) {
		test(`${themeName}: ${status} renders with real theme tokens at narrow and wide widths`, () => {
			const component = new TopStatusBarComponent({
				status, visible: true, startTime: Date.now() - 5000,
				modelId: "gemini-3.8-flash", provider: "magpie/relaycore-gemini",
				thinkingLevel: "high", activeTool: "bash", errorMessage: "Rate limit exceeded 429",
			}, theme, context);
			for (const width of [1, 8, 40, 100, 200]) {
				const lines = component.render(width);
				assert.equal(lines.length, 1);
				assert.ok(visibleWidth(lines[0]) <= width);
				if (width >= 100) assert.ok(stripTerminalSequences(lines[0]).includes(label));
			}
		});
	}
}

test("real theme renders context usage including zero and unknown counts", () => {
	for (const tokens of [0, 24500, null]) {
		const component = new TopStatusBarComponent({ status: "idle", visible: true },
			getThemeByName("dark"), {
				getContextUsage: () => ({ tokens, contextWindow: 128000, percent: tokens === null ? null : tokens / 1280 }),
			});
		const line = stripTerminalSequences(component.render(200)[0]);
		if (tokens === null) assert.ok(!line.includes("k/128k"));
		else assert.ok(line.includes(`${(tokens / 1000).toFixed(1)}k/128k`));
	}
});

test("Pi events render READY → RUNNING → ERROR → RUNNING → STOPPED", async () => {
	const handlers = new Map();
	const commands = new Map();
	let widget;
	const ctx = {
		...context, mode: "tui", model: { id: "test-model", provider: "test-provider" },
		thinkingLevel: "high",
		ui: {
			notify() {},
			setWidget(_key, factory) {
				widget = factory({}, getThemeByName("dark"));
				// Pi renders asynchronously; eager rendering also catches invalid theme tokens here.
				widget.render(200);
			},
		},
	};
	extension({ on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command) });
	const emit = async (name, event = {}) => handlers.get(name)(event, ctx);
	const line = () => stripTerminalSequences(widget.render(200)[0]);
	try {
		await emit("session_start");
		assert.ok(line().includes("READY"));
		await emit("agent_start");
		assert.ok(line().includes("RUNNING"));
		await emit("tool_execution_start", { toolName: "bash" });
		assert.ok(line().includes("bash"));
		await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429" } });
		await emit("agent_settled", { aborted: false });
		assert.ok(line().includes("ERROR"));
		await emit("agent_start");
		assert.ok(line().includes("RUNNING"));
		await emit("agent_settled", { aborted: true });
		assert.ok(line().includes("STOPPED"));
		await commands.get("topbar").handler("off", ctx);
		assert.deepEqual(widget.render(200), []);
		await commands.get("topbar").handler("on", ctx);
		assert.ok(line().includes("STOPPED"));
	} finally {
		await emit("session_shutdown");
	}
});
