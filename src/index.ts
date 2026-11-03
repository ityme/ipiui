import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type OverlayHandle,
	type TUI,
	sliceByColumn,
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
		let badgeText = " READY ";
		let badgeRendered = th.bg("selectedBg", th.fg("text", " ● READY "));

		if (st.status === "running") {
			const elapsed = st.startTime ? Math.floor((Date.now() - st.startTime) / 1000) : 0;
			const timeStr = `${elapsed}s`;
			badgeText = ` RUNNING ${timeStr} `;
			badgeRendered = th.bg("accent", th.bold(th.fg("text", ` 🚀 RUNNING ${timeStr} `)));
		} else if (st.status === "error") {
			badgeText = " ERROR ";
			badgeRendered = th.bg("error", th.bold(th.fg("text", " ✖ ERROR ")));
		} else if (st.status === "aborted") {
			badgeText = " STOPPED ";
			badgeRendered = th.bg("warning", th.bold(th.fg("text", " ⏹ STOPPED ")));
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
			if (usage && usage.totalTokens && usage.contextWindow) {
				const pct = Math.round((usage.totalTokens / usage.contextWindow) * 100);
				const kTokens = (usage.totalTokens / 1000).toFixed(1);
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
				// 放不下了，截断退出
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

	let tuiInstance: TUI | null = null;
	let overlayHandle: OverlayHandle | null = null;
	let topBarComponent: TopStatusBarComponent | null = null;
	let timer: NodeJS.Timeout | null = null;

	const requestRender = () => {
		if (tuiInstance) {
			topBarComponent?.invalidate();
			tuiInstance.requestRender();
		}
	};

	// 运行计时器
	const startTimer = () => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (state.status === "running") {
				requestRender();
			}
		}, 1000);
	};

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	// --- 状态监听 ---

	// 1. Agent 开始执行
	pi.on("agent_start", async (_event, ctx) => {
		state.status = "running";
		state.startTime = Date.now();
		state.errorMessage = undefined;
		state.activeTool = undefined;
		state.modelId = ctx.model?.id;
		state.provider = ctx.model?.provider;
		state.thinkingLevel = ctx.thinkingLevel;
		startTimer();
		requestRender();
	});

	// 2. 观察工具执行
	pi.on("tool_execution_start", async (event, _ctx) => {
		if (state.status === "running") {
			state.activeTool = event.toolName;
			requestRender();
		}
	});

	pi.on("tool_execution_end", async (_event, _ctx) => {
		if (state.status === "running") {
			state.activeTool = undefined;
			requestRender();
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
		requestRender();
	});

	// 5. 模型与思考等级变更监听
	pi.on("model_select", async (event, _ctx) => {
		state.modelId = event.model.id;
		state.provider = event.model.provider;
		requestRender();
	});

	pi.on("thinking_level_select", async (event, _ctx) => {
		state.thinkingLevel = event.level;
		requestRender();
	});

	// 6. 会话初始化时挂载 Overlay
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		state.modelId = ctx.model?.id;
		state.provider = ctx.model?.provider;
		state.thinkingLevel = ctx.thinkingLevel;

		// 利用 widget factory 获取 tui 与 theme 实例
		ctx.ui.setWidget("__ipiui_topbar_mount", (tui, theme) => {
			tuiInstance = tui;

			if (!overlayHandle) {
				topBarComponent = new TopStatusBarComponent(state, theme, ctx);
				overlayHandle = tui.showOverlay(topBarComponent, {
					anchor: "top-center",
					width: "100%",
					offsetY: 0,
					nonCapturing: true,
				});
			} else {
				topBarComponent?.updateState(state, theme);
			}

			// 返回空组件，不在原 widget 槽位占用多余高度
			return {
				render: () => [],
				invalidate: () => {},
				dispose: () => {},
			};
		});
	});

	// 7. 会话关闭时清理
	pi.on("session_shutdown", async () => {
		stopTimer();
		if (overlayHandle) {
			overlayHandle.hide();
			overlayHandle = null;
		}
		topBarComponent = null;
		tuiInstance = null;
	});

	// 8. 命令：切换悬浮条显示/隐藏
	pi.registerCommand("topbar", {
		description: "Toggle top floating status bar visibility (/topbar [on|off|toggle])",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on") {
				state.visible = true;
			} else if (action === "off") {
				state.visible = false;
			} else {
				state.visible = !state.visible;
			}

			ctx.ui.notify(`Top status bar: ${state.visible ? "ON" : "OFF"}`, "info");
			requestRender();
		},
	});
}
