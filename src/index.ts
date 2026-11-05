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

export type StatusBarStyle = "rainbow_blocks" | "classic" | "border";

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

// 经典彩虹色谱
const RAW_RAINBOW = [
	rgbColor(255, 110, 130), // soft red/coral
	rgbColor(255, 175, 80),  // amber/orange
	rgbColor(245, 220, 80),  // yellow
	rgbColor(80, 220, 140),  // green/emerald
	rgbColor(60, 200, 245),  // sky/cyan
	rgbColor(140, 150, 250), // blue/indigo
	rgbColor(215, 130, 240), // purple/violet
];

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 每个字母赋予动态彩虹渐变色
function rainbowChars(text: string, timeMs = 0): { ch: string; col: Color }[] {
	const graphemes = [...GRAPHEME_SEGMENTER.segment(text)].map(s => s.segment);
	const total = graphemes.length;
	const shift = (timeMs / 4000) % 1;
	return graphemes.map((ch, i) => {
		const pos = (((i / Math.max(1, total - 1)) + shift) % 1) * (RAW_RAINBOW.length - 1);
		const idx = Math.min(RAW_RAINBOW.length - 2, Math.floor(pos));
		const col = mixColors(RAW_RAINBOW[idx], RAW_RAINBOW[idx + 1], pos - idx, "srgb");
		return { ch, col };
	});
}

function getRainbowBlockPalette(isDark: boolean) {
	if (isDark) {
		return {
			canvasBg: rgbColor(9, 11, 16),
			
			// 模块 1: 状态胶囊背景
			bgStatusReady: mixColors(DARK_CANVAS, rgbColor(16, 185, 129), 0.20, "srgb"),
			bgStatusRun: mixColors(DARK_CANVAS, rgbColor(245, 158, 11), 0.22, "srgb"),
			bgStatusErr: mixColors(DARK_CANVAS, rgbColor(239, 68, 68), 0.22, "srgb"),
			bgStatusStp: mixColors(DARK_CANVAS, rgbColor(249, 115, 22), 0.20, "srgb"),
			fgStatusReady: rgbColor(74, 222, 128),
			fgStatusRun: rgbColor(251, 191, 36),
			fgStatusErr: rgbColor(248, 113, 113),
			fgStatusStp: rgbColor(251, 146, 60),

			// 模块 2: 项目与分支 (同模块同背景色: 靛青微光)
			bgProjBranch: mixColors(DARK_CANVAS, rgbColor(14, 165, 233), 0.18, "srgb"),
			fgProject: rgbColor(250, 204, 21), // 黄色
			fgBranch: rgbColor(56, 189, 248),  // 青色

			// 模块 3: 模型与思考 (深紫罗兰微光底，字母全彩虹渐变)
			bgModelThink: mixColors(DARK_CANVAS, rgbColor(168, 85, 247), 0.20, "srgb"),

			// 模块 4: 遥测数据 (翡翠薄荷微光底)
			bgTelemetry: mixColors(DARK_CANVAS, rgbColor(34, 197, 94), 0.18, "srgb"),
			fgTokenIn: rgbColor(96, 165, 250),
			fgTokenOut: rgbColor(52, 211, 153),
			fgCost: rgbColor(251, 191, 36),

			// 模块 5: CTX 进度 (深石板灰微光底)
			bgCtx: mixColors(DARK_CANVAS, rgbColor(99, 102, 241), 0.18, "srgb"),
			ctxLow: rgbColor(45, 212, 191),
			ctxMed: rgbColor(251, 191, 36),
			ctxHigh: rgbColor(249, 115, 22),
			ctxTrack: rgbColor(148, 163, 184),
			ctxText: rgbColor(203, 213, 225),

			bracketColor: rgbColor(148, 163, 184),
		};
	} else {
		return {
			canvasBg: rgbColor(248, 250, 252),
			bgStatusReady: mixColors(LIGHT_CANVAS, rgbColor(187, 247, 208), 0.25, "srgb"),
			bgStatusRun: mixColors(LIGHT_CANVAS, rgbColor(254, 240, 138), 0.25, "srgb"),
			bgStatusErr: mixColors(LIGHT_CANVAS, rgbColor(254, 202, 202), 0.25, "srgb"),
			bgStatusStp: mixColors(LIGHT_CANVAS, rgbColor(254, 215, 170), 0.25, "srgb"),
			fgStatusReady: rgbColor(22, 101, 52),
			fgStatusRun: rgbColor(146, 64, 14),
			fgStatusErr: rgbColor(153, 27, 27),
			fgStatusStp: rgbColor(154, 52, 18),

			bgProjBranch: mixColors(LIGHT_CANVAS, rgbColor(224, 242, 254), 0.25, "srgb"),
			fgProject: rgbColor(161, 98, 7),
			fgBranch: rgbColor(2, 132, 199),

			bgModelThink: mixColors(LIGHT_CANVAS, rgbColor(243, 232, 255), 0.25, "srgb"),

			bgTelemetry: mixColors(LIGHT_CANVAS, rgbColor(209, 250, 229), 0.25, "srgb"),
			fgTokenIn: rgbColor(37, 99, 235),
			fgTokenOut: rgbColor(5, 150, 105),
			fgCost: rgbColor(180, 83, 9),

			bgCtx: mixColors(LIGHT_CANVAS, rgbColor(224, 231, 255), 0.25, "srgb"),
			ctxLow: rgbColor(13, 148, 136),
			ctxMed: rgbColor(180, 83, 9),
			ctxHigh: rgbColor(194, 65, 12),
			ctxTrack: rgbColor(148, 163, 184),
			ctxText: rgbColor(51, 65, 85),

			bracketColor: rgbColor(100, 116, 139),
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

function shortContextWindow(value: number): string {
	return value >= 1_000_000 ? `${Math.round(value / 1_000_000)}M` : shortCount(value);
}

function formatDuration(sec: number): string {
	if (!sec || sec <= 0) return "";
	const s = sec % 60;
	const m = Math.floor(sec / 60) % 60;
	const h = Math.floor(sec / 3600);
	if (h > 0) {
		return `${h}h${m > 0 || s > 0 ? `${m}m` : ""}${s > 0 ? `${s}s` : ""}`;
	}
	if (m > 0) {
		return `${m}m${s > 0 ? `${s}s` : ""}`;
	}
	return `${s}s`;
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
		const p = getRainbowBlockPalette(isDark);

		// 1. Status 徽章（3 字符缩写，默认占位 100h32m10s，自动升级单位，无耗时不显示）
		let statusIcon = "⠿";
		let statusLabel = "RDY";
		let statusBg = p.bgStatusReady;
		let statusFg = p.fgStatusReady;
		let elapsedSec = 0;

		if (st.status === "running") {
			elapsedSec = st.startTime ? Math.floor((now - st.startTime) / 1000) : 0;
			const frame = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
			statusIcon = frame;
			statusLabel = "RUN";
			statusBg = p.bgStatusRun;
			statusFg = p.fgStatusRun;
		} else if (st.status === "error") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "✗";
			statusLabel = "ERR";
			statusBg = p.bgStatusErr;
			statusFg = p.fgStatusErr;
		} else if (st.status === "aborted") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "■";
			statusLabel = "STP";
			statusBg = p.bgStatusStp;
			statusFg = p.fgStatusStp;
		} else {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
		}

		// 无耗时不显示，有耗时自动格式化 (如 54s, 3m7s, 100h32m10s)
		const durStr = formatDuration(elapsedSec);
		const statusCoreText = durStr ? `${statusIcon} ${statusLabel} ${durStr}` : `${statusIcon} ${statusLabel}`;
		// 默认以 "100h32m10s" (10 字符) 占位保证宽度定长稳定
		const MAX_TIME_WIDTH = 10;
		const TARGET_INNER_WIDTH = 1 + 1 + 3 + 1 + MAX_TIME_WIDTH; // 16 列
		const curCoreVis = visibleWidth(statusCoreText);
		const statusPadded = statusCoreText + " ".repeat(Math.max(0, TARGET_INNER_WIDTH - curCoreVis));

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

		// 4. 五大独立模块构建 (带方括号 [] 区分，同模块同背景色)

		// 模块 1: [■ STP 187s]
		const m1BracketOpen = this.theme.style("[", { fg: p.bracketColor, bg: statusBg, bold: true });
		const m1BracketClose = this.theme.style("]", { fg: p.bracketColor, bg: statusBg, bold: true });
		const m1Content = this.theme.style(statusPadded, { fg: statusFg, bg: statusBg, bold: true });
		const m1Pill = `${m1BracketOpen}${m1Content}${m1BracketClose}`;
		const m1Vis = 1 + visibleWidth(statusPadded) + 1;

		// 模块 2: [📁 ipiui(黄色) dev(青色)] (同模块同背景色)
		const m2BracketOpen = this.theme.style("[", { fg: p.bracketColor, bg: p.bgProjBranch, bold: true });
		const m2BracketClose = this.theme.style("]", { fg: p.bracketColor, bg: p.bgProjBranch, bold: true });
		const m2Proj = this.theme.style(`📁 ${cwdBasename}`, { fg: p.fgProject, bg: p.bgProjBranch, bold: true });
		const m2Branch = this.theme.style(`${branch}`, { fg: p.fgBranch, bg: p.bgProjBranch, bold: true });
		const m2Pill = `${m2BracketOpen}${m2Proj} ${m2Branch}${m2BracketClose}`;
		const m2Vis = 1 + visibleWidth(`📁 ${cwdBasename}`) + 1 + visibleWidth(`${branch}`) + 1;

		const rawThink = (st.thinkingLevel ?? "med").toLowerCase();
		const thinkFull = rawThink === "med" ? "medium" : rawThink;
		const m3RawText = `[🤖 ${model} · ${thinkFull}]`;
		const m4RawText = `[⬆️${shortCount(usage.input)} ⬇️${shortCount(usage.output)} 💰 ${usage.cost.toFixed(2)}¥]`;
		const m5RawText = `[CTX ${"━".repeat(ctxFilled)}${"─".repeat(ctxEmpty)} ${ctxPercent}% ${shortCount(ctxTokens)}/${shortContextWindow(ctxWindow)}]`;

		// 左右组装：
		// 左侧: 模块 1 (状态)
		const leftStr = m1Pill;
		const leftVis = m1Vis;

		// 右侧: 模块 2 (项目分支) + 模块 3 (模型彩虹思考) + 模块 4 (遥测) + 模块 5 (CTX)
		const rightItems: { id: string; pill: string; vis: number; priority: number; bg?: Color }[] = [
			{ id: "proj_branch", pill: m2Pill, vis: m2Vis, priority: 4 },
			{ id: "model_think", pill: m3RawText, vis: visibleWidth(m3RawText), priority: 3, bg: p.bgModelThink },
			{ id: "telemetry", pill: m4RawText, vis: visibleWidth(m4RawText), priority: 2, bg: p.bgTelemetry },
			{ id: "ctx", pill: m5RawText, vis: visibleWidth(m5RawText), priority: 1, bg: p.bgCtx },
		];

		const activeSet = new Set<string>();
		let rightVis = 0;
		for (const item of [...rightItems].sort((a, b) => b.priority - a.priority)) {
			const gap = activeSet.size > 0 ? 1 : 0;
			if (leftVis + rightVis + item.vis + gap + 2 <= width) {
				activeSet.add(item.id);
				rightVis += item.vis + gap;
			}
		}

		// 右侧保持严格视觉顺序：模块 2 -> 模块 3 -> 模块 4 -> 模块 5
		const visibleItems = rightItems.filter(item => activeSet.has(item.id));
		// Build one color band across all visible telemetry blocks, including brackets and gaps.
		const band = rainbowChars(visibleItems.filter(item => item.bg !== undefined).map(item => item.pill).join(" "), now);
		let bandIndex = 0;
		const orderedRight = visibleItems.map(item => {
			if (item.bg === undefined) return item.pill;
			const letters = [...GRAPHEME_SEGMENTER.segment(item.pill)];
			const text = letters.map(() => {
				const { ch, col } = band[bandIndex++];
				return this.theme.style(ch, { fg: col, bg: item.bg, bold: true });
			}).join("");
			bandIndex++; // The inter-block space also occupies a position in the shared band.
			return text;
		}).join(" ");
		const totalVis = leftVis + (activeSet.size > 0 ? rightVis : 0);

		if (totalVis >= width) {
			return [truncateToWidth(`${leftStr} ${orderedRight}`, width)];
		}

		// 中间自适应空格留白
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
		style: "rainbow_blocks",
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
