import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type EditorTheme,
	type TUI,
	type TuiMouseEvent,
	CURSOR_MARKER,
	mixColors,
	renderFakeCursor,
	rgbColor,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface TopBarState {
	status: "idle" | "running" | "error" | "aborted";
	errorMessage?: string;
	startTime?: number;
	modelId?: string;
	thinkingLevel?: string;
	activeTool?: string;
	gitBranch?: string | null;
	cwd?: string;
	visible: boolean;
	usage?: UsageTotals;
}

export interface UsageTotals {
	input: number;
	output: number;
	total: number;
	cost: number;
}

export function collectUsage(entries: ReturnType<ExtensionContext["sessionManager"]["getEntries"]>): UsageTotals {
	const totals = { input: 0, output: 0, total: 0, cost: 0 };
	for (const entry of entries) {
		let usage;
		if (entry.type === "usage") usage = entry.usage;
		else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
		if (!usage) continue;
		totals.input += usage.input;
		totals.output += usage.output;
		// Reasoning tokens are already included in output; never add them twice.
		totals.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		totals.cost += usage.cost.total;
	}
	return totals;
}

const RAINBOW_STOPS = [
	rgbColor(255, 145, 158), rgbColor(255, 195, 112), rgbColor(237, 232, 126),
	rgbColor(133, 226, 177), rgbColor(119, 213, 244), rgbColor(172, 180, 255), rgbColor(225, 160, 239),
];
const RAINBOW_INK = rgbColor(24, 28, 44);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function rainbowBackground(column: number, width: number) {
	const position = Math.max(0, Math.min(1, column / Math.max(1, width - 1))) * (RAINBOW_STOPS.length - 1);
	const index = Math.min(RAINBOW_STOPS.length - 2, Math.floor(position));
	return mixColors(RAINBOW_STOPS[index], RAINBOW_STOPS[index + 1], position - index, "srgb");
}

function singleLine(text: string): string {
	return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/ +/g, " ").trim();
}

function shortCount(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

export class TopStatusBarComponent implements Component {
	constructor(private state: TopBarState, private theme: Theme, private context: ExtensionContext) {}

	updateContext(context: ExtensionContext) {
		this.context = context;
	}

	render(width: number): string[] {
		if (!this.state.visible || width <= 0) return [];
		const st = this.state;
		let status = "READY";
		if (st.status === "running") {
			const elapsed = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : 0;
			status = `RUNNING ${elapsed}s${st.activeTool ? ` ${singleLine(st.activeTool)}` : ""}`;
		} else if (st.status === "error") status = "ERROR";
		else if (st.status === "aborted") status = "STOPPED";

		const usage = st.usage ?? { input: 0, output: 0, total: 0, cost: 0 };
		const model = singleLine(st.modelId?.split("/").pop() || "no-model");
		const cwd = singleLine(st.cwd ?? this.context.cwd ?? "?");
		let context = "ctx ?";
		const contextUsage = this.context.getContextUsage();
		if (contextUsage && contextUsage.tokens !== null && contextUsage.contextWindow > 0) {
			context = `ctx ${shortCount(contextUsage.tokens)}/${shortCount(contextUsage.contextWindow)} (${Math.round(contextUsage.percent ?? contextUsage.tokens / contextUsage.contextWindow * 100)}%)`;
		}
		const parts = [
			model, st.thinkingLevel ?? "off", `↑${shortCount(usage.input)}`, `↓${shortCount(usage.output)}`,
			`Σ${shortCount(usage.total)}`, `$${usage.cost.toFixed(3)}`, context,
			singleLine(st.gitBranch ?? "no-git"), cwd,
		];
		const prefix = `──── ${status} `;
		const fit = () => prefix + parts.join(" · ") + " ────";
		if (visibleWidth(fit()) > width) {
			parts[0] = truncateToWidth(model, Math.max(8, Math.min(24, Math.floor(width * 0.2))), "…");
			parts[8] = cwd.split(/[\\/]/).filter(Boolean).pop() || cwd;
		}
		// The first fields always survive: status, model, thinking. Drop trailing details first.
		while (parts.length > 2 && visibleWidth(fit()) > width) parts.pop();
		if (st.status === "error" && st.errorMessage) {
			const reason = ` · ${singleLine(st.errorMessage)}`;
			if (visibleWidth(fit() + reason) <= width) parts.push(singleLine(st.errorMessage));
		}
		const text = stripTerminalSequences(truncateToWidth(fit(), width, "…"));
		const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		const prefixWidth = visibleWidth(prefix);
		let line = "";
		let column = 0;
		for (const { segment } of graphemes.segment(padded)) {
			line += this.theme.style(segment, {
				fg: RAINBOW_INK, bg: rainbowBackground(column, width), bold: column < prefixWidth,
			});
			column += visibleWidth(segment);
		}
		return [line];
	}

	invalidate(): void {}
}

/** Keep Pi's editor, cursor markers, completion and shortcuts; reserve a two-column prompt gutter. */
export class GreenPromptEditor extends CustomEditor {
	private bottomBorder = "";

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, private getTheme: () => Theme) {
		super(tui, editorTheme, keybindings, { paddingX: 0, embedWorkingStatus: false });
	}

	protected renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount);
		return this.bottomBorder;
	}

	render(width: number): string[] {
		// Pi's word wrapper cannot fit wide graphemes into a one-column content area.
		if (width < 6) {
			if (width <= 0) return [];
			const border = this.borderColor("─".repeat(width));
			return [border, (this.focused ? CURSOR_MARKER : "") + renderFakeCursor(" ") + " ".repeat(width - 1), border];
		}
		const lines = super.render(width - 2);
		const bottom = lines.findIndex((line, index) => index > 1 && line === this.bottomBorder);
		const prompt = this.getTheme().style(">", { fg: "success", bold: true }) + " ";
		return lines.map((line, index) => {
			if (index === 0 || index === bottom) return line + this.borderColor("──");
			return (index === 1 ? prompt : "  ") + line;
		});
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.width < 6) return { handled: true, focus: true };
		return super.handleMouse({
			...event, x: Math.max(0, event.x - 2), width: event.width - 2,
		});
	}
}

export default function (pi: ExtensionAPI) {
	const state: TopBarState = { status: "idle", visible: true };
	let currentContext: ExtensionContext | null = null;
	let tuiInstance: TUI | null = null;
	let bar: TopStatusBarComponent | null = null;
	let stopBranchWatch: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	const activeTools = new Map<string, string>();
	let lastAssistantFailed = false;

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};
	const redraw = () => {
		bar?.invalidate();
		tuiInstance?.requestRender();
	};
	const sync = (ctx: ExtensionContext, usage = false) => {
		currentContext = ctx;
		state.modelId = ctx.model?.id;
		state.thinkingLevel = ctx.thinkingLevel;
		state.cwd = ctx.cwd;
		bar?.updateContext(ctx);
		if (usage) state.usage = collectUsage(ctx.sessionManager.getEntries());
	};

	pi.on("session_start", (_event, ctx) => {
		stopTimer();
		stopBranchWatch?.();
		state.status = ctx.isIdle() ? "idle" : "running";
		state.errorMessage = undefined;
		state.startTime = state.status === "running" ? Date.now() : undefined;
		state.activeTool = undefined;
		activeTools.clear();
		lastAssistantFailed = false;
		sync(ctx, true);
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setFooter((_tui, _theme, footerData) => {
			state.gitBranch = footerData.getGitBranch();
			const unsubscribe = footerData.onBranchChange(() => {
				state.gitBranch = footerData.getGitBranch();
				redraw();
			});
			let disposed = false;
			stopBranchWatch = () => {
				if (!disposed) unsubscribe();
				disposed = true;
			};
			return { render: () => [], invalidate() {}, dispose: stopBranchWatch };
		});
		ctx.ui.setWidget("ipiui_status_bar", (tui, theme) => {
			tuiInstance = tui;
			bar = new TopStatusBarComponent(state, theme, ctx);
			return {
				render: (width) => bar?.render(width) ?? [],
				invalidate: () => bar?.invalidate(),
				dispose: () => { stopTimer(); bar = null; tuiInstance = null; },
			};
		}, { placement: "aboveEditor" });
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new GreenPromptEditor(tui, theme, keybindings, () => currentContext!.ui.theme));
		redraw();
	});

	pi.on("agent_start", (_event, ctx) => {
		sync(ctx);
		state.status = "running";
		state.startTime ??= Date.now();
		state.errorMessage = undefined;
		lastAssistantFailed = false;
		stopTimer();
		timer = setInterval(redraw, 1000);
		redraw();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		sync(ctx);
		activeTools.set(event.toolCallId, event.toolName);
		state.activeTool = [...activeTools.values()].join(", ");
		redraw();
	});
	pi.on("tool_execution_end", (event, ctx) => {
		sync(ctx);
		activeTools.delete(event.toolCallId);
		state.activeTool = [...activeTools.values()].join(", ");
		redraw();
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant") {
			lastAssistantFailed = event.message.stopReason === "error";
			state.errorMessage = lastAssistantFailed ? event.message.errorMessage || "Request failed" : undefined;
		}
		sync(ctx, true);
		redraw();
	});
	pi.on("agent_settled", (event, ctx) => {
		stopTimer();
		sync(ctx, true);
		state.status = event.aborted ? "aborted" : lastAssistantFailed ? "error" : "idle";
		state.startTime = undefined;
		activeTools.clear();
		state.activeTool = undefined;
		redraw();
	});
	pi.on("model_select", (event, ctx) => {
		sync(ctx);
		state.modelId = event.model.id;
		redraw();
	});
	pi.on("thinking_level_select", (event, ctx) => {
		sync(ctx);
		state.thinkingLevel = event.level;
		redraw();
	});
	const refreshSession = (_event: unknown, ctx: ExtensionContext) => { sync(ctx, true); redraw(); };
	pi.on("turn_end", refreshSession);
	pi.on("session_tree", refreshSession);
	pi.on("session_compact", refreshSession);
	pi.on("session_shutdown", () => {
		stopTimer();
		stopBranchWatch?.();
		stopBranchWatch = undefined;
		currentContext = null;
		bar = null;
		tuiInstance = null;
	});
	pi.registerCommand("topbar", {
		description: "Toggle the status row above the editor (/topbar [on|off|toggle])",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!["", "on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /topbar [on|off|toggle]", "warning");
				return;
			}
			sync(ctx, true);
			state.visible = action === "on" ? true : action === "off" ? false : !state.visible;
			redraw();
		},
	});
}
