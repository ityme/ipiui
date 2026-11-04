# ipiui — Pi status row and split-pane titles

A rainbow information row **above Pi's native prompt editor**, with **no added `>`** and no footer below the editor. Works in Pi's regular terminal mode; it does not use an overlay or require fullscreen mode.

```text
Chat messages…

──── READY gemini3.8flash · high · ↑1.2k · ↓300 · Σ2.5k · $0.123 · ctx 19% · dev · I:/ispace/ipiui ────
────────────────────────────────────────────────────────────────────────────────────────────────────
Your prompt
────────────────────────────────────────────────────────────────────────────────────────────────────
```

[View the layout and rainbow style](docs/rainbow-preview.svg).

## Display

Information order:

1. Running state symbol: `✓` for idle, animated braille frame + elapsed seconds (e.g. `⠋ 6s (bash)`) while active, `✗` for error, or `■` for stopped.
2. Short model ID and color-coded thinking level (sky blue for high/max, warm amber for medium, green for low, muted slate for off).
3. Project name and Git branch (e.g. `ipiui (dev)`).
4. `↑` cumulative input tokens and `↓` cumulative output tokens for the session.
5. `Σ` cumulative input + output + cache-read + cache-write tokens. Reasoning is already part of output and is not counted twice.
6. Cumulative dollar cost reported by Pi: provider-billed cost when available, otherwise Pi's model-price estimate. A zero value may indicate that pricing is unavailable, not necessarily a free request.
7. Context tokens, context window and percentage. Unknown usage after compaction is shown as `ctx ?`.
8. The right side automatically fills the rest of the line with a horizontal bar (`────`), keeping the flowing subdued rainbow background across the full terminal width.

Totals follow Pi's footer accounting across all session entries, including usage entries, tools, compaction and branch summaries. They are not restricted to the latest response or the post-compaction context.

The status row features a **subdued, elegant rainbow atmospheric tint** (mixed into dark or light terminal backgrounds) rather than a harsh solid neon background, maintaining high contrast (≥ 7.6:1 in dark mode, ≥ 12.5:1 in light mode) while gently flowing over time. Narrow windows shorten the model and directory, then drop trailing fields to preserve state/model/thinking first. The editor itself is Pi's native editor, without a custom prompt gutter.

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

- `/topbar` or `/topbar toggle` — toggle the information row.
- `/topbar on` — show the row.
- `/topbar off` — hide the row; keep the native editor and empty footer.

The command name is retained for compatibility; the row is no longer at the viewport top. Regular terminal history scrollback still scrolls the whole rendered interface, but the row occupies its own space and never overlays chat text.

## Windows Terminal split-pane titles

By default, all Pi instances **automatically join a shared title group (`all`) on startup**. No commands are required.

When running multiple split panes in Windows Terminal, each pane publishes a compact combined title such as:

```text
[1▶api 2✓web 3○cmd]
```

- Compact layout saves tab bar space without pipe separators (`[1▶api 2✓web]`).
- `/tabname NAME` — change this pane's short label from `cmd` to `NAME` (e.g., `/tabname api`).
- `/tabgroup NAME` — isolate this pane into a custom group name (e.g., `/tabgroup projectA`).
- `/tabgroup off` — disable title management for this pane and restore title to `pi`.
- `/tabgroup` — show current group and pane label.
- Symbols: `○` initial idle, `▶` running, `✓` completed, `✗` error, `■` interrupted.

Membership is manual. Use different group names for different tabs/windows; the extension cannot infer Windows Terminal's tab membership or actual pane order. Numbers follow member join order, not screen position, and may change after leaving/rejoining. `/reload` removes the old member; rejoin the group after reload. Normal shutdown removes membership, while a crashed member stops appearing after 15 seconds without a heartbeat. Updates from peers arrive about once per second.

State is shared through per-user temporary files (`ipiui-tabs-<user-hash>/<group-hash>/<member-id>.json`). Each Pi writes only its own atomically replaced file. Records contain an opaque ID, timestamps, status and short label; no prompts, credentials, cwd or model data. Stale peer files are ignored rather than deleted; each member deletes only its own files on clean shutdown. Group names are routing labels, not an authentication or security boundary against other local processes.

Windows Terminal must allow application titles (`suppressApplicationTitle: false`) and the tab must not have a manually overridden title. Other title writers, including `orca-titlebar-spinner` and shell hooks, can overwrite it; disable conflicting writers manually if the title flickers. This extension does not change Terminal settings or disable other extensions. It cannot recover the previous title, so leaving resets to `pi`.

Rollback checkpoint before this experiment: `f9480a8`. Prefer reverting the experiment commit rather than resetting if you have subsequent work.

References: [Microsoft title behavior](https://learn.microsoft.com/en-us/windows/terminal/tutorials/tab-title), [application title settings](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-advanced#suppress-title-changes).

## Development and checks

Tested against Pi 1.5.0. Install the TypeScript development dependency without auto-installing Pi's host-provided peers:

```bash
npm install --legacy-peer-deps
npm run check
npm test
```

Checks use installed development peers or the default Pi 1.5.0 installation under `~/.pi/agent/install/releases/1.5.0/node_modules`. Set `PI_TEST_HOST_ROOT` to Pi's `node_modules` directory for a different location. Pi supplies runtime imports when loading the extension; no compiled build is required.

Tests cover three real themes, truecolor/256-color contrast, CJK/emoji rendering, usage accounting, field order, regular-mode placement without overlays, empty footer, branch updates, parallel tools, lifecycle/cleanup, native prompt without an added `>`, wrapping, IME markers, mouse placement, paste, completion and shortcuts. Title tests cover independent Node processes, command/event integration, completion/error status, group isolation, label sanitization, stale peers, cleanup and opt-out. These are in-memory renderer tests, not physical-terminal or IME integration tests.

Manual verification: restart/reload, send a task, interrupt with Escape, switch models/thinking level, use Tab completion and paste multiline text. Confirm there is no `>`, the information row stays above the editor and the default footer is gone. Join the same title group in two Windows Terminal panes, run/interrupt tasks independently, and change focus between panes to check the actual tab title; this UI behavior is not covered by the in-memory or IPC tests.
