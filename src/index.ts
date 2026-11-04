import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { TabTitleGroup, cleanTitleLabel, type TabStatus } from "./tab-title.js";
import {
	type Color,
	type Component,
	type TUI,
	mixColors,
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

const RAW_RAINBOW = [
	rgbColor(255, 95, 120),  // coral / red
	rgbColor(255, 160, 70),  // amber / orange
	rgbColor(245, 215, 80),  // yellow
	rgbColor(70, 215, 140),  // emerald / green
	rgbColor(60, 195, 245),  // sky / cyan
	rgbColor(130, 150, 250), // indigo / blue
	rgbColor(215, 120, 240), // violet / purple
];

const DARK_BASE_BG = rgbColor(20, 24, 33);
const LIGHT_BASE_BG = rgbColor(245, 247, 250);

const DARK_RAINBOW_STOPS = RAW_RAINBOW.map(c => mixColors(DARK_BASE_BG, c, 0.28, "srgb"));
const LIGHT_RAINBOW_STOPS = RAW_RAINBOW.map(c => mixColors(LIGHT_BASE_BG, c, 0.22, "srgb"));

const DARK_INK = rgbColor(240, 243, 248);
const LIGHT_INK = rgbColor(24, 28, 44);

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function rainbowBackground(column: number, width: number, isDark = true, timeMs = 0) {
	const stops = isDark ? DARK_RAINBOW_STOPS : LIGHT_RAINBOW_STOPS;
	// Smooth flow: one full shift cycle every 4500ms
	const shift = (timeMs / 4500) % 1;
	const norm = column / Math.max(1, width - 1);
	const position = ((norm + shift) % 1) * (stops.length - 1);
	const index = Math.min(stops.length - 2, Math.floor(position));
	return mixColors(stops[index], stops[index + 1], position - index, "srgb");
}

function thinkingTextColor(level: string | undefined, isDark: boolean): Color {
	const normalized = (level ?? "off").toLowerCase();
	if (isDark) {
		if (normalized === "max" || normalized === "xhigh" || normalized === "high") {
			return rgbColor(224, 242, 254); // sky-100: crisp contrast (>= 5.9:1) even on quantized 256color terminals
		}
		if (normalized === "medium") {
			return rgbColor(254, 240, 138); // yellow-200
		}
		if (normalized === "low") {
			return rgbColor(187, 247, 208); // green-200
		}
		return rgbColor(226, 232, 240); // slate-200
	} else {
		if (normalized === "max" || normalized === "xhigh" || normalized === "high") {
			return rgbColor(3, 105, 161); // sky-700
		}
		if (normalized === "medium") {
			return rgbColor(180, 83, 9); // amber-700
		}
		if (normalized === "low") {
			return rgbColor(21, 128, 61); // green-700
		}
		return rgbColor(71, 85, 105); // slate-600
	}
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
		const now = Date.now();
		const isDark = this.theme.appearance !== "light";
		const baseInk = isDark ? DARK_INK : LIGHT_INK;

		let status = "✓ READY";
		if (st.status === "running") {
			const elapsed = st.startTime ? Math.floor((now - st.startTime) / 1000) : 0;
			const frame = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
			status = `${frame} RUNNING ${elapsed}s${st.activeTool ? ` ${singleLine(st.activeTool)}` : ""}`;
		} else if (st.status === "error") {
			status = "✗ ERROR";
		} else if (st.status === "aborted") {
			status = "■ STOPPED";
		}

		const usage = st.usage ?? { input: 0, output: 0, total: 0, cost: 0 };
		const model = singleLine(st.modelId?.split("/").pop() || "no-model");
		const cwd = singleLine(st.cwd ?? this.context.cwd ?? "?");
		let context = "ctx ?";
		const contextUsage = this.context.getContextUsage();
		if (contextUsage && contextUsage.tokens !== null && contextUsage.contextWindow > 0) {
			context = `ctx ${shortCount(contextUsage.tokens)}/${shortCount(contextUsage.contextWindow)} (${Math.round(contextUsage.percent ?? (contextUsage.tokens / contextUsage.contextWindow) * 100)}%)`;
		}

		const thinkStr = st.thinkingLevel ?? "off";
		const parts = [
			model,
			thinkStr,
			`↑${shortCount(usage.input)}`,
			`↓${shortCount(usage.output)}`,
			`Σ${shortCount(usage.total)}`,
			`$${usage.cost.toFixed(3)}`,
			context,
			singleLine(st.gitBranch ?? "no-git"),
			cwd,
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

		const fullRaw = fit();
		const text = stripTerminalSequences(truncateToWidth(fullRaw, width, "…"));
		const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
		const prefixWidth = visibleWidth(prefix);

		// Calculate think range within fullRaw to apply dedicated semantic color
		const modelIndex = fullRaw.indexOf(` ${model} · `);
		const thinkStart = modelIndex >= 0 ? modelIndex + 1 + visibleWidth(model) + 3 : -1;
		const thinkEnd = thinkStart >= 0 ? thinkStart + visibleWidth(thinkStr) : -1;
		const thinkColor = thinkingTextColor(st.thinkingLevel, isDark);

		let line = "";
		let column = 0;
		for (const { segment } of graphemes.segment(padded)) {
			const segWidth = visibleWidth(segment);
			const bg = rainbowBackground(column, width, isDark, now);
			const isPrefix = column < prefixWidth;
			const isThink = column >= thinkStart && (column + segWidth) <= thinkEnd;
			const fg = isThink ? thinkColor : baseInk;

			line += this.theme.style(segment, {
				fg,
				bg,
				bold: isPrefix || isThink,
			});
			column += segWidth;
		}
		return [line];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	const state: TopBarState = { status: "idle", visible: true };
	let currentContext: ExtensionContext | null = null;
	let tuiInstance: TUI | null = null;
	let bar: TopStatusBarComponent | null = null;
	let stopBranchWatch: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let iconTimer: ReturnType<typeof setInterval> | undefined;
	const activeTools = new Map<string, string>();
	let lastAssistantFailed = false;
	let titleGroup: TabTitleGroup | undefined;
	let groupName: string | undefined = "all"; // 默认自动共享 'all' 分组
	let paneLabel = "cmd";
	let titleStatus: TabStatus = "idle";
	let titleHeartbeat: ReturnType<typeof setInterval> | undefined;
	let lastPublishedTitle = "";

	const writeTitle = (title: string) => {
		lastPublishedTitle = title;
		if (currentContext?.mode === "tui") currentContext.ui.setTitle(title);
	};
	const publishTitle = () => { void titleGroup?.update(titleStatus, paneLabel); };
	const joinTitleGroup = async (name: string) => {
		await titleGroup?.stop();
		titleGroup = new TabTitleGroup({
			onTitle: writeTitle,
			onError: () => currentContext?.ui.notify("ipiui: title synchronization failed; use /tabgroup off and rejoin to retry", "warning"),
		});
		try {
			await titleGroup.start(name, paneLabel, titleStatus);
			groupName = name;
			if (titleHeartbeat) clearInterval(titleHeartbeat);
			titleHeartbeat = setInterval(() => {
				if (lastPublishedTitle && currentContext?.mode === "tui") currentContext.ui.setTitle(lastPublishedTitle);
			}, 1500);
			titleHeartbeat.unref();
		} catch (error) {
			await titleGroup.stop();
			titleGroup = undefined;
			groupName = undefined;
			throw error;
		}
	};

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		if (iconTimer) clearInterval(iconTimer);
		iconTimer = undefined;
	};
	const startIconTimer = () => {
		if (iconTimer) clearInterval(iconTimer);
		// 100ms smooth braille rotation & flowing gradient updates
		iconTimer = setInterval(redraw, 100);
		iconTimer.unref();
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

	pi.on("session_start", async (_event, ctx) => {
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
		ctx.ui.setEditorComponent(undefined);
		titleStatus = state.status === "running" ? "running" : "idle";
		// 自动加入默认群组 'all'
		if (groupName) await joinTitleGroup(groupName);
		if (state.status === "running") startIconTimer();
		redraw();
	});

	pi.on("agent_start", (_event, ctx) => {
		sync(ctx);
		state.status = "running";
		titleStatus = "running";
		publishTitle();
		state.startTime ??= Date.now();
		state.errorMessage = undefined;
		lastAssistantFailed = false;
		stopTimer();
		timer = setInterval(redraw, 1000);
		startIconTimer();
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
		titleStatus = event.aborted ? "aborted" : lastAssistantFailed ? "error" : "done";
		publishTitle();
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
	pi.on("session_shutdown", async () => {
		await titleGroup?.stop();
		if (titleHeartbeat) clearInterval(titleHeartbeat);
		titleHeartbeat = undefined;
		titleGroup = undefined;
		stopTimer();
		stopBranchWatch?.();
		stopBranchWatch = undefined;
		currentContext = null;
		bar = null;
		tuiInstance = null;
	});
	pi.registerCommand("tabgroup", {
		description: "Join or switch split-pane title group (/tabgroup [NAME|off])",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			sync(ctx);
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(groupName ? `Title group: ${groupName}; name: ${paneLabel}` : "Auto-grouped: all (use /tabgroup NAME or /tabgroup off)", "info");
				return;
			}
			if (name === "off") {
				await titleGroup?.stop();
				if (titleHeartbeat) clearInterval(titleHeartbeat);
				titleHeartbeat = undefined;
				titleGroup = undefined;
				groupName = undefined;
				lastPublishedTitle = "";
				ctx.ui.setTitle("pi");
				ctx.ui.notify("Title group disabled", "info");
				return;
			}
			if (name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) {
				ctx.ui.notify("Group must be 1–64 characters with no control characters", "warning");
				return;
			}
			try {
				await joinTitleGroup(name);
				ctx.ui.notify(`Joined title group: ${name}`, "info");
			} catch {
				ctx.ui.notify("Could not join title group; check temporary-directory access", "error");
			}
		},
	});
	pi.registerCommand("tabname", {
		description: "Set this Pi member's short title label (/tabname api)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") return;
			sync(ctx);
			if (!args.trim()) {
				ctx.ui.notify(`Title name: ${paneLabel}; use /tabname NAME`, "info");
				return;
			}
			paneLabel = cleanTitleLabel(args);
			publishTitle();
			ctx.ui.notify(`Title name: ${paneLabel}`, "info");
		},
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
