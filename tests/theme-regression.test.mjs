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
const { getThemeByName, loadThemeFromPath } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")));
const { visibleWidth, stripTerminalSequences, colorToRgb, indexedColor, TuiMainScreen, TuiAltScreen, Text } = await import(pathToFileURL(path.join(hostRoot,
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

function luminance({ r, g, b }) {
	const linear = [r, g, b].map(value => {
		const channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

for (const mode of ["truecolor", "256color"]) {
	test(`rainbow ${mode}: full-width background, readable contrast, intact CJK and emoji`, () => {
		const theme = loadThemeFromPath(path.join(hostRoot,
			"@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json"), mode);
		const component = new TopStatusBarComponent({
			status: "idle", visible: true, modelId: "中文👨‍👩‍👧‍👦e\u0301", thinkingLevel: "high",
		}, theme, context);
		for (const width of [1, 8, 40, 100, 200]) {
			const line = component.render(width)[0];
			assert.equal(visibleWidth(line), width);
			if (width >= 40) assert.ok(stripTerminalSequences(line).includes("中文👨‍👩‍👧‍👦e\u0301"));
			const colors = [...line.matchAll(/\u001b\[(38|48);(2;\d+;\d+;\d+|5;\d+)m/g)];
			let foreground;
			let background;
			const backgrounds = new Set();
			for (const match of colors) {
				const parts = match[2].split(";").map(Number);
				const color = parts[0] === 2 ? { r: parts[1], g: parts[2], b: parts[3] }
					: colorToRgb(indexedColor(parts[1]));
				if (match[1] === "38") foreground = color;
				else {
					background = color;
					backgrounds.add(match[2]);
				}
				if (foreground && background) {
					const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
					assert.ok((levels[1] + 0.05) / (levels[0] + 0.05) >= 4.5);
				}
			}
			assert.ok(backgrounds.size >= Math.min(width, 6));
			assert.ok(colors.length > 0, "Gradient must emit concrete foreground/background ANSI colors");
		}
	});
}

class TestTerminal {
	columns = 200;
	rows = 24;
	kittyProtocolActive = false;
	output = "";
	start(onInput, onResize) { this.input = onInput; this.resize = onResize; }
	stop() {}
	write(data) { this.output += data; }
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
}

for (const Renderer of [TuiMainScreen, TuiAltScreen]) {
	test(`${Renderer.name}: top overlay stays at viewport row zero, preserves focus and cleans up`, async () => {
		const terminal = new TestTerminal();
		const tui = new Renderer(terminal);
		const handlers = new Map();
		const commands = new Map();
		let widget;
		let overlay;
		let overlayHandle;
		let typed = "";
		const editor = {
			render: () => ["> " + typed], invalidate() {},
			handleInput: (data) => { typed += data; },
		};
		const chat = { lines: ["short chat"], render() { return this.lines; }, invalidate() {} };
		tui.addChild(chat);
		tui.addChild(editor);
		tui.setFocus(editor);
		const showOverlay = tui.showOverlay.bind(tui);
		tui.showOverlay = (component, options) => {
			overlay = component;
			assert.equal(options.row, 0);
			assert.equal(options.width, "100%");
			assert.equal(options.nonCapturing, true);
			overlayHandle = showOverlay(component, options);
			return overlayHandle;
		};
		const ctx = {
			...context, mode: "tui", model: { id: "test-model", provider: "test-provider" },
			thinkingLevel: "high",
			ui: {
				notify() {},
				setWidget(_key, factory) {
					widget?.dispose?.();
					widget = factory(tui, getThemeByName("dark"));
					assert.deepEqual(widget.render(200), [], "Widget slot must occupy zero rows");
				},
			},
		};
		extension({ on: (event, handler) => handlers.set(event, handler),
			registerCommand: (name, command) => commands.set(name, command) });
		const emit = async (name, event = {}) => handlers.get(name)(event, ctx);
		const line = () => stripTerminalSequences(overlay.render(200)[0]);
		const viewport = () => {
			tui.renderNow();
			// Inspect the actual renderer's final frame, not a hand-written layout mock.
			const frame = tui.mode === "regular" ? tui.captureRenderState().previousLines : tui.previousScreen;
			return frame.slice(-terminal.rows).map(stripTerminalSequences);
		};
		tui.start();
		try {
			await emit("session_start");
			assert.ok(viewport()[0].includes("READY"));
			assert.equal(overlayHandle.getBounds().row, 0);
			assert.equal(tui.getFocusedComponent(), editor);
			terminal.input("hello");
			assert.equal(typed, "hello");

			chat.lines = Array.from({ length: 100 }, (_, i) => `Chat row ${i}`);
			assert.ok(viewport()[0].includes("READY"), "Long transcript must keep bar at visible top");
			for (const [columns, rows] of [[80, 12], [120, 40], [200, 24]]) {
				terminal.columns = columns;
				terminal.rows = rows;
				terminal.resize();
				assert.ok(viewport()[0].includes("READY"));
				assert.equal(overlayHandle.getBounds().width, columns);
			}

			await emit("agent_start");
			assert.ok(viewport()[0].includes("RUNNING"));
			await emit("tool_execution_start", { toolName: "bash" });
			assert.ok(line().includes("bash"));
			await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429" } });
			await emit("agent_settled", { aborted: false });
			assert.ok(viewport()[0].includes("ERROR"));
			await emit("agent_start");
			await emit("agent_settled", { aborted: true });
			assert.ok(viewport()[0].includes("STOPPED"));

			const dialog = new Text("MODEL PICKER", 0, 0);
			const dialogHandle = showOverlay(dialog, { anchor: "center", width: 40 });
			assert.equal(tui.getFocusedComponent(), dialog);
			await emit("thinking_level_select", { level: "low" });
			assert.equal(tui.getFocusedComponent(), dialog);
			dialogHandle.hide();
			assert.equal(tui.getFocusedComponent(), editor);

			await commands.get("topbar").handler("off", ctx);
			assert.equal(tui.hasOverlayEntries, false, "Off removes overlay so TUI mode can switch");
			assert.deepEqual(overlay.render(200), []);
			await commands.get("topbar").handler("on", ctx);
			assert.ok(viewport()[0].includes("STOPPED"));
			widget.dispose();
			assert.equal(tui.hasOverlayEntries, false);
			await emit("session_start");
			assert.ok(viewport()[0].includes("STOPPED"));
			await commands.get("topbar").handler("off", ctx);
			assert.equal(tui.hasOverlayEntries, false, "Remount must not leave duplicate overlays");
		} finally {
			await emit("session_shutdown");
			assert.equal(tui.hasOverlayEntries, false);
			tui.stop();
		}
	});
}
