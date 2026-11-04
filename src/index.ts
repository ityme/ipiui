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

export type StatusBarStyle = "pills" | "classic" | "border";

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
	style: StatusBarStyle;
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

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DARK_CANVAS = rgbColor(15, 19, 26);
const LIGHT_CANVAS = rgbColor(248, 250, 252);

interface SemanticColorSet {
	fg: Color;
	tint: Color;
}

function getSemanticPalette(isDark: boolean) {
	if (isDark) {
		return {
			ready: { fg: rgbColor(74, 222, 128), tint: rgbColor(34, 197, 94) },
			running: { fg: rgbColor(251, 191, 36), tint: rgbColor(245, 158, 11) },
			error: { fg: rgbColor(248, 113, 113), tint: rgbColor(239, 68, 68) },
			aborted: { fg: rgbColor(251, 146, 60), tint: rgbColor(249, 115, 22) },
			model: { fg: rgbColor(56, 189, 248), tint: rgbColor(14, 165, 233) },
			thinkHigh: { fg: rgbColor(224, 242, 254), tint: rgbColor(56, 189, 248) },
			thinkMed: { fg: rgbColor(254, 240, 138), tint: rgbColor(234, 179, 8) },
			thinkLow: { fg: rgbColor(187, 247, 208), tint: rgbColor(34, 197, 94) },
			thinkOff: { fg: rgbColor(148, 163, 184), tint: rgbColor(100, 116, 139) },
			project: { fg: rgbColor(192, 132, 252), tint: rgbColor(168, 85, 247) },
			tokens: { fg: rgbColor(203, 213, 225), tint: rgbColor(148, 163, 184) },
			cost: { fg: rgbColor(52, 211, 153), tint: rgbColor(16, 185, 129) },
			ctx: { fg: rgbColor(148, 163, 184), tint: rgbColor(100, 116, 139) },
			separator: rgbColor(71, 85, 105),
			borderLine: rgbColor(51, 65, 85),
		};
	} else {
		return {
			ready: { fg: rgbColor(22, 101, 52), tint: rgbColor(187, 247, 208) },
			running: { fg: rgbColor(146, 64, 14), tint: rgbColor(254, 240, 138) },
			error: { fg: rgbColor(153, 27, 27), tint: rgbColor(254, 202, 202) },
			aborted: { fg: rgbColor(154, 52, 18), tint: rgbColor(254, 215, 170) },
			model: { fg: rgbColor(3, 105, 161), tint: rgbColor(186, 230, 253) },
			thinkHigh: { fg: rgbColor(3, 105, 161), tint: rgbColor(186, 230, 253) },
			thinkMed: { fg: rgbColor(133, 77, 14), tint: rgbColor(254, 240, 138) },
			thinkLow: { fg: rgbColor(22, 101, 52), tint: rgbColor(187, 247, 208) },
			thinkOff: { fg: rgbColor(71, 85, 105), tint: rgbColor(226, 232, 240) },
			project: { fg: rgbColor(107, 33, 168), tint: rgbColor(233, 213, 255) },
			tokens: { fg: rgbColor(51, 65, 85), tint: rgbColor(226, 232, 240) },
			cost: { fg: rgbColor(6, 95, 70), tint: rgbColor(167, 243, 208) },
			ctx: { fg: rgbColor(71, 85, 105), tint: rgbColor(226, 232, 240) },
			separator: rgbColor(203, 213, 225),
			borderLine: rgbColor(226, 232, 240),
		};
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
		const palette = getSemanticPalette(isDark);
		const canvas = isDark ? DARK_CANVAS : LIGHT_CANVAS;

		// 1. Status icon & text
		let statusIcon = "✓";
		let statusLabel = "";
		let statusColors: SemanticColorSet = palette.ready;
		if (st.status === "running") {
			const elapsed = st.startTime ? Math.floor((now - st.startTime) / 1000) : 0;
			const frame = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
			statusIcon = frame;
			statusLabel = `${elapsed}s${st.activeTool ? ` ${singleLine(st.activeTool)}` : ""}`;
			statusColors = palette.running;
		} else if (st.status === "error") {
			statusIcon = "✗";
			statusColors = palette.error;
		} else if (st.status === "aborted") {
			statusIcon = "■";
			statusColors = palette.aborted;
		}

		// 2. Data chunks
		const usage = st.usage ?? { input: 0, output: 0, total: 0, cost: 0 };
		const model = singleLine(st.modelId?.split("/").pop() || "no-model");
		const cwdRaw = st.cwd ?? this.context.cwd ?? "?";
		const cwdBasename = singleLine(cwdRaw.split(/[\\/]/).filter(Boolean).pop() || cwdRaw);
		const branch = singleLine(st.gitBranch ?? "");
		const projectWithBranch = branch ? `${cwdBasename} (${branch})` : cwdBasename;

		let context = "ctx ?";
		const contextUsage = this.context.getContextUsage();
		if (contextUsage && contextUsage.tokens !== null && contextUsage.contextWindow > 0) {
			context = `ctx ${shortCount(contextUsage.tokens)}/${shortCount(contextUsage.contextWindow)} (${Math.round(contextUsage.percent ?? (contextUsage.tokens / contextUsage.contextWindow) * 100)}%)`;
		}

		// 3. Thinking level semantic color and sparkle icon (✦ replaces 🧠)
		const thinkLevel = (st.thinkingLevel ?? "off").toLowerCase();
		let thinkColors: SemanticColorSet = palette.thinkOff;
		if (thinkLevel === "high" || thinkLevel === "max" || thinkLevel === "xhigh") {
			thinkColors = palette.thinkHigh;
		} else if (thinkLevel === "medium") {
			thinkColors = palette.thinkMed;
		} else if (thinkLevel === "low") {
			thinkColors = palette.thinkLow;
		}
		const thinkText = `✦ ${st.thinkingLevel ?? "off"}`;

		// 4. Assemble structured segments
		interface Chunk {
			id: string;
			text: string;
			colors: SemanticColorSet;
			bold?: boolean;
		}

		const statusText = statusLabel ? `${statusIcon} ${statusLabel}` : statusIcon;
		const chunks: Chunk[] = [
			{ id: "status", text: statusText, colors: statusColors, bold: true },
			{ id: "model", text: model, colors: palette.model, bold: true },
			{ id: "think", text: thinkText, colors: thinkColors, bold: true },
			{ id: "project", text: `📁 ${projectWithBranch}`, colors: palette.project },
			{ id: "tokens", text: `↑${shortCount(usage.input)} ↓${shortCount(usage.output)} Σ${shortCount(usage.total)}`, colors: palette.tokens },
			{ id: "cost", text: `$${usage.cost.toFixed(3)}`, colors: palette.cost },
			{ id: "ctx", text: context, colors: palette.ctx },
		];

		if (st.status === "error" && st.errorMessage) {
			chunks.push({ id: "error", text: `Reason: ${singleLine(st.errorMessage)}`, colors: palette.error });
		}

		// Truncate model on narrow widths
		if (width < 90) {
			const m = chunks.find(c => c.id === "model");
			if (m) m.text = truncateToWidth(m.text, Math.max(6, Math.min(16, Math.floor(width * 0.18))), "…");
		}

		const style = st.style || "pills";

		// --- Style 4: Discrete Pills (Default) ---
		if (style === "pills") {
			let line = "";
			let currentWidth = 0;
			const tintRatio = isDark ? 0.20 : 0.25;

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const rawSeg = ` ${chunk.text} `;
				const segVis = visibleWidth(rawSeg);
				const neededSpace = currentWidth === 0 ? segVis : segVis + 1; // 1 space gap

				if (currentWidth > 0 && currentWidth + neededSpace > width) {
					// Drop lower-priority details if width is tight
					if (i >= 4) break;
				}

				if (currentWidth > 0) {
					line += " ";
					currentWidth += 1;
				}

				const pillBg = mixColors(canvas, chunk.colors.tint, tintRatio, "srgb");
				line += this.theme.style(rawSeg, {
					fg: chunk.colors.fg,
					bg: pillBg,
					bold: chunk.bold ?? false,
				});
				currentWidth += segVis;
			}

			// Trailing border fill: reset background so terminal background applies cleanly
			if (currentWidth < width) {
				const fillCount = width - currentWidth;
				line += "\x1b[49m" + this.theme.style("─".repeat(fillCount), {
					fg: palette.borderLine,
				});
			}

			return [truncateToWidth(line, width)];
		}

		// --- Style 2: Pure Border Accent (Left indicator line + Clean colored text) ---
		if (style === "border") {
			let line = this.theme.style("▌ ", { fg: statusColors.fg, bold: true });
			let currentWidth = 2;

			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const rawSeg = chunk.text;
				const segVis = visibleWidth(rawSeg);
				const neededSpace = currentWidth === 2 ? segVis : segVis + 3; // " · "

				if (currentWidth > 2 && currentWidth + neededSpace > width) {
					if (i >= 4) break;
				}

				if (currentWidth > 2) {
					line += this.theme.style(" · ", { fg: palette.separator });
					currentWidth += 3;
				}

				line += this.theme.style(rawSeg, {
					fg: chunk.colors.fg,
					bold: chunk.bold ?? false,
				});
				currentWidth += segVis;
			}

			if (currentWidth < width) {
				const fillCount = width - currentWidth;
				line += "\x1b[49m" + this.theme.style("─".repeat(fillCount), { fg: palette.borderLine });
			}

			return [truncateToWidth(line, width)];
		}

		// --- Style 1: Pure Classic (No background, semantic colored text) ---
		let line = this.theme.style("──── ", { fg: palette.borderLine });
		let currentWidth = 5;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i]!;
			const rawSeg = chunk.text;
			const segVis = visibleWidth(rawSeg);
			const neededSpace = currentWidth === 5 ? segVis : segVis + 3; // " · "

			if (currentWidth > 5 && currentWidth + neededSpace > width) {
				if (i >= 4) break;
			}

			if (currentWidth > 5) {
				line += this.theme.style(" · ", { fg: palette.separator });
				currentWidth += 3;
			}

			line += this.theme.style(rawSeg, {
				fg: chunk.colors.fg,
				bold: chunk.bold ?? false,
			});
			currentWidth += segVis;
		}

		if (currentWidth < width) {
			const fillCount = width - currentWidth;
			line += "\x1b[49m" + this.theme.style("─".repeat(fillCount), { fg: palette.borderLine });
		}

		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	const state: TopBarState = {
		status: "idle",
		visible: true,
		style: "pills", // 默认方案 4 (Discrete Pills)
	};
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
	let tabGroupDirectoryRoot: string | undefined = process.env.IPIUI_TEST_GROUP_ROOT;

	const writeTitle = (title: string) => {
		lastPublishedTitle = title;
		if (currentContext?.mode === "tui") currentContext.ui.setTitle(title);
	};
	const publishTitle = () => { void titleGroup?.update(titleStatus, paneLabel); };
	const joinTitleGroup = async (name: string) => {
		await titleGroup?.stop();
		titleGroup = new TabTitleGroup({
			root: tabGroupDirectoryRoot,
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
		// 100ms smooth braille rotation updates
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
		if (process.env.IPIUI_TEST_GROUP_ROOT) {
			tabGroupDirectoryRoot = process.env.IPIUI_TEST_GROUP_ROOT;
		}
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
		description: "Toggle or change status bar style (/topbar [on|off|toggle|pills|classic|border])",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (["pills", "classic", "border"].includes(action)) {
				state.style = action as StatusBarStyle;
				state.visible = true;
				ctx.ui.notify(`Status bar style: ${state.style}`, "info");
				redraw();
				return;
			}
			if (["", "on", "off", "toggle"].includes(action)) {
				state.visible = action === "on" ? true : action === "off" ? false : !state.visible;
				ctx.ui.notify(`Status bar: ${state.visible ? "ON" : "OFF"} (${state.style})`, "info");
				redraw();
				return;
			}
			ctx.ui.notify("Usage: /topbar [on|off|toggle|pills|classic|border]", "warning");
		},
	});
}
