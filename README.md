# ipiui — Pi status row and split-pane titles

A status row **above Pi's native prompt editor**, with bracketed color blocks and no footer below the editor. Works in Pi's regular terminal mode without overlays.

```text
Chat messages…

[⠿ idle 10s]  [📁 ipiui dev] [🤖 gemini-3.8-flash · high] [⬆️15.0M ⬇️167.0k 💰 21.12¥] [CTX ━─────── 2% 15.6k/1M]
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Your prompt
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

[View the styles gallery](docs/styles-gallery.html).

## Status row

The status block sits on the left; project/branch, model/thinking, usage and context blocks sit on the right. Blocks that do not fit are hidden by priority. The gallery contains design previews; runtime style switching is not implemented.

Information order:

1. 状态徽章按内容宽度显示：`[⠿ idle 10s]`、`[⠋ running 6s]`、`[✗ error 4s]`、`[■ aborted 2s]`。idle 为灰色，running 为绿色；耗时按天、时、分、秒显示，不补尾部空格，无耗时隐藏时间。名称来自扩展对 Pi 生命周期事件的映射；Pi 没有直接提供统一的状态标签 API。
2. 项目名和 Git 分支：`📁 ipiui`、` dev`。
3. 模型与思考等级共用一个模块：`[🤖 gemini-3.8-flash · high]`，`med` 显示为 `medium`。
4. Token 显示为 `⬆️ 15.0M ⬇️ 167k`。不再显示难以理解的 `Σ` 总量。
5. 费用使用 `💰 21.12¥` 格式；Pi 的累计费用本身仍以美元估算数值显示，只是按要求使用 `¥` 外观标记，并不进行货币汇率转换。
6. CTX 胶囊包含字符进度条、百分比和已用/上限。模型、Token/费用和 CTX 三个模块的全部文字（包括括号）共享连续的动态彩虹色带；保留各模块背景色，CTX 不再使用固定压力色。
7. 五个模块分别以 `[]` 包裹，模块之间使用空格分隔。

Totals follow Pi's footer accounting across all session entries, including usage entries, tools, compaction and branch summaries. They are not restricted to the latest response or the post-compaction context.

Pi retains ownership of editing, completion, paste, interrupt, shortcuts, IME markers and mouse coordinates. Completion menus still appear temporarily below the input border when active; the idle footer is empty.

## Install

Requires Pi 1.5.0 (tested) and Node.js 22.19 or newer. Pi loads the TypeScript entry directly; no build step or runtime dependency installation is needed for a local checkout.

Install a local checkout now:

```bash
pi install I:/ispace/ipiui
```

For project-only installation, run `pi install ./path/to/ipiui --local` from the target project. Relative package paths resolve from the settings file. A local installation loads the checkout in place, so keep that directory available.

After these changes are pushed to the GitHub repository, install from Git:

```bash
pi install git:github.com/ityme/ipiui
```

After the package is published to npm, the npm installation command is:

```bash
pi install npm:ipiui
```

The Git and npm commands require the corresponding remote package to be available; creating a local release archive does not publish it. Use `pi list` to inspect installed packages. To remove a local installation, run `pi remove I:/ispace/ipiui`; for Git or npm, pass the same source used to install it.

Restart Pi or run `/reload` after installation. `/ipiui` shows help. To try the checkout for one invocation without saving settings:

```bash
pi -e I:/ispace/ipiui
```

If you previously added this directory to the `extensions` array manually, remove that duplicate entry when switching to `pi install`.

This extension restores the native editor and hides the footer. Disable competing editor/footer extensions such as `pi-powerline-footer`. Only `pi install` modifies package settings; the extension itself does not edit global configuration or remove widgets owned by unrelated extensions.

## Commands

Unified `/ipiui` commands (with backward-compatible aliases `/topbar`, `/tabname`, `/tabgroup`):

- `/ipiui` or `/ipiui help` — display help information.
- `/ipiui [on|off|toggle]` — toggle top status row visibility.
- `/ipiui name [NAME]` — view or set this pane's short title label.
- `/ipiui group [NAME|off]` — view, switch, or disable title synchronization group.
- `/ipiui status` — display current configuration overview.

## Windows Terminal split-pane titles

All Pi instances **automatically join a shared title group (`all`) on startup**. Set `IPIUI_GROUP` before starting Pi to override it. This default group spans terminal windows; automatic per-window isolation is not implemented. `WT_SESSION` identifies a pane connection, so it cannot group all panes in one window.

Use the same `/ipiui group NAME` in panes that should share titles and a different name in other windows. New panes need the same group name or `IPIUI_GROUP` setting; environment changes in an existing pane are not guaranteed to propagate to newly split panes.

When running multiple split panes in Windows Terminal, each pane publishes a compact combined title:

```text
⠋api ┃ web ┃ ipiui
```

- `/ipiui name NAME` — change this pane's short label from the project directory name to `NAME`.
- `/ipiui group NAME` — isolate this pane into a custom group.
- `/ipiui group off` — disable title management and restore to `pi`.

Only running members show a braille spinner; finished/idle members show their label alone. Every member animates cached peer records at 100ms intervals while any member is running; disk synchronization runs once per second. Animation frames do not read or write files. Unchanged titles are not republished by animation/sync callbacks; a separate 1.5s heartbeat reasserts the title when Pi overwrites it. Status animation skips redraw requests while the row is hidden, and fixed palettes and visible rainbow-block text segmentation are cached. Cross-process state uses per-member temporary JSON files with atomic replacement; shutdown removes only that member's files. All timers stop on shutdown or group opt-out.

Windows Terminal titles are plain text: individual project labels cannot use the status row's ANSI colors. No title color escape sequences are emitted.

## License

GNU General Public License v3.0 only (`GPL-3.0-only`). See [LICENSE](LICENSE).

## Development and checks

Tested against Pi 1.5.0.

```bash
npm run check
npm test
npm run check:package
```

`check:package` runs `npm pack`, extracts the artifact, installs it with the real Pi CLI into an isolated configuration directory, and verifies Pi discovers and loads the packaged extension. It does not use your global settings or call a model. If Pi is installed outside the standard location, set `PI_TEST_HOST_ROOT` to its `node_modules` directory.

Create a release archive with `npm pack --pack-destination dist` (create `dist` first). The tarball contains only the extension source, package metadata, license, changelog, README and HTML gallery. To install an archive locally, extract it and run `pi install /absolute/path/to/extracted/package`; a raw `.tgz` path is not a Pi local extension directory.

Tests cover three real themes, terminal width handling, CJK/emoji rendering, usage accounting, field order, regular-mode placement without overlays, empty footer, branch updates, parallel tools, lifecycle/cleanup, native prompt without an added `>`, wrapping, IME markers, mouse placement, paste, completion and shortcuts. Title tests cover independent Node processes, command/event integration, completion/error status, group isolation, label sanitization, stale peers, cleanup and opt-out.
