import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface TopBarState {
	status: "idle" | "running" | "error" | "aborted";
	errorMessage?: string;
	startTime?: number;
	durationMs?: number;
	modelId?: string;
	provider?: string;
	thinkingLevel?: string;
	activeTool?: string;
	visible: boolean;
}

export class TopStatusBarComponent implements Component {
	private state: TopBarState;
	private theme: Theme;
	private context: ExtensionContext;

	constructor(state: TopBarState, theme: Theme, context: ExtensionContext) {
		this.state = state;
		this.theme = theme;
		this.context = context;
	}

	updateState(state: TopBarState, theme?: Theme) {
		this.state = state;
		if (theme) {
			this.theme = theme;
		}
	}

	render(width: number): string[] {
		if (!this.state.visible || width <= 0) {
			return [];
		}

		const th = this.theme;
		const st = this.state;

		// 1. 状态 Badge 生成
		let badgeRendered = th.bg("selectedBg", th.fg("text", " ● READY "));

		if (st.status === "running") {
			const elapsed = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : 0;
			const timeStr = `${elapsed}s`;
			badgeRendered = th.bg("selectedBg", th.bold(th.fg("accent", ` 🚀 RUNNING ${timeStr} `)));
		} else if (st.status === "error") {
			badgeRendered = th.bg("toolErrorBg", th.bold(th.fg("error", " ✖ ERROR ")));
		} else if (st.status === "aborted") {
			badgeRendered = th.bg("selectedBg", th.bold(th.fg("warning", " ⏹ STOPPED ")));
		}

		// 2. 详细信息段 (Segments)
		const segments: string[] = [];

		// 当前活动工具
		if (st.status === "running" && st.activeTool) {
			segments.push(`${th.fg("warning", "⚡")} ${th.fg("accent", st.activeTool)}`);
		}

		// 模型信息
		const modelDisplay = st.modelId
			? `${st.provider ? `${st.provider}/` : ""}${st.modelId}`
			: "no-model";
		segments.push(`${th.fg("dim", "🤖")} ${th.fg("text", modelDisplay)}`);

		// 思考等级
		const thinkLevel = st.thinkingLevel ?? "off";
		let thinkStyled = th.fg("dim", thinkLevel);
		if (thinkLevel === "high" || thinkLevel === "max" || thinkLevel === "xhigh") {
			thinkStyled = th.fg("accent", thinkLevel);
		} else if (thinkLevel === "medium" || thinkLevel === "low") {
			thinkStyled = th.fg("text", thinkLevel);
		}
		segments.push(`${th.fg("dim", "🧠")} ${thinkStyled}`);

		// 上下文 Token 使用
		try {
			const usage = this.context.getContextUsage();
			if (usage && usage.tokens !== null && usage.contextWindow > 0) {
				const pct = Math.round((usage.tokens / usage.contextWindow) * 100);
				const kTokens = (usage.tokens / 1000).toFixed(1);
				const kWindow = Math.round(usage.contextWindow / 1000);
				segments.push(`${th.fg("dim", "📊")} ${th.fg("muted", `${kTokens}k/${kWindow}k (${pct}%)`)}`);
			}
		} catch {
			// ignore usage calculation errors
		}

		// 错误信息显示（若是错误退出）
		if (st.status === "error" && st.errorMessage) {
			const cleanErr = st.errorMessage.replace(/\r?\n/g, " ").trim();
			segments.unshift(th.fg("error", `Reason: ${cleanErr}`));
		} else if (st.status === "aborted") {
			segments.unshift(th.fg("warning", "Interrupted by user"));
		}

		// 3. 组合横条并自适应终端宽度
		const separator = th.fg("borderMuted", " │ ");
		const sepVisWidth = visibleWidth(separator);

		let content = "";
		let usedWidth = visibleWidth(badgeRendered);

		for (const seg of segments) {
			const segWidth = visibleWidth(seg);
			if (usedWidth + sepVisWidth + segWidth + 2 > width) {
				break;
			}
			content += separator + seg;
			usedWidth += sepVisWidth + segWidth;
		}

		const fullBar = `${badgeRendered}${content}`;
		const currentVisible = visibleWidth(fullBar);
		const fillWidth = Math.max(0, width - currentVisible);

		// 背景填充保持整条背景一致
		const emptyPad = " ".repeat(fillWidth);
		const line = `${fullBar}${th.bg("userMessageBg", emptyPad)}`;

		return [truncateToWidth(line, width)];
	}

	invalidate(): void {}
	dispose(): void {}
}

export default function (pi: ExtensionAPI) {
	const state: TopBarState = {
		status: "idle",
		visible: true,
	};

	let topBarComponent: TopStatusBarComponent | null = null;
	let currentContext: ExtensionContext | null = null;
	let tuiInstance: TUI | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;

	const removeOverlay = () => {
		overlayHandle?.hide();
		overlayHandle = null;
	};

	const refreshWidget = () => {
		if (!currentContext || currentContext.mode !== "tui" || !topBarComponent || !tuiInstance) return;
		if (state.visible && !overlayHandle) {
			overlayHandle = tuiInstance.showOverlay(topBarComponent, {
				anchor: "top-left",
				row: 0,
				col: 0,
				width: "100%",
				maxHeight: 1,
				margin: 0,
				nonCapturing: true,
			});
		} else if (!state.visible) {
			removeOverlay();
		}
		topBarComponent.invalidate();
		tuiInstance.requestRender();
	};

	// 运行计时器
	const startTimer = () => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (state.status === "running") {
				refreshWidget();
			}
		}, 1000);
	};

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	// 1. Agent 开始执行
	pi.on("agent_start", async (_event, ctx) => {
		currentContext = ctx;
		state.status = "running";
		state.startTime = Date.now();
		state.errorMessage = undefined;
		state.activeTool = undefined;
		state.modelId = ctx.model?.id;
		state.provider = ctx.model?.provider;
		state.thinkingLevel = ctx.thinkingLevel;
		startTimer();
		refreshWidget();
	});

	// 2. 观察工具执行
	pi.on("tool_execution_start", async (event, ctx) => {
		currentContext = ctx;
		if (state.status === "running") {
			state.activeTool = event.toolName;
			refreshWidget();
		}
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		currentContext = ctx;
		if (state.status === "running") {
			state.activeTool = undefined;
			refreshWidget();
		}
	});

	// 3. 错误检测：捕捉 Assistant 消息中的错误信息或中断
	pi.on("message_end", async (event, _ctx) => {
		const msg = event.message as any;
		if (msg && msg.role === "assistant") {
			if (msg.stopReason === "error" || msg.errorMessage) {
				state.status = "error";
				state.errorMessage = msg.errorMessage || "Agent execution failed";
			}
		}
	});

	// 4. Agent 完成/退出到提示词输入行
	pi.on("agent_settled", async (event, ctx) => {
		currentContext = ctx;
		stopTimer();
		if (state.startTime) {
			state.durationMs = Date.now() - state.startTime;
		}

		if (event.aborted) {
			state.status = "aborted";
			state.errorMessage = "User interrupted";
		} else if (state.status !== "error") {
			state.status = "idle";
			state.errorMessage = undefined;
		}

		state.activeTool = undefined;
		state.modelId = ctx.model?.id;
		state.provider = ctx.model?.provider;
		state.thinkingLevel = ctx.thinkingLevel;
		refreshWidget();
	});

	// 5. 模型与思考等级变更监听
	pi.on("model_select", async (event, ctx) => {
		currentContext = ctx;
		state.modelId = event.model.id;
		state.provider = event.model.provider;
		refreshWidget();
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		currentContext = ctx;
		state.thinkingLevel = event.level;
		refreshWidget();
	});

	// 6. 会话初始化
	pi.on("session_start", async (_event, ctx) => {
		currentContext = ctx;
		state.modelId = ctx.model?.id;
		state.provider = ctx.model?.provider;
		state.thinkingLevel = ctx.thinkingLevel;

		if (ctx.mode !== "tui") return;
		// The empty widget owns overlay cleanup and supplies Pi's TUI/theme.
		// Its slot renders no lines; only the viewport-relative overlay is visible.
		ctx.ui.setWidget("ipiui_status_bar", (tui, theme) => {
			removeOverlay();
			tuiInstance = tui;
			topBarComponent = new TopStatusBarComponent(state, theme, ctx);
			refreshWidget();
			return {
				render: () => [],
				invalidate: () => topBarComponent?.invalidate(),
				dispose: () => {
					stopTimer();
					removeOverlay();
					topBarComponent = null;
					tuiInstance = null;
				},
			};
		});
		ctx.ui.notify("ipiui 顶部悬浮状态栏已加载", "info");
	});

	// 7. 会话关闭时清理
	pi.on("session_shutdown", async () => {
		stopTimer();
		removeOverlay();
		topBarComponent = null;
		tuiInstance = null;
		currentContext = null;
	});

	// 8. 命令：切换悬浮条显示/隐藏
	pi.registerCommand("topbar", {
		description: "切换状态栏显示/隐藏 (/topbar [on|off|toggle])",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const action = args.trim().toLowerCase();
			if (action === "on") {
				state.visible = true;
			} else if (action === "off") {
				state.visible = false;
			} else {
				state.visible = !state.visible;
			}

			ctx.ui.notify(`状态栏已${state.visible ? "开启" : "关闭"}`, "info");
			refreshWidget();
		},
	});
}
