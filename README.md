# ipiui — Pi status row and green prompt

A rainbow information row **above the prompt editor**, with a **bold green `>`** and no footer below the editor. Works in Pi's regular terminal mode; it does not use an overlay or require fullscreen mode.

```text
Chat messages…

──── READY gemini3.8flash · high · ↑1.2k · ↓300 · Σ2.5k · $0.123 · ctx 19% · dev · I:/ispace/ipiui ────
────────────────────────────────────────────────────────────────────────────────────────────────────
> Your prompt
────────────────────────────────────────────────────────────────────────────────────────────────────
```

[View the layout and rainbow style](docs/rainbow-preview.svg).

## Display

Information order:

1. Running state: `READY`, `RUNNING` with elapsed seconds and active tools, `ERROR`, or `STOPPED`.
2. Short model ID and thinking level.
3. `↑` cumulative input tokens and `↓` cumulative output tokens for the session.
4. `Σ` cumulative input + output + cache-read + cache-write tokens. Reasoning is already part of output and is not counted twice.
5. Cumulative dollar cost reported by Pi: provider-billed cost when available, otherwise Pi's model-price estimate. A zero value may indicate that pricing is unavailable, not necessarily a free request.
6. Context tokens, context window and percentage. Unknown usage after compaction is shown as `ctx ?`.
7. Git branch (`no-git` outside a repository) and current directory.

Totals follow Pi's footer accounting across all session entries, including usage entries, tools, compaction and branch summaries. They are not restricted to the latest response or the post-compaction context.

The rainbow background fills the full row in truecolor or 256-color terminals. Narrow windows shorten the model and directory, then drop trailing fields to preserve state/model/thinking first. At extremely small editor widths (below six columns), a minimal cursor view avoids breaking wide-character wrapping; widening the terminal restores the prompt text.

The editor retains Pi's editing, completion, paste, interrupt and app shortcuts, with a two-column prompt gutter. The IME cursor marker and mouse coordinates are preserved. Completion menus still appear temporarily below the input border when active; the idle footer is empty.

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

This extension owns the editor component and hides the footer. Disable competing editor/footer extensions such as `pi-powerline-footer`. It does not change your global configuration automatically or remove widgets owned by unrelated extensions.

## Commands

- `/topbar` or `/topbar toggle` — toggle the information row.
- `/topbar on` — show the row.
- `/topbar off` — hide the row; keep the green prompt and empty footer.

The command name is retained for compatibility; the row is no longer at the viewport top. Regular terminal history scrollback still scrolls the whole rendered interface, but the row occupies its own space and never overlays chat text.

## Development and checks

Tested against Pi 1.5.0. Install the TypeScript development dependency without auto-installing Pi's host-provided peers:

```bash
npm install --legacy-peer-deps
npm run check
npm test
```

Checks use installed development peers or the default Pi 1.5.0 installation under `~/.pi/agent/install/releases/1.5.0/node_modules`. Set `PI_TEST_HOST_ROOT` to Pi's `node_modules` directory for a different location. Pi supplies runtime imports when loading the extension; no compiled build is required.

Tests cover three real themes, truecolor/256-color contrast, CJK/emoji rendering, usage accounting, field order, regular-mode placement without overlays, empty footer, branch updates, parallel tools, lifecycle/cleanup, bold green prompt, wrapping, IME markers, mouse placement, paste, completion and shortcuts. These are in-memory renderer tests, not physical-terminal or IME integration tests.

Manual verification: restart/reload, send a task, interrupt with Escape, switch models/thinking level, use Tab completion and paste multiline text. Confirm the information row stays above the editor and the default footer is gone.
