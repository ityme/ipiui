import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { TabTitleGroup, cleanTitleLabel, type TabStatus } from "./tab-title.js";
import { languageName, translate, type PanelLanguage } from "./i18n.js";
import { selectPanel } from "./panel.js";
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
export type StatusRowTheme = "chase" | "rainbow";

export interface TopBarState {
	status: "idle" | "running" | "error" | "aborted";
	errorMessage?: string;
	startTime?: number;
	durationMs?: number;
	modelId?: string;
	thinkingLevel?: string;
	activeTool?: string;
	isThinking?: boolean;
	gitBranch?: string | null;
	cwd?: string;
	visible: boolean;
	style: StatusBarStyle;
	theme?: StatusRowTheme;
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
const MAX_PALETTE_CHROMA = 0.10;

function softenColor(color: Color): Color {
	const { l, c, h } = colorToOklch(color);
	return oklchColor(l, Math.min(c * 0.72, MAX_PALETTE_CHROMA), h);
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const RAINBOW_STOPS = [
	rgbColor(255, 110, 130), rgbColor(255, 175, 80), rgbColor(245, 220, 80),
	rgbColor(80, 220, 140), rgbColor(60, 200, 245), rgbColor(140, 150, 250), rgbColor(215, 130, 240),
].map(softenColor);

function rainbowColors(background: Color): Color[] {
	return Array.from({ length: 128 }, (_, index) => {
		const position = index / 128 * RAINBOW_STOPS.length;
		const segment = Math.floor(position);
		const color = mixColors(RAINBOW_STOPS[segment], RAINBOW_STOPS[(segment + 1) % RAINBOW_STOPS.length], position - segment, "srgb");
		return ensureTextContrast(color, background);
	});
}
const SWEEP_PERIOD_MS = 5000;
const SWEEP_TRAVEL_MS = 4500;
const SWEEP_HEAD_COLUMNS = 2.5;
const SWEEP_TAIL_COLUMNS = 5.5;

export function sweepStrength(column: number, width: number, elapsedMs: number): number {
	const phaseMs = ((elapsedMs % SWEEP_PERIOD_MS) + SWEEP_PERIOD_MS) % SWEEP_PERIOD_MS;
	if (phaseMs >= SWEEP_TRAVEL_MS) return 0;
	const span = SWEEP_HEAD_COLUMNS + SWEEP_TAIL_COLUMNS;
	// The leading edge moves right; all of the fading tail stays behind it on the left.
	const edge = -0.5 + phaseMs / SWEEP_TRAVEL_MS * (width + span + 0.5);
	const distance = edge - column;
	if (distance <= 0 || distance >= span) return 0;
	const smooth = (value: number) => value * value * (3 - 2 * value);
	if (distance <= SWEEP_HEAD_COLUMNS) return smooth(Math.min(1, distance / 0.6));
	return 1 - smooth((distance - SWEEP_HEAD_COLUMNS) / SWEEP_TAIL_COLUMNS);
}

function chaseColor(base: Color, strength: number, isDark: boolean): Color {
	if (strength <= 0) return base;
	const { l, c, h } = colorToOklch(base);
	// Preserve each field's hue/chroma. Light backgrounds use stronger ink instead of white glare.
	const lightness = isDark ? Math.min(0.98, l + 0.22 * strength) : Math.max(0.12, l - 0.17 * strength);
	return oklchColor(lightness, c, h);
}

function softenPalette<T extends Record<string, Color>>(palette: T): T {
	for (const [key, color] of Object.entries(palette)) {
		if (/^(fg|bg)Status/.test(key)) continue;
		palette[key as keyof T] = softenColor(color) as T[keyof T];
	}
	const pairs = [
		["fgStatusReady", "bgStatusReady"], ["fgStatusRun", "bgStatusRun"],
		["fgStatusErr", "bgStatusErr"], ["fgStatusStp", "bgStatusStp"],
		["fgProject", "bgProjBranch"], ["fgBranch", "bgProjBranch"], ["fgModel", "bgModelThink"], ["fgThinking", "bgModelThink"],
		["fgTokenIn", "bgTelemetry"], ["fgTokenOut", "bgTelemetry"], ["fgCost", "bgTelemetry"],
		["ctxText", "bgCtx"], ["ctxValue", "bgCtx"], ["ctxTrack", "bgCtx"],
		["ctxLow", "bgCtx"], ["ctxMed", "bgCtx"], ["ctxHigh", "bgCtx"], ["bracketColor", "bgModelThink"],
		["bracketColor", "bgProjBranch"], ["bracketColor", "bgTelemetry"], ["bracketColor", "bgCtx"],
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

			// Model is muted blue-gray; reasoning level gets the brighter lavender accent.
			bgModelThink: mixColors(DARK_CANVAS, rgbColor(168, 85, 247), 0.20, "srgb"),
			fgModel: rgbColor(159, 181, 198),
			fgThinking: rgbColor(202, 174, 236),

			// 模块 4: 遥测数据 (翡翠薄荷微光底)
			bgTelemetry: mixColors(DARK_CANVAS, rgbColor(34, 197, 94), 0.18, "srgb"),
			fgTokenIn: rgbColor(96, 165, 250),
			fgTokenOut: rgbColor(52, 211, 153),
			fgCost: rgbColor(251, 191, 36),

			// 模块 5: CTX 进度 (克制青蓝灰底)
			bgCtx: mixColors(DARK_CANVAS, rgbColor(78, 107, 124), 0.18, "srgb"),
			ctxLow: rgbColor(103, 166, 171),
			ctxMed: rgbColor(190, 151, 91),
			ctxHigh: rgbColor(183, 112, 105),
			ctxTrack: rgbColor(120, 140, 154),
			ctxText: rgbColor(151, 176, 190),
			ctxValue: rgbColor(183, 198, 207),

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
			fgModel: rgbColor(77, 99, 117),
			fgThinking: rgbColor(104, 66, 151),

			bgTelemetry: mixColors(LIGHT_CANVAS, rgbColor(209, 250, 229), 0.25, "srgb"),
			fgTokenIn: rgbColor(37, 99, 235),
			fgTokenOut: rgbColor(5, 150, 105),
			fgCost: rgbColor(180, 83, 9),

			bgCtx: mixColors(LIGHT_CANVAS, rgbColor(205, 218, 222), 0.38, "srgb"),
			ctxLow: rgbColor(49, 117, 121),
			ctxMed: rgbColor(139, 101, 45),
			ctxHigh: rgbColor(145, 76, 69),
			ctxTrack: rgbColor(88, 108, 118),
			ctxText: rgbColor(55, 79, 91),
			ctxValue: rgbColor(49, 72, 83),

			bracketColor: rgbColor(100, 116, 139),
		});
	}
}

const DARK_PALETTE = getRainbowBlockPalette(true);
const LIGHT_PALETTE = getRainbowBlockPalette(false);
const DARK_RAINBOW_COLORS = [DARK_PALETTE.bgProjBranch, DARK_PALETTE.bgModelThink, DARK_PALETTE.bgTelemetry, DARK_PALETTE.bgCtx].map(rainbowColors);
const LIGHT_RAINBOW_COLORS = [LIGHT_PALETTE.bgProjBranch, LIGHT_PALETTE.bgModelThink, LIGHT_PALETTE.bgTelemetry, LIGHT_PALETTE.bgCtx].map(rainbowColors);
const THINKING_HUES = [25, 85, 155, 235, 300, 55, 190, 265, 340, 115];
const DARK_THINKING_COLORS = THINKING_HUES.map(hue => ensureTextContrast(oklchColor(0.82, 0.10, hue), DARK_PALETTE.bgModelThink));
const LIGHT_THINKING_COLORS = THINKING_HUES.map(hue => ensureTextContrast(oklchColor(0.43, 0.10, hue), LIGHT_PALETTE.bgModelThink));

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
	private blockText = "";
	private blockLetters: { text: string; width: number; field: number }[][] = [];

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
			statusLabel = st.isThinking ? "thinking" : "working";
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
		const ctxBarColor = ctxPercent > 80 ? p.ctxHigh : ctxPercent > 60 ? p.ctxMed : p.ctxLow;

		// 4. 五大独立模块构建 (带方括号 [] 区分，同模块同背景色)

		// 模块 1: [■ STP 187s]
		const m1BracketOpen = this.theme.style("[", { fg: p.bracketColor, bg: statusBg, bold: true });
		const m1BracketClose = this.theme.style("]", { fg: p.bracketColor, bg: statusBg, bold: true });
		const m1Content = this.theme.style(statusPadded, { fg: statusFg, bg: statusBg, bold: true });
		const m1Pill = `${m1BracketOpen}${m1Content}${m1BracketClose}`;
		const m1Vis = 1 + visibleWidth(statusPadded) + 1;

		// Right-side blocks retain fixed foreground/background colors.
		const m2RawText = `[📁 ${cwdBasename} ${branch}]`;
		const m2Vis = visibleWidth(m2RawText);

		const rawThink = (st.thinkingLevel ?? "med").toLowerCase();
		const thinkFull = rawThink === "med" ? "medium" : rawThink;
		const thinkingColors = isDark ? DARK_THINKING_COLORS : LIGHT_THINKING_COLORS;
		const thinkingFields = [...GRAPHEME_SEGMENTER.segment(thinkFull)].map((part, index) => ({
			text: part.segment, fg: thinkingColors[index % thinkingColors.length],
		}));
		const m3RawText = `[🤖 ${model} · ${thinkFull}]`;
		const m4RawText = `[⬆️${shortCount(usage.input)} ⬇️${shortCount(usage.output)} 💰 ${usage.cost.toFixed(2)}¥]`;
		const m5RawText = `[CTX ${"━".repeat(ctxFilled)}${"─".repeat(ctxEmpty)} ${ctxPercent}% ${shortCount(ctxTokens)}/${shortContextWindow(ctxWindow)}]`;

		// Status remains left; project/branch and telemetry are grouped on the right.
		const leftStr = m1Pill;
		const leftVis = m1Vis;

		const muted = (text: string) => ({ text, fg: p.bracketColor });
		const rightItems = [
			{ id: "proj_branch", pill: m2RawText, vis: m2Vis, priority: 4, bg: p.bgProjBranch,
				fields: [muted("["), { text: `📁 ${cwdBasename}`, fg: p.fgProject }, muted(" "), { text: `${branch}`, fg: p.fgBranch }, muted("]")] },
			{ id: "model_think", pill: m3RawText, vis: visibleWidth(m3RawText), priority: 3, bg: p.bgModelThink,
				fields: [muted("["), { text: `🤖 ${model}`, fg: p.fgModel }, muted(" · "), ...thinkingFields, muted("]")] },
			{ id: "telemetry", pill: m4RawText, vis: visibleWidth(m4RawText), priority: 2, bg: p.bgTelemetry,
				fields: [muted("["), { text: `⬆️${shortCount(usage.input)}`, fg: p.fgTokenIn }, muted(" "),
					{ text: `⬇️${shortCount(usage.output)}`, fg: p.fgTokenOut }, muted(" "), { text: `💰 ${usage.cost.toFixed(2)}¥`, fg: p.fgCost }, muted("]")] },
			{ id: "ctx", pill: m5RawText, vis: visibleWidth(m5RawText), priority: 1, bg: p.bgCtx,
				fields: [muted("["), { text: "CTX ", fg: p.ctxText },
					{ text: "━".repeat(ctxFilled), fg: ctxBarColor }, { text: "─".repeat(ctxEmpty), fg: p.ctxTrack },
					{ text: ` ${ctxPercent}% `, fg: ctxBarColor },
					{ text: `${shortCount(ctxTokens)}/${shortContextWindow(ctxWindow)}`, fg: p.ctxValue }, muted("]")] },
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
		const blockText = visibleItems.map(item => item.pill).join(" ");
		if (blockText !== this.blockText) {
			this.blockText = blockText;
			this.blockLetters = visibleItems.map(item => item.fields.flatMap((field, fieldIndex) => [...GRAPHEME_SEGMENTER.segment(field.text)]
				.map(part => ({ text: part.segment, width: visibleWidth(part.segment), field: fieldIndex }))));
		}
		const elapsedMs = now - (st.startTime ?? now);
		let column = 0;
		const orderedRight = visibleItems.map((item, index) => {
			if (st.theme === "rainbow") {
				const colors = (isDark ? DARK_RAINBOW_COLORS : LIGHT_RAINBOW_COLORS)[rightItems.indexOf(item)];
				const phase = st.status === "running" ? ((elapsedMs % 4000) + 4000) % 4000 / 4000 : 0;
				const text = this.blockLetters[index].map(letter => {
					const position = (column / Math.max(1, rightVis) + phase) % 1;
					column += letter.width;
					return this.theme.style(letter.text, { fg: colors[Math.floor(position * colors.length)], bg: item.bg, bold: true });
				}).join("");
				column++;
				return text;
			}
			if (st.status !== "running") return item.fields.map(field => this.theme.style(field.text, { fg: field.fg, bg: item.bg, bold: true })).join("");
			const text = this.blockLetters[index].map(letter => {
				const strength = sweepStrength(column + letter.width / 2, rightVis, elapsedMs);
				column += letter.width;
				const base = item.fields[letter.field].fg;
				const fg = chaseColor(base, strength, isDark);
				const isThinkingLevel = item.id === "model_think" && letter.field >= 3 && letter.field < item.fields.length - 1;
				return this.theme.style(letter.text, { fg, bg: item.bg, bold: isThinkingLevel || strength >= 0.65 });
			}).join("");
			column++;
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
		theme: "chase",
	};
	let language: PanelLanguage = "en";
	const t = (key: Parameters<typeof translate>[1], values?: Record<string, string>) => translate(language, key, values);
	const enabledText = (enabled: boolean) => t(enabled ? "on" : "off");
	let currentContext: ExtensionContext | null = null;
	let tuiInstance: TUI | null = null;
	let bar: TopStatusBarComponent | null = null;
	let stopBranchWatch: (() => void) | undefined;
	let iconTimer: ReturnType<typeof setInterval> | undefined;
	const activeTools = new Map<string, string>();
	let lastAssistantFailed = false;
	let titleGroup: TabTitleGroup | undefined;
	const defaultGroupName = process.env.IPIUI_GROUP || "all";
	let groupName: string | undefined;
	let paneLabel = "cmd";
	let customPaneLabel = false;
	let titleStatus: TabStatus = "idle";
	let indicatorEnabled = true;
	let titleIndicator: TitleIndicator | undefined;
	let sharedRecords: PaneRecord[] | undefined;
	let tabGroupDirectoryRoot: string | undefined = process.env.IPIUI_TEST_GROUP_ROOT;

	const localStarted = Date.now();
	const renderTitle = () => {
		if (!titleIndicator || currentContext?.mode !== "tui") return;
		const now = Date.now();
		const local: PaneRecord = { version: 1, id: "local", started: localStarted, updated: now, label: paneLabel, status: titleStatus };
		titleIndicator.update(sharedRecords ?? [local], !!titleGroup, indicatorEnabled);
	};
	const publishTitle = () => {
		if (titleGroup) void titleGroup.update(titleStatus, paneLabel);
		else renderTitle();
	};
	const stopTitleGroup = async () => {
		const previous = titleGroup;
		titleGroup = undefined;
		sharedRecords = undefined;
		await previous?.stop();
	};
	const joinTitleGroup = async (name: string) => {
		await stopTitleGroup();
		titleGroup = new TabTitleGroup({
			root: tabGroupDirectoryRoot,
			onTitle() {},
			onRecords: records => { sharedRecords = records; renderTitle(); },
			onError: error => currentContext?.ui.notify(t("syncFailed", { detail: error instanceof Error ? error.message : t("retrying") }), "warning"),
		});
		try {
			await titleGroup.start(name, paneLabel, titleStatus);
			groupName = name;
			renderTitle();
		} catch (error) {
			await stopTitleGroup();
			groupName = undefined;
			renderTitle();
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

	const restoreSettings = (ctx: ExtensionContext) => {
		state.theme = "chase";
		language = "en";
		indicatorEnabled = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "ipiui-theme") {
				const theme = (entry.data as { theme?: unknown } | undefined)?.theme;
				if (theme === "chase" || theme === "rainbow") state.theme = theme;
			}
			if (entry.customType === "ipiui-title-indicator") {
				const saved = (entry.data as { enabled?: unknown } | undefined)?.enabled;
				if (typeof saved === "boolean") indicatorEnabled = saved;
			}
			if (entry.customType === "ipiui-language") {
				const saved = (entry.data as { language?: unknown } | undefined)?.language;
				if (saved === "en" || saved === "zh") language = saved;
			}
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		restoreSettings(ctx);
		stopTimer();
		stopBranchWatch?.();
		state.status = ctx.isIdle() ? "idle" : "running";
		state.errorMessage = undefined;
		state.durationMs = undefined;
		state.startTime = state.status === "running" ? Date.now() : undefined;
		state.activeTool = undefined;
		state.isThinking = false;
		activeTools.clear();
		lastAssistantFailed = false;
		sync(ctx, true);
		if (ctx.mode !== "tui") return;
		titleIndicator?.stop();
		titleIndicator = new TitleIndicator({ onTitle: title => currentContext?.ui.setTitle(title) });
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
				ctx.ui.notify(t("startupFailed"), "warning");
			}
		}
		renderTitle();
		if (state.status === "running") startIconTimer();
		redraw();
	});

	pi.on("agent_start", (_event, ctx) => {
		sync(ctx);
		state.status = "running";
		state.isThinking = false;
		titleStatus = "running";
		publishTitle();
		state.startTime ??= Date.now();
		state.errorMessage = undefined;
		lastAssistantFailed = false;
		stopTimer();
		startIconTimer();
		redraw();
	});
	pi.on("message_update", (event, ctx) => {
		if (event.message.role !== "assistant" || state.status !== "running") return;
		const type = event.assistantMessageEvent.type;
		const thinking = type === "thinking_start" || type === "thinking_delta";
		if (!thinking && !["thinking_end", "text_start", "text_delta", "toolcall_start", "done", "error"].includes(type)) return;
		if (state.isThinking === thinking) return;
		state.isThinking = thinking;
		sync(ctx);
		redraw();
	});
	pi.on("tool_execution_start", (event, ctx) => {
		sync(ctx);
		state.isThinking = false;
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
			state.isThinking = false;
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
		state.isThinking = false;
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
	pi.on("session_tree", (event, ctx) => { restoreSettings(ctx); refreshSession(event, ctx); renderTitle(); });
	pi.on("session_compact", refreshSession);
	pi.on("session_shutdown", async () => {
		titleIndicator?.stop();
		titleIndicator = undefined;
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
			const items = [
				{ value: "language", label: t("language"), description: languageName(language) },
				{ value: "visibility", label: t("topBar"), description: enabledText(state.visible) },
				{ value: "name", label: t("paneName"), description: `${singleLine(paneLabel)} (${t(customPaneLabel ? "custom" : "projectDirectory")})` },
				{ value: "group", label: t("titleSync"), description: groupName ? `${enabledText(true)} (${singleLine(groupName)})` : enabledText(false) },
				{ value: "theme", label: t("theme"), description: t(state.theme === "rainbow" ? "rainbowName" : "chaseName") },
				{ value: "indicator", label: t("indicator"), description: enabledText(indicatorEnabled) },
				{ value: "help", label: t("helpLabel"), description: t("helpValue") },
			];
			const choice = await selectPanel(ctx, t("settings"), items, t("navigation"));
			if (!choice) return;
			if (choice === "language") {
				// Keep native language names recognizable in either panel language.
				const languages = ["English", "简体中文", t("back")];
				const selected = await ctx.ui.select(t("languagePrompt"), languages);
				if (selected === languages[0]) await handleCommand("language en", ctx);
				if (selected === languages[1]) await handleCommand("language zh", ctx);
			} else if (choice === "visibility") {
				const selected = await selectPanel(ctx, t("topBar"), [
					{ value: "on", label: t("enable"), description: state.visible ? t("current") : undefined },
					{ value: "off", label: t("disable"), description: !state.visible ? t("current") : undefined },
					{ value: "back", label: t("back") },
				], t("navigation"));
				if (selected === "on" || selected === "off") await handleCommand(selected, ctx);
			} else if (choice === "name") {
				const actions = [t("setName"), t("resetName"), t("back")];
				const action = await ctx.ui.select(`${t("paneName")} · ${paneLabel}`, actions);
				if (action === actions[1]) await handleCommand("name reset", ctx);
				if (action === actions[0]) {
					const name = await ctx.ui.input(t("namePrompt"), paneLabel);
					if (name?.trim()) await handleCommand(`name ${name}`, ctx);
				}
			} else if (choice === "group") {
				const actions = [t(groupName ? "syncOff" : "syncOn"), t("changeGroup"), t("defaultGroup"), t("back")];
				const action = await ctx.ui.select(t("groupHint"), actions);
				if (action === actions[0]) await handleCommand(`group ${groupName ? "off" : defaultGroupName}`, ctx);
				if (action === actions[2]) await handleCommand(`group ${defaultGroupName}`, ctx);
				if (action === actions[1]) {
					const group = await ctx.ui.input(t("groupPrompt"), groupName ?? defaultGroupName);
					if (group?.trim()) await handleCommand(`group ${group}`, ctx);
				}
			} else if (choice === "theme") {
				const selected = await selectPanel(ctx, t("theme"), [
					{ value: "chase", label: "Chase", description: t("chaseDescription") },
					{ value: "rainbow", label: "Rainbow", description: t("rainbowDescription") },
					{ value: "back", label: t("back") },
				], t("navigation"));
				if (selected === "chase" || selected === "rainbow") await handleCommand(`theme ${selected}`, ctx);
			} else if (choice === "indicator") {
				const selected = await selectPanel(ctx, t("indicator"), [
					{ value: "on", label: t("enable"), description: indicatorEnabled ? t("current") : undefined },
					{ value: "off", label: t("disable"), description: !indicatorEnabled ? t("current") : undefined },
					{ value: "back", label: t("back") },
				], t("navigation"));
				if (selected === "on" || selected === "off") await handleCommand(`indicator ${selected}`, ctx);
			} else if (choice === "help") {
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
		if (subCmd === "indicator") {
			if (!param) {
				ctx.ui.notify(t("indicatorStatus", { value: enabledText(indicatorEnabled) }), "info");
				return;
			}
			if (param !== "on" && param !== "off") {
				ctx.ui.notify(t("indicatorUsage"), "warning");
				return;
			}
			const enabled = param === "on";
			if (indicatorEnabled !== enabled) {
				pi.appendEntry("ipiui-title-indicator", { enabled });
				indicatorEnabled = enabled;
			}
			renderTitle();
			ctx.ui.notify(t("indicatorStatus", { value: enabledText(indicatorEnabled) }), "info");
			return;
		}
		if (subCmd === "language") {
			if (!param) {
				ctx.ui.notify(t("languageUsage", { language: languageName(language) }), "info");
				return;
			}
			if (param !== "en" && param !== "zh") {
				ctx.ui.notify(t("languageUnknown"), "warning");
				return;
			}
			if (language !== param) {
				pi.appendEntry("ipiui-language", { language: param });
				language = param;
			}
			ctx.ui.notify(t("languageChanged", { language: languageName(language) }), "info");
			return;
		}
		if (subCmd === "theme") {
			if (!param) {
				ctx.ui.notify(t("themeUsage", { theme: state.theme ?? "chase" }), "info");
				return;
			}
			if (param !== "chase" && param !== "rainbow") {
				ctx.ui.notify(t("themeUnknown"), "warning");
				return;
			}
			if (state.theme !== param) {
				pi.appendEntry("ipiui-theme", { theme: param });
				state.theme = param;
			}
			redraw();
			ctx.ui.notify(t("themeChanged", { theme: param }), "info");
			return;
		}
		if (subCmd === "help") {
			ctx.ui.notify([t("helpIntro"), t("helpVisibility"), t("helpName"), t("helpGroup"), t("helpIndicator"), t("helpTheme"), t("helpLanguage"), t("helpStatus")].join("\n"), "info");
			return;
		}

		if (["on", "off", "toggle"].includes(subCmd)) {
			state.visible = subCmd === "on" ? true : subCmd === "off" ? false : !state.visible;
			ctx.ui.notify(t("visibilityChanged", { value: enabledText(state.visible) }), "info");
			redraw();
			return;
		}

		if (subCmd === "name") {
			if (!param) {
				ctx.ui.notify(t("nameUsage", { name: paneLabel }), "info");
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
			ctx.ui.notify(t("nameChanged", { name: paneLabel }), "info");
			return;
		}

		if (subCmd === "group") {
			if (!param) {
				ctx.ui.notify(groupName ? t("groupStatus", { group: groupName, name: paneLabel }) : t("groupOff"), "info");
				return;
			}
			if (param === "off") {
				await stopTitleGroup();
				groupName = undefined;
				renderTitle();
				ctx.ui.notify(t("groupDisabled"), "info");
				return;
			}
			if (param.length > 64 || /[\x00-\x1f\x7f]/.test(param)) {
				ctx.ui.notify(t("groupInvalid"), "warning");
				return;
			}
			try {
				await joinTitleGroup(param);
				ctx.ui.notify(t("groupJoined", { group: param }), "info");
			} catch {
				ctx.ui.notify(t("groupFailed"), "error");
			}
			return;
		}

		if (subCmd === "status") {
			ctx.ui.notify([
				t("status"), `${t("topBar")}: ${enabledText(state.visible)}`, `${t("theme")}: ${state.theme ?? "chase"}`,
				`${t("language")}: ${languageName(language)}`, `${t("indicator")}: ${enabledText(indicatorEnabled)}`, `${t("paneName")}: ${paneLabel}`, `${t("group")}: ${groupName ?? t("off")}`,
			].join("\n"), "info");
			return;
		}

		ctx.ui.notify(t("unknown", { command: subCmd }), "warning");
	};
	pi.registerCommand("ipiui", {
		description: "Open ipiui settings (设置), or use on/off/name/group/theme/language/status/help",
		getArgumentCompletions: prefix => {
			const commands = ["menu", "on", "off", "toggle", "name", "name reset", "group", "group all", "group off", "theme", "theme chase", "theme rainbow", "language", "language en", "language zh", "status", "help"];
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
