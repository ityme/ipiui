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
const { default: extension, TopStatusBarComponent, collectUsage, getRainbowBlockPalette } = jiti(path.join(projectRoot, "index.ts"));
const { TabTitleGroup, tabGroupDirectory } = jiti(path.join(projectRoot, "src/tab-title.ts"));
const { getThemeByName, loadThemeFromPath } = await import(pathToFileURL(path.join(hostRoot,
	"@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")));
const { visibleWidth, stripTerminalSequences, colorToRgb, colorToOklch, indexedColor, TuiMainScreen,
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
		["idle", "idle"], ["running", "working"], ["error", "error"], ["aborted", "aborted"],
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
	const first = plain(component.render(200)[0]).match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) working/)?.[1];
	let changed = false;
	for (let i = 0; i < 8; i++) {
		const originalNow = Date.now;
		Date.now = () => originalNow() + i * 100;
		const next = plain(component.render(200)[0]).match(/([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]) working/)?.[1];
		if (next && next !== first) changed = true;
		Date.now = originalNow;
	}
	assert.equal(changed, true);
	for (const [status, icon] of [["idle", "⠿"], ["error", "✗"], ["aborted", "■"]]) {
		const stable = new TopStatusBarComponent({ status, visible: true }, theme, context);
		assert.ok(plain(stable.render(200)[0]).includes(icon));
	}
});

test("fixed module colors stay static when idle; running sweep preserves text and contrast", () => {
	const originalNow = Date.now;
	try {
		for (const appearance of ["dark", "light"]) {
			const styled = [];
			const baseTheme = getThemeByName(appearance);
			const theme = Object.create(baseTheme);
			theme.style = (text, options) => { styled.push({ text, ...options }); return baseTheme.style(text, options); };
			const state = { status: "idle", visible: true, style: "rainbow_blocks", startTime: 100_000,
				modelId: "gpt-6.1-sol", thinkingLevel: "high", usage: { input: 17900000, output: 115900, total: 0, cost: 22.52 } };
			const component = new TopStatusBarComponent(state, theme, context);
			Date.now = () => 100_000;
			const idle = component.render(220)[0];
			const blocks = styled.slice(3);
			const palette = getRainbowBlockPalette(appearance === "dark");
			for (const [text, color] of [
				["📁 ipiui", palette.fgProject], ["dev", palette.fgBranch],
				["🤖 gpt-6.1-sol", palette.fgModel], ["high", palette.fgThinking],
				["⬆️17.9M", palette.fgTokenIn], ["⬇️115.9k", palette.fgTokenOut], ["💰 22.52¥", palette.fgCost],
			]) {
				assert.deepEqual(colorToRgb(blocks.find(item => item.text === text).fg), colorToRgb(color), `${text} must use its field color`);
			}
			for (const item of blocks) assert.ok(contrastRatio(item.fg, item.bg) >= 4.5, `${appearance} idle ${item.text} contrast ${contrastRatio(item.fg, item.bg)}`);
			assert.ok(plain(idle).includes("[📁 ipiui dev] [🤖 gpt-6.1-sol · high] [⬆️17.9M ⬇️115.9k 💰 22.52¥] [CTX"));
			Date.now = () => 104_000;
			assert.equal(component.render(220)[0], idle, "Idle colors must not animate");
			state.status = "running";
			const frames = [];
			for (const time of [0, 1000, 4000, 7999, 8000]) {
				Date.now = () => 100_000 + time;
				styled.length = 0;
				const line = component.render(220)[0];
				assert.equal(visibleWidth(line), 220);
				assert.ok(plain(line).includes("[📁 ipiui dev] [🤖 gpt-6.1-sol · high]"));
				const right = styled.slice(3);
				for (const item of right) assert.ok(contrastRatio(item.fg, item.bg) >= 4.5, `${appearance} ${item.text} contrast ${contrastRatio(item.fg, item.bg)}`);
				frames.push(right.map(item => colorToRgb(item.fg)));
			}
			assert.notDeepEqual(frames[0], frames[1]);
			assert.notDeepEqual(frames[1], frames[2]);
			assert.deepEqual(frames[0], frames[3], "Sweep should leave text before wrapping");
			assert.deepEqual(frames[0], frames[4]);
			const modelColor = blocks.find(item => item.text === "🤖 gpt-6.1-sol").fg;
			const thinkingColor = blocks.find(item => item.text === "high").fg;
			assert.notDeepEqual(colorToRgb(modelColor), colorToRgb(thinkingColor));
			for (const color of [modelColor, thinkingColor]) assert.ok(contrastRatio(color, getRainbowBlockPalette(appearance === "dark").bgModelThink) >= 4.5);
			const ctxLabel = blocks.find(item => item.text === "CTX ");
			const ctxFilled = blocks.find(item => item.text.includes("━"));
			const ctxTrack = blocks.find(item => item.text.includes("─"));
			const ctxPercent = blocks.find(item => /^ \d+% $/.test(item.text));
			const ctxTokens = blocks.find(item => item.text === "24.5k/128.0k");
			assert.equal(JSON.stringify(colorToRgb(ctxFilled.fg)), JSON.stringify(colorToRgb(ctxPercent.fg)));
			assert.notDeepEqual(colorToRgb(ctxTrack.fg), colorToRgb(ctxFilled.fg));
			assert.notDeepEqual(colorToRgb(ctxTokens.fg), colorToRgb(ctxFilled.fg));
			for (const field of [ctxLabel, ctxFilled, ctxTrack, ctxPercent, ctxTokens]) assert.ok(contrastRatio(field.fg, field.bg) >= 4.5);
			state.status = "aborted";
			styled.length = 0;
			component.render(220);
			assert.deepEqual(styled.slice(3).map(item => colorToRgb(item.fg)), blocks.map(item => colorToRgb(item.fg)));
		}
	} finally { Date.now = originalNow; }
});

test("long project labels preserve status and terminal width", () => {
	const component = new TopStatusBarComponent({ status: "idle", visible: true, cwd: "I:/" + "项目".repeat(100), gitBranch: "feature-long" }, getThemeByName("dark"), context);
	for (const width of [20, 40, 80, 200]) {
		const line = component.render(width)[0];
		assert.equal(visibleWidth(line), width);
		assert.ok(plain(line).includes("[⠿ idle]"));
	}
});

test("information order, unknown context, cumulative totals, branch and path", () => {
	const splitComp = new TopStatusBarComponent({ status: "idle", visible: true, style: "rainbow_blocks",
		modelId: "relay/gemini3.8flash", thinkingLevel: "high", gitBranch: "dev", cwd: "I:/ispace/ipiui",
		usage: { input: 1200, output: 300, total: 2500, cost: 0.123 },
	}, getThemeByName("dark"), context);
	const splitLine = plain(splitComp.render(200)[0]);
	const splitFields = ["[⠿ idle", "[📁 ipiui dev]", "[🤖 gemini3.8flash · high]", "[⬆️1.2k ⬇️300 💰 0.12¥]", "[CTX"];
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
function saturation(color) {
	const { r, g, b } = colorToRgb(color);
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	return max === 0 ? 0 : (max - min) / max;
}
function contrastRatio(a, b) {
	const x = luminance(colorToRgb(a)), y = luminance(colorToRgb(b));
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
test("all status-block foregrounds and backgrounds share muted saturation with readable contrast", () => {
	for (const dark of [true, false]) {
		const palette = getRainbowBlockPalette(dark);
		const statusPairs = [
			[palette.fgStatusReady, palette.bgStatusReady], [palette.fgStatusRun, palette.bgStatusRun],
			[palette.fgStatusErr, palette.bgStatusErr], [palette.fgStatusStp, palette.bgStatusStp],
		];
		for (const [fg, bg] of statusPairs) assert.ok(contrastRatio(fg, bg) >= 4.5, "Status contrast must remain readable");
		const pairs = [
			["project", palette.fgProject, palette.bgProjBranch], ["branch", palette.fgBranch, palette.bgProjBranch],
			["model", palette.fgModel, palette.bgModelThink], ["thinking", palette.fgThinking, palette.bgModelThink],
			["token in", palette.fgTokenIn, palette.bgTelemetry], ["token out", palette.fgTokenOut, palette.bgTelemetry], ["cost", palette.fgCost, palette.bgTelemetry],
			["context", palette.ctxText, palette.bgCtx], ["context values", palette.ctxValue, palette.bgCtx],
			["context track", palette.ctxTrack, palette.bgCtx], ["context low", palette.ctxLow, palette.bgCtx],
			["context medium", palette.ctxMed, palette.bgCtx], ["context high", palette.ctxHigh, palette.bgCtx],
			["bracket", palette.bracketColor, palette.bgModelThink],
		];
		for (const [name, fg, bg] of pairs) {
			assert.ok(colorToOklch(fg).c <= 0.101, `${dark ? "dark" : "light"} ${name} chroma too high: ${colorToOklch(fg).c}`);
			assert.ok(contrastRatio(fg, bg) >= 4.5, `${dark ? "dark" : "light"} ${name} contrast too low: ${contrastRatio(fg, bg)}`);
		}
	}
});
for (const style of ["rainbow_blocks"]) {
	test(`style ${style}: fills width without overflow for CJK and emoji`, () => {
		const theme = getThemeByName("dark");
		const component = new TopStatusBarComponent({
			status: "idle", visible: true, style, modelId: "中文👨‍👩‍👧‍👦e\u0301", thinkingLevel: "high",
		}, theme, context);
		for (const width of [1, 8, 40, 100, 200]) {
			const line = component.render(width)[0];
			assert.equal(visibleWidth(line), width);
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

test("preview-width split layout keeps model, thinking, telemetry and CTX pills separate", () => {
	const component = new TopStatusBarComponent({
		status: "running", startTime: Date.now() - 6000, visible: true, style: "rainbow_blocks",
		modelId: "gemini-3.8-flash", thinkingLevel: "medium", gitBranch: "dev", cwd: "I:/ipiui",
		usage: { input: 35200000, output: 225000, total: 117000000, cost: 37.99 },
	}, getThemeByName("dark"), {
		...context,
		getContextUsage: () => ({ tokens: 539000, contextWindow: 1048576, percent: 51 }),
	});
	const line = plain(component.render(140)[0]);
	assert.equal(visibleWidth(line), 140);
	const splitFields = ["working", "ipiui", "dev", "gemini-3.8-flash", "medium", "⬆️35.2M", "⬇️225.0k", "💰 37.99¥", "CTX"];
	let position = -1;
	for (const field of splitFields) {
		const next = line.indexOf(field);
		assert.ok(next > position, `Wrong split order: ${field}`);
		position = next;
	}
	assert.ok(!line.includes("...") && !line.includes("(Σ") && !line.includes("|"));
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
		assert.ok(lines[0].includes("⠿ idle"));
		assert.ok(!lines[2].includes(">"));
		assert.match(lines.at(-1), /^─+$/);
		terminal.input("hello"); assert.equal(editor.getText(), "hello");
		chat.addChild({ render: () => Array.from({ length: 100 }, (_, i) => `Chat row ${i}`), invalidate() {} });
		lines = frame();
		assert.equal(lines[99], "Chat row 99");
		assert.ok(lines[100].includes("⠿ idle"));
		assert.ok(lines[102].startsWith("hello"));
		for (const columns of [40, 80, 200]) {
			terminal.columns = columns; terminal.resize();
			assert.ok(frame().every(row => visibleWidth(row) <= columns));
		}
		// Auto-joins default 'all' group
		await commands.get("tabname").handler("api", ctx);
		await untilTitle(title => title === "api");
		assert.ok(heartbeatCallbacks.length > 0);
		titles.push("overwritten-by-pi");
		heartbeatCallbacks.at(-1)();
		assert.equal(titles.at(-1), "api", "Heartbeat must reassert the last grouped title");
		await emit("agent_start"); assert.ok(line().includes("working"));
		await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start" } });
		assert.ok(line().includes("thinking"));
		assert.ok(!line().includes("idle"));
		await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_delta", delta: "hidden reasoning text" } });
		assert.ok(line().includes("thinking"));
		assert.ok(!line().includes("hidden reasoning text"));
		await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_end" } });
		assert.ok(line().includes("working"));
		await emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "thinking_start" } });
		await untilTitle(title => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]api$/.test(title));
		await emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
		assert.ok(!line().includes("thinking"));
		await emit("tool_execution_start", { toolCallId: "b", toolName: "bash" });
		await emit("tool_execution_end", { toolCallId: "a" });
		assert.ok(line().includes("working"));
		entries = [{ type: "message", message: { role: "assistant", usage: usage() } }];
		await emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "429" } });
		await emit("agent_settled", { aborted: false }); assert.ok(line().includes("error"));
		await untilTitle(title => title === "api");
		assert.ok(line().includes("⬆️100"));
		await emit("agent_start");
		await emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		await emit("agent_settled", { aborted: false }); assert.ok(line().includes("idle"));
		await untilTitle(title => title === "api");
		await emit("agent_start"); await emit("agent_settled", { aborted: true });
		assert.ok(line().includes("aborted"));
		branch = "feature"; branchChanged(); assert.ok(line().includes("feature"));
		await commands.get("topbar").handler("off", ctx); assert.deepEqual(widget.render(200), []);
		await commands.get("topbar").handler("on", ctx); assert.ok(line().includes("aborted"));
		await emit("session_start"); assert.ok(line().includes("⠿ idle"));
		assert.equal(editor.getText(), "hello");
		await untilTitle(title => title === "api");
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


test("title lifecycle: idle peers animate from cache, commands agree, shutdown clears timers", async () => {
	const fs = await import("node:fs/promises");
	const root = await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "ipiui-lifecycle-"));
	const savedRoot = process.env.IPIUI_TEST_GROUP_ROOT;
	const savedGroup = process.env.IPIUI_GROUP;
	const originalNow = Date.now;
	let now = originalNow();
	Date.now = () => now;
	const originalSetInterval = globalThis.setInterval;
	const originalClearInterval = globalThis.clearInterval;
	const timers = new Map();
	globalThis.setInterval = (callback, delay) => {
		const handle = { unref() {} };
		timers.set(handle, { callback, delay });
		return handle;
	};
	globalThis.clearInterval = handle => timers.delete(handle);
	process.env.IPIUI_TEST_GROUP_ROOT = root;
	process.env.IPIUI_GROUP = "review";
	const handlers = new Map(), commands = new Map(), titles = [], notices = [];
	const selections = [], answers = [], prompts = [];
	let renderRequests = 0;
	const ctx = {
		...context, mode: "tui", isIdle: () => true,
		sessionManager: { getEntries: () => [] },
		ui: { setTitle: title => titles.push(title), notify: text => notices.push(text),
			select: async (title, choices) => {
				prompts.push({ title, choices });
				const selected = selections.shift();
				return typeof selected === "number" ? choices[selected] : selected;
			},
			input: async () => answers.shift(),
			setWorkingVisible() {}, setFooter() {},
			setWidget(_key, factory) {
				factory({ requestRender: () => { renderRequests++; } }, getThemeByName("dark"));
			}, setEditorComponent() {} },
	};
	extension({ on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command) });
	const emit = (name, event = {}) => handlers.get(name)(event, ctx);
	const command = args => commands.get("ipiui").handler(args, ctx);
	const peer = new TabTitleGroup({ root, intervalMs: 60_000, onTitle() {}, onError: error => { throw error; } });
	const flush = () => new Promise(resolve => setImmediate(resolve));
	try {
		await emit("session_start");
		assert.equal(titles.at(-1), "ipiui");
		now++;
		await peer.start("review", "worker", "running");
		const poll = [...timers.values()].find(timer => timer.delay === 1000);
		poll.callback();
		for (let i = 0; i < 100 && !titles.at(-1).includes("worker"); i++) {
			await new Promise(resolve => setTimeout(resolve, 5));
		}
		assert.match(titles.at(-1), /^ipiui ┃ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]worker$/);
		const directory = tabGroupDirectory("review", root);
		const files = await fs.readdir(directory);
		const snapshots = await Promise.all(files.map(file => fs.readFile(path.join(directory, file), "utf8")));
		const before = titles.length;
		now += 100;
		for (const timer of [...timers.values()].filter(timer => timer.delay === 100)) timer.callback();
		await flush();
		assert.ok(titles.length > before, "An idle pane must publish peer animation frames");
		assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(directory, file), "utf8"))), snapshots,
			"Animation frames must not write peer heartbeat files");
		await peer.stop();
		await command("name api");
		for (let i = 0; i < 100 && titles.at(-1) !== "api"; i++) await new Promise(resolve => setTimeout(resolve, 5));
		assert.equal(titles.at(-1), "api");
		assert.ok(![...timers.values()].some(timer => timer.delay === 100));
		await command("group off");
		await command("group");
		assert.match(notices.at(-1), /Title sync is off/);
		assert.equal(timers.size, 0);
		await commands.get("tabgroup").handler("review", ctx);
		await command("status");
		assert.match(notices.at(-1), /Title group: review/);
		selections.push(0, undefined);
		await command("");
		assert.ok(prompts[0].choices[0].includes("Show status row(显示状态栏)"));
		assert.ok(prompts[1].choices[0].includes("Hide status row(隐藏状态栏)"));
		await command("on");
		selections.push(1, 0, undefined);
		answers.push("panel-name");
		await command("menu");
		await command("name");
		assert.match(notices.at(-1), /panel-name/);
		selections.push(1, 1, undefined);
		await command("");
		await command("name");
		assert.match(notices.at(-1), /ipiui/);
		selections.push(2, 1, undefined);
		answers.push(undefined);
		await command("");
		await command("group");
		assert.match(notices.at(-1), /review/);
		await command("group bad" + String.fromCharCode(10) + "name");
		assert.match(notices.at(-1), /no control characters/);
		await emit("agent_start");
		await command("group off");
		assert.equal(titles.at(-1), "pi");
		assert.equal(timers.size, 1, "Only one local animation timer is needed");
		const animation = [...timers.values()][0];
		await command("off");
		const hiddenRequests = renderRequests;
		animation.callback();
		assert.equal(renderRequests, hiddenRequests, "Hidden status bars must skip animation redraws");
		await command("on");
		const visibleRequests = renderRequests;
		animation.callback();
		assert.equal(renderRequests, visibleRequests + 1);
		await commands.get("tabgroup").handler("review", ctx);
		await emit("session_shutdown");
		assert.equal(timers.size, 0, "Shutdown during a run must release every timer");
		await emit("session_shutdown");
	} finally {
		await peer.stop();
		await emit("session_shutdown");
		globalThis.setInterval = originalSetInterval;
		globalThis.clearInterval = originalClearInterval;
		Date.now = originalNow;
		if (savedRoot === undefined) delete process.env.IPIUI_TEST_GROUP_ROOT;
		else process.env.IPIUI_TEST_GROUP_ROOT = savedRoot;
		if (savedGroup === undefined) delete process.env.IPIUI_GROUP;
		else process.env.IPIUI_GROUP = savedGroup;
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("invalid startup group does not prevent the extension from starting", async () => {
	const savedGroup = process.env.IPIUI_GROUP;
	process.env.IPIUI_GROUP = "x".repeat(65);
	const handlers = new Map(), notices = [];
	extension({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
	try {
		await handlers.get("session_start")({}, {
			...context, mode: "tui", isIdle: () => true, sessionManager: { getEntries: () => [] },
			ui: { notify: text => notices.push(text), setWorkingVisible() {}, setFooter() {}, setWidget() {}, setEditorComponent() {} },
		});
		assert.ok(notices.some(text => text.includes("could not join title group")));
	} finally {
		await handlers.get("session_shutdown")();
		if (savedGroup === undefined) delete process.env.IPIUI_GROUP;
		else process.env.IPIUI_GROUP = savedGroup;
	}
});
