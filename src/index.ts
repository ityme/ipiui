import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { TabTitleGroup, cleanTitleLabel, type TabStatus } from "./tab-title.js";
import {
	type Color,
	type Component,
	type TUI,
	colorToRgb,
	mixColors,
	oklchColor,
	rgbColor,
	stripTerminalSequences,
	truncateToWidth,
	colorToOklch,
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
const MAX_PALETTE_CHROMA = 0.05;

function softenColor(color: Color): Color {
	const { l, c, h } = colorToOklch(color);
	return oklchColor(l, Math.min(c * 0.72, MAX_PALETTE_CHROMA), h);
}

// 经典彩虹色谱
const RAW_RAINBOW = [
	rgbColor(255, 110, 130), // soft red/coral
	rgbColor(255, 175, 80),  // amber/orange
	rgbColor(245, 220, 80),  // yellow
	rgbColor(80, 220, 140),  // green/emerald
	rgbColor(60, 200, 245),  // sky/cyan
	rgbColor(140, 150, 250), // blue/indigo
	rgbColor(215, 130, 240), // purple/violet
].map(softenColor);

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// 每个字母赋予动态彩虹渐变色
function rainbowChars(graphemes: string[], timeMs = 0): { ch: string; col: Color }[] {
	const total = graphemes.length;
	const shift = (timeMs / 4000) % 1;
	return graphemes.map((ch, i) => {
		const pos = (((i / Math.max(1, total - 1)) + shift) % 1) * (RAW_RAINBOW.length - 1);
		const idx = Math.min(RAW_RAINBOW.length - 2, Math.floor(pos));
		const col = mixColors(RAW_RAINBOW[idx], RAW_RAINBOW[idx + 1], pos - idx, "srgb");
		return { ch, col };
	});
}

function softenPalette<T extends Record<string, Color>>(palette: T): T {
	for (const [key, color] of Object.entries(palette)) {
		if (/^(fg|bg)Status/.test(key)) continue;
		palette[key as keyof T] = softenColor(color) as T[keyof T];
	}
	const pairs = [
		["fgStatusReady", "bgStatusReady"], ["fgStatusRun", "bgStatusRun"],
		["fgStatusErr", "bgStatusErr"], ["fgStatusStp", "bgStatusStp"],
		["fgProject", "bgProjBranch"], ["fgBranch", "bgProjBranch"],
		["fgTokenIn", "bgTelemetry"], ["fgTokenOut", "bgTelemetry"], ["fgCost", "bgTelemetry"],
		["ctxText", "bgCtx"], ["bracketColor", "bgModelThink"],
	] as const;
	for (const [foregroundKey, backgroundKey] of pairs) {
		const foreground = palette[foregroundKey as keyof T];
		const background = palette[backgroundKey as keyof T];
		if (foreground && background) palette[foregroundKey as keyof T] = ensureTextContrast(foreground, background) as T[keyof T];
	}
	return palette;
}

function colorLuminance(color: Color): number {
	const { r, g, b } = colorToRgb(color);
	const linear = [r, g, b].map(channel => {
		const value = channel / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function ensureTextContrast(foreground: Color, background: Color): Color {
	const ratio = (a: Color, b: Color) => {
		const x = colorLuminance(a), y = colorLuminance(b);
		return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
	};
	if (ratio(foreground, background) >= 4.5) return foreground;
	const { l, h } = colorToOklch(foreground);
	const c = Math.min(colorToOklch(foreground).c, MAX_PALETTE_CHROMA);
	const goLighter = colorLuminance(background) < 0.5;
	let low = goLighter ? l : 0;
	let high = goLighter ? 1 : l;
	for (let i = 0; i < 24; i++) {
		const mid = (low + high) / 2;
		if (ratio(oklchColor(mid, c, h), background) >= 4.5) high = goLighter ? mid : high, low = goLighter ? low : mid;
		else high = goLighter ? high : mid, low = goLighter ? mid : low;
	}
	return oklchColor(goLighter ? high : low, c, h);
}

export function getRainbowBlockPalette(isDark: boolean) {
	if (isDark) {
		return softenPalette({
			canvasBg: rgbColor(9, 11, 16),
			
			// 模块 1: 状态胶囊背景
			// idle: 沉稳低饱和石板青灰微光底（偏灰）；running: 鲜活翠绿底
			bgStatusReady: mixColors(DARK_CANVAS, rgbColor(100, 116, 139), 0.16, "srgb"),
			bgStatusRun: mixColors(DARK_CANVAS, rgbColor(34, 197, 94), 0.22, "srgb"),
			bgStatusErr: mixColors(DARK_CANVAS, rgbColor(239, 68, 68), 0.22, "srgb"),
			bgStatusStp: mixColors(DARK_CANVAS, rgbColor(249, 115, 22), 0.20, "srgb"),
			fgStatusReady: rgbColor(148, 163, 184), // 优雅石板青灰，不刺眼
			fgStatusRun: rgbColor(74, 222, 128),   // 翠绿
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
		});
	} else {
		return softenPalette({
			canvasBg: rgbColor(248, 250, 252),
			bgStatusReady: mixColors(LIGHT_CANVAS, rgbColor(226, 232, 240), 0.40, "srgb"),
			bgStatusRun: mixColors(LIGHT_CANVAS, rgbColor(187, 247, 208), 0.30, "srgb"),
			bgStatusErr: mixColors(LIGHT_CANVAS, rgbColor(254, 202, 202), 0.25, "srgb"),
			bgStatusStp: mixColors(LIGHT_CANVAS, rgbColor(254, 215, 170), 0.25, "srgb"),
			fgStatusReady: rgbColor(71, 85, 105), // 中性青灰
			fgStatusRun: rgbColor(21, 128, 61),
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
		});
	}
}

const DARK_PALETTE = getRainbowBlockPalette(true);
const LIGHT_PALETTE = getRainbowBlockPalette(false);

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
	const h = Math.floor(sec / 3600) % 24;
	const d = Math.floor(sec / 86400);
	if (d > 0) {
		const sStr = String(s).padStart(2, "0");
		const mStr = String(m).padStart(2, "0");
		const hStr = String(h).padStart(2, "0");
		return `${d}d${hStr}h${mStr}m${sStr}s`;
	}
	if (h > 0) {
		const sStr = String(s).padStart(2, "0");
		const mStr = String(m).padStart(2, "0");
		return `${h}h${mStr}m${sStr}s`;
	}
	if (m > 0) {
		const sStr = String(s).padStart(2, "0");
		return `${m}m${sStr}s`;
	}
	return `${s}s`;
}

export class TopStatusBarComponent implements Component {
	private rainbowText = "";
	private rainbowGraphemes: string[] = [];
	private rainbowBlocks: string[][] = [];

	constructor(private state: TopBarState, private theme: Theme, private context: ExtensionContext) {}

	updateContext(context: ExtensionContext) {
		this.context = context;
	}

	render(width: number): string[] {
		if (!this.state.visible || width <= 0) return [];
		const st = this.state;
		const now = Date.now();
		const isDark = this.theme.appearance !== "light";
		const p = isDark ? DARK_PALETTE : LIGHT_PALETTE;

		// 1. Status 徽章（使用 Pi 原生状态名：idle, running, error, aborted）
		let statusIcon = "⠿";
		let statusLabel = "idle";
		let statusBg = p.bgStatusReady;
		let statusFg = p.fgStatusReady;
		let elapsedSec = 0;

		if (st.status === "running") {
			elapsedSec = st.startTime ? Math.floor((now - st.startTime) / 1000) : 0;
			const frame = BRAILLE_SPINNER[Math.floor(now / 100) % BRAILLE_SPINNER.length];
			statusIcon = frame;
			statusLabel = "running";
			statusBg = p.bgStatusRun;
			statusFg = p.fgStatusRun;
		} else if (st.status === "error") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "✗";
			statusLabel = "error";
			statusBg = p.bgStatusErr;
			statusFg = p.fgStatusErr;
		} else if (st.status === "aborted") {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
			statusIcon = "■";
			statusLabel = "aborted";
			statusBg = p.bgStatusStp;
			statusFg = p.fgStatusStp;
		} else {
			elapsedSec = st.durationMs ? Math.floor(st.durationMs / 1000) : 0;
		}

		// 无耗时不显示，有耗时自动格式化 (如 54s, 3m07s, 100h32m10s, 9999d23h59m59s)
		// 紧凑显示，不固定长度补空格
		const durStr = formatDuration(elapsedSec);
		const statusCoreText = durStr ? `${statusIcon} ${statusLabel} ${durStr}` : `${statusIcon} ${statusLabel}`;
		const statusPadded = statusCoreText;

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

		// Status remains left; project/branch and telemetry are grouped on the right.
		const leftStr = m1Pill;
		const leftVis = m1Vis;

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

		// Right-side order: project/branch, model/thinking, usage, context.
		const visibleItems = rightItems.filter(item => activeSet.has(item.id));
		// Build one color band across all visible telemetry blocks, including brackets and gaps.
		const rainbowItems = visibleItems.filter(item => item.bg !== undefined);
		const rainbowText = rainbowItems.map(item => item.pill).join(" ");
		if (rainbowText !== this.rainbowText) {
			this.rainbowText = rainbowText;
			this.rainbowBlocks = rainbowItems.map(item => [...GRAPHEME_SEGMENTER.segment(item.pill)].map(part => part.segment));
			this.rainbowGraphemes = this.rainbowBlocks.flatMap((letters, i) => i === 0 ? letters : [" ", ...letters]);
		}
		const band = rainbowChars(this.rainbowGraphemes, now);
		let bandIndex = 0;
		let blockIndex = 0;
		const orderedRight = visibleItems.map(item => {
			if (item.bg === undefined) return item.pill;
			const letters = this.rainbowBlocks[blockIndex++];
			const text = letters.map(() => {
				const { ch, col } = band[bandIndex++];
				return this.theme.style(ch, { fg: col, bg: item.bg, bold: true });
			}).join("");
			bandIndex++; // The inter-block space also occupies a position in the shared band.
			return text;
		}).join(" ");
		const totalVis = leftVis + (activeSet.size > 0 ? rightVis : 0);

		if (totalVis >= width) {
			return [truncateToWidth(orderedRight ? `${leftStr} ${orderedRight}` : leftStr, width)];
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
	let iconTimer: ReturnType<typeof setInterval> | undefined;
	const activeTools = new Map<string, string>();
	let lastAssistantFailed = false;
	let titleGroup: TabTitleGroup | undefined;
	const defaultGroupName = process.env.IPIUI_GROUP || "all";
	let groupName: string | undefined = defaultGroupName;
	let paneLabel = "cmd";
	let customPaneLabel = false;
	let titleStatus: TabStatus = "idle";
	let titleHeartbeat: ReturnType<typeof setInterval> | undefined;
	let lastPublishedTitle = "";
	let tabGroupDirectoryRoot: string | undefined = process.env.IPIUI_TEST_GROUP_ROOT;

	const writeTitle = (title: string) => {
		lastPublishedTitle = title;
		if (currentContext?.mode === "tui") currentContext.ui.setTitle(title);
	};
	const publishTitle = () => { void titleGroup?.update(titleStatus, paneLabel); };
	const stopTitleGroup = async () => {
		if (titleHeartbeat) clearInterval(titleHeartbeat);
		titleHeartbeat = undefined;
		const previous = titleGroup;
		titleGroup = undefined;
		lastPublishedTitle = "";
		await previous?.stop();
	};
	const joinTitleGroup = async (name: string) => {
		await stopTitleGroup();
		titleGroup = new TabTitleGroup({
			root: tabGroupDirectoryRoot,
			onTitle: writeTitle,
			onError: () => currentContext?.ui.notify("ipiui: title synchronization failed; use /ipiui group off and rejoin to retry", "warning"),
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
			await stopTitleGroup();
			groupName = undefined;
			throw error;
		}
	};

	const stopTimer = () => {
		stopIconTimer();
	};
	const stopIconTimer = () => {
		if (iconTimer) clearInterval(iconTimer);
		iconTimer = undefined;
	};
	const startIconTimer = () => {
		if (iconTimer) return;
		iconTimer = setInterval(() => {
			if (state.visible) redraw();
		}, 100);
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
		if (!customPaneLabel && ctx.cwd) {
			const folder = ctx.cwd.split(/[\\/]/).filter(Boolean).pop();
			if (folder) paneLabel = cleanTitleLabel(folder);
		}
		bar?.updateContext(ctx);
		if (usage) state.usage = collectUsage(ctx.sessionManager.getEntries());
	};

	pi.on("session_start", async (_event, ctx) => {
		stopTimer();
		stopBranchWatch?.();
		state.status = ctx.isIdle() ? "idle" : "running";
		state.errorMessage = undefined;
		state.durationMs = undefined;
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
		if (groupName) {
			try {
				await joinTitleGroup(groupName);
			} catch {
				ctx.ui.notify("ipiui: could not join title group; check IPIUI_GROUP and temporary-directory access", "warning");
			}
		}
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
		stopTimer();
		await stopTitleGroup();
		stopBranchWatch?.();
		stopBranchWatch = undefined;
		currentContext = null;
		bar = null;
		tuiInstance = null;
	});
	const showPanel = async (ctx: ExtensionContext) => {
		while (true) {
			const choices = [
				`${state.visible ? "Show status row(显示状态栏)" : "Hide status row(隐藏状态栏)"} · ${state.visible ? "On" : "Off"}`,
				`Pane name(窗格名称) · ${paneLabel} · ${customPaneLabel ? "Custom" : "Project directory"}`,
				`Title sync(标题同步) · ${groupName ? `On · ${groupName}` : "Off"}`,
				"Help and command shortcuts(帮助与快捷命令)",
			];
			const choice = await ctx.ui.select("ipiui settings · ↑/↓ select · Enter confirm · Esc close", choices);
			if (!choice) return;
			if (choice === choices[0]) {
				await handleCommand("toggle", ctx);
			} else if (choice === choices[1]) {
				const action = await ctx.ui.select(`Pane name · ${paneLabel}`, ["Set custom name(设置自定义名称)", "Use project directory name(使用项目目录名)", "Back to settings(返回设置)"]);
				if (action === "Use project directory name(使用项目目录名)") await handleCommand("name reset", ctx);
				if (action === "Set custom name(设置自定义名称)") {
					const name = await ctx.ui.input("Pane name · up to 20 characters · Esc cancels", paneLabel);
					if (name?.trim()) await handleCommand(`name ${name}`, ctx);
				}
			} else if (choice === choices[2]) {
				const actions = [groupName ? "Turn title sync off(关闭标题同步)" : "Turn title sync on(开启标题同步)", "Change group(切换分组)", "Join default group(加入默认分组)", "Back to settings(返回设置)"];
				const action = await ctx.ui.select("Panes in the same group share a title. Use different groups to isolate them.", actions);
				if (action === actions[0]) await handleCommand(`group ${groupName ? "off" : defaultGroupName}`, ctx);
				if (action === actions[2]) await handleCommand(`group ${defaultGroupName}`, ctx);
				if (action === actions[1]) {
					const group = await ctx.ui.input("Group name · up to 64 characters · Esc cancels", groupName ?? defaultGroupName);
					if (group?.trim()) await handleCommand(`group ${group}`, ctx);
				}
			} else if (choice === choices[3]) {
				await handleCommand("help", ctx);
				return;
			}
		}
	};
	const handleCommand = async (args: string, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		sync(ctx);
		const [, sub = "", remainder = ""] = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/) ?? [];
		const subCmd = sub.toLowerCase();
		const param = remainder.trim();

		if (!subCmd || subCmd === "menu") {
			await showPanel(ctx);
			return;
		}
		if (subCmd === "help") {
			ctx.ui.notify(
				`ipiui · /ipiui opens settings / 打开设置. ↑/↓ select / 选择 · Enter confirm / 确认 · Esc close / 关闭.\n` +
				`  /ipiui on|off|toggle    - Show/hide status row / 显示或隐藏状态栏 (${state.visible ? "on / 已显示" : "off / 已隐藏"})\n` +
				`  /ipiui name [NAME]      - Set pane title / 设置窗格名称; name reset follows project / reset 恢复项目名 (${paneLabel})\n` +
				`  /ipiui group [NAME|off] - Set title group / 设置标题分组 (${groupName ?? "off / 已关闭"})\n` +
				`  /ipiui status           - Show current settings / 查看当前设置`,
				"info"
			);
			return;
		}

		if (["on", "off", "toggle"].includes(subCmd)) {
			state.visible = subCmd === "on" ? true : subCmd === "off" ? false : !state.visible;
			ctx.ui.notify(`Status bar: ${state.visible ? "ON" : "OFF"}`, "info");
			redraw();
			return;
		}

		if (subCmd === "name") {
			if (!param) {
				ctx.ui.notify(`Title name: ${paneLabel}; use /ipiui name NAME`, "info");
				return;
			}
			if (param === "reset") {
				customPaneLabel = false;
				sync(ctx);
			} else {
				paneLabel = cleanTitleLabel(param);
				customPaneLabel = true;
			}
			publishTitle();
			ctx.ui.notify(`Title name: ${paneLabel}`, "info");
			return;
		}

		if (subCmd === "group") {
			if (!param) {
				ctx.ui.notify(groupName ? `Title group: ${groupName}; pane name: ${paneLabel}` : "Title sync is off. Use /ipiui group NAME to rejoin.", "info");
				return;
			}
			if (param === "off") {
				await stopTitleGroup();
				groupName = undefined;
				ctx.ui.setTitle("pi");
				ctx.ui.notify("Title group disabled", "info");
				return;
			}
			if (param.length > 64 || /[\x00-\x1f\x7f]/.test(param)) {
				ctx.ui.notify("Group must be 1–64 characters with no control characters", "warning");
				return;
			}
			try {
				await joinTitleGroup(param);
				ctx.ui.notify(`Joined title group: ${param}`, "info");
			} catch {
				ctx.ui.notify("Could not join title group; check the group name and local temporary-directory access.", "error");
			}
			return;
		}

		if (subCmd === "status") {
			ctx.ui.notify(
				`ipiui status:\n` +
				`  TopBar: ${state.visible ? "ON" : "OFF"}\n` +
				`  Pane name: ${paneLabel}\n` +
				`  Title group: ${groupName ?? "off"}`,
				"info"
			);
			return;
		}

		ctx.ui.notify(`Unknown subcommand: ${subCmd}. Use /ipiui for help`, "warning");
	};
	pi.registerCommand("ipiui", {
		description: "Open the ipiui settings panel, or use on/off/name/group/status/help",
		getArgumentCompletions: prefix => {
			const commands = ["menu", "on", "off", "toggle", "name", "name reset", "group", "group all", "group off", "status", "help"];
			const matches = commands.filter(value => value.startsWith(prefix)).map(value => ({ value, label: `/ipiui ${value}` }));
			return matches.length ? matches : null;
		},
		handler: handleCommand,
	});
	pi.registerCommand("topbar", {
		description: "Alias for /ipiui [on|off|toggle]",
		handler: (args, ctx) => handleCommand(args.trim() || "toggle", ctx),
	});
	pi.registerCommand("tabgroup", {
		description: "Alias for /ipiui group [NAME|off]",
		handler: (args, ctx) => handleCommand(`group ${args}`, ctx),
	});
	pi.registerCommand("tabname", {
		description: "Alias for /ipiui name NAME",
		handler: (args, ctx) => handleCommand(`name ${args}`, ctx),
	});
}
