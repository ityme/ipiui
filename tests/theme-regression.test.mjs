import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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
assert.ok(existsSync(hostRoot), "Set PI_TEST_HOST_ROOT to Pi 1.5.0's node_modules directory");
const hostRequire = createRequire(path.join(hostRoot, "__ipiui_tests.cjs"));
const { createJiti } = hostRequire("jiti");
// Only CustomEditor is needed at runtime; load it directly to avoid the host SDK's unrelated resources.
const jiti = createJiti(path.join(projectRoot, "index.ts"), {
	alias: {
		"@earendil-works/pi-coding-agent": path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js"),
		"@earendil-works/pi-tui": path.join(hostRoot, "@earendil-works/pi-tui/dist/index.js"),
	},
});
const { default: extension, TopStatusBarComponent, collectUsage } = jiti(path.join(projectRoot, "index.ts"));
const { getThemeByName, loadThemeFromPath } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")));
const { visibleWidth, stripTerminalSequences, colorToRgb, indexedColor, TuiMainScreen,
	Container, getKeybindings, CURSOR_MARKER } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-tui/dist/index.js")));
const context = {
	cwd: "I:/ispace/ipiui",
	getContextUsage: () => ({ tokens: 24500, contextWindow: 128000, percent: 19.140625 }),
};
const plain = stripTerminalSequences;

for (const themeName of ["dark", "light", "system"]) {
	const theme = getThemeByName(themeName);
	assert.ok(theme);
	for (const [status, symbol] of [
		["idle", "READY"], ["running", "RUNNING"], ["error", "ERROR"], ["aborted", "STOPPED"],
	]) {
		test(`${themeName}: ${status} fits narrow and wide widths with actual Pi theme`, () => {
			const component = new TopStatusBarComponent({
				status, visible: true, startTime: Date.now() - 5000, modelId: "gemini-3.8-flash",
				thinkingLevel: "high", activeTool: "bash", errorMessage: "Rate limit exceeded 429",
			}, theme, context);
			for (const width of [1, 8, 40, 100, 200]) {
				const lines = component.render(width);
				assert.equal(lines.length, 1);
				assert.equal(visibleWidth(lines[0]), width);
				if (width >= 100) assert.ok(plain(lines[0]).includes(symbol));
			}
		});
	}
}

test("running icon animates with braille rotation", () => {
	const theme = getThemeByName("dark");
	const component = new TopStatusBarComponent({ status: "running", visible: true, startTime: Date.now() - 5000 }, theme, context);
	const first = plain(component.render(200)[0]).match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) RUNNING/)?.[1];
	let changed = false;
	for (let i = 0; i < 8; i++) {
		const originalNow = Date.now;
		Date.now = () => originalNow() + i * 100;
		const next = plain(component.render(200)[0]).match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) RUNNING/)?.[1];
		if (next && next !== first) changed = true;
		Date.now = originalNow;
	}
	assert.equal(changed, true);
	for (const [status, icon] of [["idle", "✓"], ["error", "✗"], ["aborted", "■"]]) {
		const stable = new TopStatusBarComponent({ status, visible: true }, theme, context);
		assert.ok(plain(stable.render(200)[0]).includes(icon));
	}
});

test("information order, unknown context, cumulative totals, branch and path", () => {
	const splitComp = new TopStatusBarComponent({ status: "idle", visible: true, style: "split",
		modelId: "relay/gemini3.8flash", thinkingLevel: "high", gitBranch: "dev", cwd: "I:/ispace/ipiui",
		usage: { input: 1200, output: 300, total: 2500, cost: 0.123 },
	}, getThemeByName("dark"), context);
	const splitLine = plain(splitComp.render(200)[0]);
	const splitFields = ["READY", "ipiui", "dev", "gemini3.8flash", "high", "↑1.2k", "↓300", "(Σ2.5k)", "$0.12", "CTX"];
	let splitPos = -1;
	for (const f of splitFields) {
		const next = splitLine.indexOf(f);
		assert.ok(next > splitPos, `Wrong split field order: ${f}`);
		splitPos = next;
	}

	for (const tokens of [0, null]) {
		splitComp.updateContext({ ...context,
			getContextUsage: () => ({ tokens, contextWindow: 128000, percent: tokens === null ? null : 0 }),
		});
		assert.ok(plain(splitComp.render(200)[0]).includes(tokens === null ? "0%" : "0%"));
	}
});

function usage(input = 100, output = 30, cacheRead = 20, cacheWrite = 10, cost = 0.01) {
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite,
		reasoning: 15, cost: { total: cost } };
}

test("usage matches Pi accounting, includes compaction/tools and does not double count reasoning", () => {
	const u = usage();
	const totals = collectUsage([
		{ type: "message", message: { role: "user", content: "ignored" } },
		{ type: "message", message: { role: "assistant", usage: u } },
		{ type: "usage", usage: u },
		{ type: "message", message: { role: "toolResult", usage: u } },
		{ type: "compaction", usage: u },
		{ type: "branch_summary", usage: u },
		{ type: "message", message: { role: "toolResult" } },
	]);
	assert.deepEqual(totals, { input: 500, output: 150, total: 800, cost: 0.05 });
});

function luminance({ r, g, b }) {
	const linear = [r, g, b].map(value => {
		const channel = value / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
for (const style of ["split", "pills"]) {
	test(`style ${style}: contrast >= 4.5:1, fills width without overflow`, () => {
		const theme = getThemeByName("dark");
		const component = new TopStatusBarComponent({
			status: "idle", visible: true, style, modelId: "中文👨‍👩‍👧‍👦e\u0301", thinkingLevel: "high",
		}, theme, context);
		for (const width of [1, 8, 40, 100, 200]) {
			const line = component.render(width)[0];
			assert.equal(visibleWidth(line), width);
			let foreground, background;
			for (const match of line.matchAll(/\u001b\[(38|48|49);?(2;\d+;\d+;\d+|5;\d+)?m/g)) {
				if (match[1] === "49") {
					background = undefined;
					continue;
				}
				const parts = (match[2] ?? "").split(";").map(Number);
				const color = parts[0] === 2 ? { r: parts[1], g: parts[2], b: parts[3] }
					: colorToRgb(indexedColor(parts[1]));
				if (match[1] === "38") foreground = color;
				else if (match[1] === "48") background = color;
				if (foreground && background) {
					const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
					assert.ok((levels[1] + 0.05) / (levels[0] + 0.05) >= 4.5);
				}
			}
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
const { CustomEditor } = jiti(path.join(hostRoot, "@earendil-works/pi-coding-agent/dist/modes/interactive/components/custom-editor.js"));
const { KeybindingsManager } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-coding-agent/dist/core/keybindings.js")));
const keybindings = new KeybindingsManager();
const editorTheme = { borderColor: text => text,
	selectList: { selectedPrefix: text => text, selectedText: text => text, description: text => text,
		scrollInfo: text => text, noMatch: text => text } };

test("native prompt has no > and preserves text, wrapping, IME cursor marker, mouse and shortcuts", () => {
	const tui = new TuiMainScreen(new TestTerminal());
	const theme = getThemeByName("dark");
	const editor = new CustomEditor(tui, editorTheme, keybindings);
	editor.focused = true;
	const render = width => {
		const lines = editor.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.ok(lines.join("").includes(CURSOR_MARKER), "IME hardware cursor marker must survive");
		return lines;
	};
	try {
		const empty = render(40);
		assert.ok(!plain(empty[1]).includes(">"));
		editor.handleInput("你好");
		assert.equal(editor.getText(), "你好");
		assert.ok(plain(render(40)[1]).startsWith("你好"));
		editor.setText("a".repeat(60) + "\n第二行👨‍👩‍👧‍👦");
		for (const width of [8, 20, 40]) render(width);
		editor.setText("abcd");
		render(40);
		editor.handleMouse({ type: "click", button: "left", x: 2, y: 1, width: 40, height: 3,
			screenX: 2, screenY: 1, shift: false, alt: false, ctrl: false });
		editor.handleInput("X");
		assert.equal(editor.getText(), "abXcd");
		let interrupted = false;
		editor.onEscape = () => { interrupted = true; };
		editor.handleInput("\u001b");
		assert.equal(interrupted, true);
		editor.setText("");
		let submitted;
		editor.onSubmit = value => { submitted = value; };
		editor.handleInput("\u001b[200~pasted\ntext\u001b[201~");
		assert.equal(editor.getText(), "pasted\ntext");
		editor.handleInput("\r");
		assert.equal(submitted, "pasted\ntext");
	} finally { tui.stop(); }
});

test("completion remains below editor border and cursor marker survives", async () => {
	const tui = new TuiMainScreen(new TestTerminal());
	const editor = new CustomEditor(tui, editorTheme, keybindings);
	editor.focused = true;
	editor.setAutocompleteProvider({
		triggerCharacters: ["/"],
		async getSuggestions() { return { items: [{ value: "/hello", label: "/hello" }], prefix: "/" }; },
		applyCompletion() { return { lines: ["/hello"], cursorLine: 0, cursorCol: 6 }; },
	});
	try {
		editor.handleInput("/");
		for (let i = 0; i < 10 && !editor.isShowingAutocomplete(); i++) {
			await new Promise(resolve => setImmediate(resolve));
		}
		assert.equal(editor.isShowingAutocomplete(), true);
		const lines = editor.render(40);
		assert.match(plain(lines[2]), /^─+$/);
		assert.ok(lines.slice(3).some(line => plain(line).includes("/hello")));
		assert.ok(lines.join("").includes(CURSOR_MARKER));
		editor.handleInput("\t");
		assert.equal(editor.getText(), "/hello");
	} finally { tui.stop(); }
});

test("regular mode: information above editor, empty footer, lifecycle, parallel tools and cleanup", async () => {
	const isolatedRoot = await (await import("node:fs/promises")).mkdtemp(path.join((await import("node:os")).tmpdir(), "ipiui-reg-test-"));
	process.env.IPIUI_TEST_GROUP_ROOT = isolatedRoot;
	const terminal = new TestTerminal();
	const tui = new TuiMainScreen(terminal);
	const handlers = new Map(), commands = new Map();
	const chat = new Container(), widgetSlot = new Container(), editorSlot = new Container(), footerSlot = new Container();
	for (const component of [chat, widgetSlot, editorSlot, footerSlot]) tui.addChild(component);
	let widget, footer, editor, branchChanged, unsubscribed = 0;
	const titles = [];
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const heartbeatCallbacks = [];
	globalThis.setInterval = (callback, delay) => {
		if (delay === 1500) heartbeatCallbacks.push(callback);
		return originalSetInterval(callback, delay);
	};
	globalThis.clearInterval = handle => originalClearInterval(handle);
	const untilTitle = async predicate => {
		const deadline = Date.now() + 3000;
		while (!predicate(titles.at(-1) ?? "")) {
			if (Date.now() > deadline) throw new Error(`Title update timed out: ${titles.at(-1)}`);
			await new Promise(resolve => setTimeout(resolve, 10));
		}
	};
	let entries = [];
	let branch = "dev";
	const ctx = {
		...context, mode: "tui", isIdle: () => true,
		model: { id: "relay/gemini3.8flash", provider: "test" }, thinkingLevel: "high",
		sessionManager: { getEntries: () => entries },
		ui: {
			theme: getThemeByName("dark"), notify() {},
			setTitle(title) { titles.push(title); },
			setWorkingVisible(value) { assert.equal(value, false); },
			setFooter(factory) {
				footer?.dispose?.(); footerSlot.clear();
				footer = factory(tui, this.theme, { getGitBranch: () => branch,
					onBranchChange(callback) { branchChanged = callback; return () => { unsubscribed++; }; } });
				footerSlot.addChild(footer);
			},
			setWidget(_key, factory, options) {
				assert.equal(options.placement, "aboveEditor");
				widget?.dispose?.(); widgetSlot.clear();
				widget = factory(tui, this.theme); widgetSlot.addChild(widget);
			},
			setEditorComponent(factory) {
				const saved = editor?.getText() ?? "";
				editorSlot.clear();
				assert.equal(factory, undefined, "Extension must restore Pi's native editor");
				editor = new CustomEditor(tui, editorTheme, keybindings);
				editor.setText(saved); editorSlot.addChild(editor); tui.setFocus(editor);
			},
		},
	};
	extension({ on: (event, handler) => handlers.set(event, handler),
		registerCommand: (name, command) => commands.set(name, command) });
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	const line = () => plain(widget.render(200)[0] ?? "");
	const frame = () => { tui.renderNow(); return tui.captureRenderState().previousLines.map(plain); };
	tui.start();
	try {
		await emit("session_start");
		assert.equal(tui.hasOverlayEntries, false);
		assert.deepEqual(footer.render(200), []);
		let lines = frame();
		assert.ok(lines[0].includes("✓"));
		assert.ok(!lines[2].includes(">"));
		assert.match(lines.at(-1), /^─+$/);
		terminal.input("hello"); assert.equal(editor.getText(), "hello");
		chat.addChild({ render: () => Array.from({ length: 100 }, (_, i) => `Chat row ${i}`), invalidate() {} });
		lines = frame();
		assert.equal(lines[99], "Chat row 99");
		assert.ok(lines[100].includes("✓"));
		assert.ok(lines[102].startsWith("hello"));
		for (const columns of [40, 80, 200]) {
			terminal.columns = columns; terminal.resize();
			assert.ok(frame().every(row => visibleWidth(row) <= columns));
		}
		// Auto-joins default 'all' group
		await untilTitle(title => title.startsWith("[1○"));
		await commands.get("tabname").handler("api", ctx);
		await untilTitle(title => title === "[1○api]");
		assert.ok(heartbeatCallbacks.length > 0);
		titles.push("overwritten-by-pi");
		heartbeatCallbacks.at(-1)();
		assert.equal(titles.at(-1), "[1○api]", "Heartbeat must reassert the last grouped title");
		await emit("agent_start"); assert.ok(line().includes("RUNNING"));
		await untilTitle(title => title === "[1▶api]");
		await emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
		await emit("tool_execution_start", { toolCallId: "b", toolName: "bash" });
		await emit("tool_execution_end", { toolCallId: "a" });
		assert.ok(line().includes("bash"));
		entries = [{ type: "message", message: { role: "assistant", usage: usage() } }];
		await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429" } });
		await emit("agent_settled", { aborted: false }); assert.ok(line().includes("✗"));
		await untilTitle(title => title === "[1✗api]");
		assert.ok(line().includes("↑100"));
		await emit("agent_start");
		await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		await emit("agent_settled", { aborted: false }); assert.ok(line().includes("✓"));
		await untilTitle(title => title === "[1✓api]");
		await emit("agent_start"); await emit("agent_settled", { aborted: true });
		assert.ok(line().includes("■"));
		branch = "feature"; branchChanged(); assert.ok(line().includes("feature"));
		await commands.get("topbar").handler("off", ctx); assert.deepEqual(widget.render(200), []);
		await commands.get("topbar").handler("on", ctx); assert.ok(line().includes("■"));
		await emit("session_start"); assert.ok(line().includes("✓"));
		assert.equal(editor.getText(), "hello");
		await untilTitle(title => title === "[1○api]");
		await commands.get("tabgroup").handler("off", ctx);
		assert.equal(titles.at(-1), "pi");
		const count = titles.length;
		await emit("agent_start"); await emit("agent_settled", { aborted: false });
		assert.equal(titles.length, count);
		await commands.get("tabgroup").handler("off", ctx);
		const heartbeatCount = heartbeatCallbacks.length;
		if (heartbeatCallbacks.at(-1)) heartbeatCallbacks.at(-1)();
		assert.equal(titles.at(-1), "pi");
		assert.equal(heartbeatCallbacks.length, heartbeatCount);
	} finally {
		await emit("session_shutdown"); widget?.dispose?.(); footer?.dispose?.(); tui.stop();
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		delete process.env.IPIUI_TEST_GROUP_ROOT;
		await (await import("node:fs/promises")).rm(isolatedRoot, { recursive: true, force: true });
	}
	assert.ok(unsubscribed >= 2);
});
