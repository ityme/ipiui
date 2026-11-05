# ipiui — Pi status row and split-pane titles

A refined information row **above Pi's native prompt editor**, featuring **discrete semantic color pills** (or transparent classic text), with no footer below the editor. Works in Pi's regular terminal mode without overlays.

```text
Chat messages…

 ⠿ RDY 0s ●   📁 ipiui    dev   🤖 gemini-3.8-flash   ✦ high   ⬆️ 15.0M  ⬇️ 167k  💰 21.12¥   CTX ━━━━──── 2% 15.6k/1M
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Your prompt
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

[View the styles gallery](docs/styles-gallery.html).

## Display Styles

Switch styles anytime with `/topbar style [split|pills|classic|border]`:

- **`split` (Default · Option A)**: Modern dual-split statusline inspired by [agent_statusline_preview.html]. Left side anchors primary identity (animated status icon, project folder, git branch); right side displays telemetry (model, color-coded thinking level, tokens, cost, ctx).
- **`pills` (Option 4)**: Sequential discrete micro-pills with 20% tinted backgrounds and semantic foreground colors. Trailing border line cleanly fills the rest of the window.
- **`classic` (Option 1)**: Pure transparent background with clean colored text blocks separated by dots (`──── ✓ · gemini-3.8-flash · ✦ high · ... ────`).
- **`border` (Option 2)**: Pure transparent background with a dynamic status-colored indicator bar on the left edge (`▌ ✓ · ... ────`).

Information order:

1. 状态徽章固定宽度（**⠿ RDY 0s ●**）并显示符号与文字之间的空格：空闲为 `⠿ RDY 0s ●`、运行中为 `⠋ RUN 6s ●`、错误为 `✗ ERR 4s ●`、停止为 `■ STP 2s ●`。状态码统一三个字符，耗时一律使用 `s`，切换状态时胶囊宽度保持不变。
2. 项目名和 Git 分支：`📁 ipiui`、` dev`。
3. 模型与思考等级共用一个模块：`[🤖 gemini-3.8-flash · high]`，`med` 显示为 `medium`。
4. Token 显示为 `⬆️ 15.0M ⬇️ 167k`。不再显示难以理解的 `Σ` 总量。
5. 费用使用 `💰 21.12¥` 格式；Pi 的累计费用本身仍以美元估算数值显示，只是按要求使用 `¥` 外观标记，并不进行货币汇率转换。
6. CTX 胶囊包含字符进度条、百分比和已用/上限。模型、Token/费用和 CTX 三个模块的全部文字（包括括号）共享连续的动态彩虹色带；保留各模块背景色，CTX 不再使用固定压力色。
7. 状态与数据块使用相邻空格分隔，不加入括号、竖线等额外分隔符。

Totals follow Pi's footer accounting across all session entries, including usage entries, tools, compaction and branch summaries. They are not restricted to the latest response or the post-compaction context.

Pi retains ownership of editing, completion, paste, interrupt, shortcuts, IME markers and mouse coordinates. Completion menus still appear temporarily below the input border when active; the idle footer is empty.

## Try it

```bash
pi -e I:/ispace/ipiui
```

For an existing session started with this extension, run `/reload` after updates.

For permanent installation, add the path to the existing `extensions` array in your Pi settings, preserving other entries:

```json
{
  "extensions": ["I:/ispace/ipiui"]
}
```

This extension restores the native editor and hides the footer. Disable competing editor/footer extensions such as `pi-powerline-footer`. It does not change your global configuration automatically or remove widgets owned by unrelated extensions.

## Commands

- `/topbar` or `/topbar toggle` — toggle status row visibility.
- `/topbar on` / `/topbar off` — show or hide status row.
- `/topbar split` — switch to dual-split layout (Default · Option A).
- `/topbar pills` — switch to discrete micro-pills (Option 4).
- `/topbar classic` — switch to pure transparent colored text (Option 1).
- `/topbar border` — switch to pure transparent with left accent indicator (Option 2).

## Windows Terminal split-pane titles

All Pi instances **automatically join a shared title group (`all`) on startup**. No commands are required.

When running multiple split panes in Windows Terminal, each pane publishes a compact combined title:

```text
[1▶api 2✓web 3○cmd]
```

- `/tabname NAME` — change this pane's short label from `cmd` to `NAME`.
- `/tabgroup NAME` — isolate this pane into a custom group.
- `/tabgroup off` — disable title management and restore to `pi`.

## Development and checks

Tested against Pi 1.5.0.

```bash
npm run check
npm test
```

Tests cover three real themes, truecolor/256-color contrast, CJK/emoji rendering, usage accounting, field order, regular-mode placement without overlays, empty footer, branch updates, parallel tools, lifecycle/cleanup, native prompt without an added `>`, wrapping, IME markers, mouse placement, paste, completion and shortcuts. Title tests cover independent Node processes, command/event integration, completion/error status, group isolation, label sanitization, stale peers, cleanup and opt-out.
