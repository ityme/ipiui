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

export type StatusBarStyle = "split" | "pills" | "classic" | "border";

export interface TopBarState {
	status: "idle" | "running" | "error" | "aborted";
	errorMessage?: string;
	startTime?: number;
	durationMs?: number;
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
		totals.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		totals.cost += usage.cost.total;
	}
	return totals;
}

const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const DARK_CANVAS = rgbColor(9, 11, 16);
const LIGHT_CANVAS = rgbColor(248, 250, 252);

interface SemanticColorSet {
	fg: Color;
	tint: Color;
}

function getSemanticPalette(isDark: boolean) {
	if (isDark) {
		return {
			canvasBg: rgbColor(9, 11, 16),
			running: { fg: rgbColor(52, 211, 153), tint: rgbColor(16, 185, 129) },
			ready: { fg: rgbColor(148, 163, 184), tint: rgbColor(45, 55, 75) },
			error: { fg: rgbColor(248, 113, 113), tint: rgbColor(239, 68, 68) },
			aborted: { fg: rgbColor(251, 146, 60), tint: rgbColor(249, 115, 22) },
			
			project: { fg: rgbColor(241, 245, 249), tint: rgbColor(38, 48, 68) },
			branch: { fg: rgbColor(56, 189, 248), tint: rgbColor(14, 165, 233) },

			model: { fg: rgbColor(233, 213, 255), tint: rgbColor(168, 85, 247) },
			thinkTag: { fg: rgbColor(129, 140, 248), bg: rgbColor(35, 42, 70) },

			tokenIn: rgbColor(96, 165, 250),
			tokenOut: rgbColor(52, 211, 153),
			tokenCost: rgbColor(251, 191, 36),
			telemetryBg: rgbColor(30, 38, 55),

			ctxLow: rgbColor(45, 212, 191),
			ctxMed: rgbColor(251, 191, 36),
			ctxHigh: rgbColor(249, 115, 22),
			ctxTrack: rgbColor(148, 163, 184),

			borderLine: rgbColor(30, 38, 56),
		};
	} else {
		return {
			canvasBg: rgbColor(248, 250, 252),
			running: { fg: rgbColor(5, 150, 105), tint: rgbColor(209, 250, 229) },
			ready: { fg: rgbColor(71, 85, 105), tint: rgbColor(226, 232, 240) },
			error: { fg: rgbColor(220, 38, 38), tint: rgbColor(254, 226, 226) },
			aborted: { fg: rgbColor(217, 119, 6), tint: rgbColor(254, 243, 199) },

			project: { fg: rgbColor(15, 23, 42), tint: rgbColor(203, 213, 225) },
			branch: { fg: rgbColor(2, 132, 199), tint: rgbColor(186, 230, 253) },

			model: { fg: rgbColor(107, 33, 168), tint: rgbColor(233, 213, 255) },
			thinkTag: { fg: rgbColor(67, 56, 202), bg: rgbColor(224, 231, 255) },

			tokenIn: rgbColor(37, 99, 235),
			tokenOut: rgbColor(5, 150, 105),
			tokenCost: rgbColor(180, 83, 9),
			telemetryBg: rgbColor(226, 232, 240),

			ctxLow: rgbColor(13, 148, 136),
			ctxMed: rgbColor(180, 83, 9),
			ctxHigh: rgbColor(194, 65, 12),
			ctxTrack: rgbColor(203, 213, 225),

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

		// 1. Status 徽章（定长 + 带秒数单位 s）
		let statusIcon = "✓";
		let statusLabel = "READY";
		let statusColors: SemanticColorSet = palette.ready;
		let elapsedSec = 0;

		if (st.status === "running") {
			elapsedSec = st.startTime ? Math.floor((now - st.startTime) / 1000) : 0;
			const frame = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
			statusIcon = frame;
			statusLabel = st.activeTool ? `RUNNING (${singleLine(st.activeTool)})` : "RUNNING";
			statusColors = palette.running;
		} else if (st.status === "error") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "✗";
			statusLabel = "ERROR";
			statusColors = palette.error;
		} else if (st.status === "aborted") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "■";
			statusLabel = "STOPPED";
			statusColors = palette.aborted;
		} else {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
		}

		// 定长状态内容: 统一补空格至宽度保持一致
		const statusCore = ` ${statusIcon} ${statusLabel} ${elapsedSec}s ● `;
		const TARGET_STATUS_VIS_WIDTH = Math.max(18, visibleWidth(statusCore));
		const curStatusVis = visibleWidth(statusCore);
		const statusPaddedText = statusCore + " ".repeat(Math.max(0, TARGET_STATUS_VIS_WIDTH - curStatusVis));

		// 2. 项目与分支
		const usage = st.usage ?? { input: 0, output: 0, total: 0, cost: 0 };
		const model = singleLine(st.modelId?.split("/").pop() || "no-model");
		const cwdRaw = st.cwd ?? this.context.cwd ?? "?";
		const cwdBasename = singleLine(cwdRaw.split(/[\\/]/).filter(Boolean).pop() || cwdRaw);
		const branch = singleLine(st.gitBranch ?? "dev");

		// 3. 上下文进度与比例
		let ctxTokens = 0;
		let ctxWindow = 1048576;
		let ctxPercent = 0;
		const contextUsage = this.context.getContextUsage();
		if (contextUsage) {
			if (contextUsage.contextWindow > 0) ctxWindow = contextUsage.contextWindow;
			if (contextUsage.tokens !== null) {
				ctxTokens = contextUsage.tokens;
				ctxPercent = Math.round(contextUsage.percent ?? (ctxTokens / ctxWindow) * 100);
			}
		}

		// 上下文进度条 (8个字符，高压变色)
		const ctxTotalBlocks = 8;
		const ctxFilled = Math.max(0, Math.min(ctxTotalBlocks, Math.round((ctxPercent / 100) * ctxTotalBlocks)));
		const ctxEmpty = ctxTotalBlocks - ctxFilled;
		const ctxColor = ctxPercent > 80 ? palette.ctxHigh : ctxPercent > 60 ? palette.ctxMed : palette.ctxLow;

		// 4. 构建胶囊（加深底色 32%~36% 明显可见）
		const pillBg = (tint: Color) => mixColors(canvas, tint, isDark ? 0.34 : 0.30, "srgb");

		// 左侧模块
		// (A) 状态胶囊
		const statusPill = this.theme.style(statusPaddedText, {
			fg: statusColors.fg,
			bg: pillBg(statusColors.tint),
			bold: true,
		});
		const statusVis = visibleWidth(statusPaddedText);

		// (B) 项目胶囊: [ 📁 ipiui ]
		const projectPill = this.theme.style(` 📁 ${cwdBasename} `, {
			fg: palette.project.fg,
			bg: pillBg(palette.project.tint),
			bold: true,
		});
		const projectVis = visibleWidth(` 📁 ${cwdBasename} `);

		// (C) 分支胶囊: [  dev ]
		const branchPill = this.theme.style(`  ${branch} `, {
			fg: palette.branch.fg,
			bg: pillBg(palette.branch.tint),
			bold: false,
		});
		const branchVis = visibleWidth(`  ${branch} `);

		// 右侧模块
		// (D) 模型 + 思考复合胶囊: [ 🤖 gemini-3.8-flash med ]
		const thinkLevelStr = (st.thinkingLevel ?? "med").toLowerCase();
		const thinkShort = thinkLevelStr === "medium" ? "med" : thinkLevelStr;
		const modelPart = this.theme.style(` 🤖 ${model} `, {
			fg: palette.model.fg,
			bg: pillBg(palette.model.tint),
			bold: true,
		});
		const thinkPart = this.theme.style(` ${thinkShort} `, {
			fg: palette.thinkTag.fg,
			bg: palette.thinkTag.bg,
			bold: true,
		});
		const modelGroupPill = `${modelPart}${thinkPart} `;
		const modelGroupVis = visibleWidth(` 🤖 ${model}  ${thinkShort}  `);

		// (E) 吞吐遥测胶囊: [ ⬆️ 35.2M ⬇️ 225k 💰 37.99¥ ] (去除了Σ，纯空格分隔，金额后置¥，前置💰)
		const inRaw = `⬆️ ${shortCount(usage.input)}`;
		const outRaw = `⬇️ ${shortCount(usage.output)}`;
		const costRaw = `💰 ${usage.cost.toFixed(2)}¥`;
		const teleBg = pillBg(palette.telemetryBg);

		const telemetryPill =
			this.theme.style(" ", { bg: teleBg }) +
			this.theme.style(inRaw, { fg: palette.tokenIn, bg: teleBg }) +
			this.theme.style("  ", { bg: teleBg }) +
			this.theme.style(outRaw, { fg: palette.tokenOut, bg: teleBg }) +
			this.theme.style("  ", { bg: teleBg }) +
			this.theme.style(costRaw, { fg: palette.tokenCost, bg: teleBg, bold: true }) +
			this.theme.style(" ", { bg: teleBg });
		const teleVis = visibleWidth(` ${inRaw}  ${outRaw}  ${costRaw} `);

		// (F) CTX 进度胶囊: [ CTX ━━━━──── 51% 539k/1M ]
		const ctxTitle = this.theme.style(" CTX ", { fg: palette.ready.fg, bg: teleBg, bold: true });
		const ctxBarFilled = this.theme.style("━".repeat(ctxFilled), { fg: ctxColor, bg: teleBg, bold: true });
		const ctxBarEmpty = this.theme.style("─".repeat(ctxEmpty), { fg: palette.ctxTrack, bg: teleBg });
		const ctxNum = this.theme.style(` ${ctxPercent}% `, { fg: ctxColor, bg: teleBg, bold: true });
		const ctxRatio = this.theme.style(`${shortCount(ctxTokens)}/${shortCount(ctxWindow)} `, { fg: palette.ready.fg, bg: teleBg });
		const ctxPill = `${ctxTitle}${ctxBarFilled}${ctxBarEmpty}${ctxNum}${ctxRatio}`;
		const ctxVis = visibleWidth(` CTX ${"━".repeat(ctxFilled)}${"─".repeat(ctxEmpty)} ${ctxPercent}% ${shortCount(ctxTokens)}/${shortCount(ctxWindow)} `);

		// 左右组装
		const leftStr = `${statusPill} ${projectPill} ${branchPill}`;
		const leftVis = statusVis + 1 + projectVis + 1 + branchVis;

		// 右侧模块优先级过滤
		const rightItems: { pill: string; vis: number; priority: number }[] = [
			{ pill: ctxPill, vis: ctxVis, priority: 3 },
			{ pill: telemetryPill, vis: teleVis, priority: 2 },
			{ pill: modelGroupPill, vis: modelGroupVis, priority: 1 },
		];

		const activeRight: string[] = [];
		let rightVis = 0;
		for (const item of [...rightItems].sort((a, b) => a.priority - b.priority)) {
			const spaceNeeded = leftVis + rightVis + item.vis + 2;
			if (spaceNeeded <= width) {
				activeRight.push(item.pill);
				rightVis += item.vis + (activeRight.length > 1 ? 1 : 0);
			}
		}

		const orderedRight = rightItems.filter(i => activeRight.includes(i.pill)).map(i => i.pill).reverse().join(" ");
		const totalVis = leftVis + rightVis;

		if (totalVis >= width) {
			return [truncateToWidth(`${leftStr} ${orderedRight}`, width)];
		}

		// 中间留白自适应
		const middleSpaces = Math.max(1, width - totalVis);
		const fullLine = `${leftStr}\x1b[49m${" ".repeat(middleSpaces)}${orderedRight}\x1b[49m`;

		return [truncateToWidth(fullLine, width)];
	}

	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	const state: TopBarState = {
		status: "idle",
		visible: true,
		style: "split",
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
	let groupName: string | undefined = "all";
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
		if (state.startTime) {
			state.durationMs = Date.now() - state.startTime;
		}
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
		description: "Toggle or change status bar (/topbar [on|off|toggle])",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (["", "on", "off", "toggle"].includes(action)) {
				state.visible = action === "on" ? true : action === "off" ? false : !state.visible;
				ctx.ui.notify(`Status bar: ${state.visible ? "ON" : "OFF"}`, "info");
				redraw();
				return;
			}
			ctx.ui.notify("Usage: /topbar [on|off|toggle]", "warning");
		},
	});
}
