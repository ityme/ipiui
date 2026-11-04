# ipiui — Pi status row and split-pane titles

A refined information row **above Pi's native prompt editor**, featuring **discrete semantic color pills** (or transparent classic text), with no footer below the editor. Works in Pi's regular terminal mode without overlays.

```text
Chat messages…

 ✓   gemini-3.8-flash   ✦ high   📁 ipiui (dev)   ↑15.0M ↓167k Σ77.2M   $21.12   ctx 15.6k (2%) ─────────────────
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
Your prompt
─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
```

[View the styles gallery](docs/styles-gallery.html).

## Display Styles

Switch styles anytime with `/topbar style [pills|classic|border]`:

- **`pills` (Default · Option 4)**: Modern discrete micro-pills with 20% semi-transparent tinted backgrounds and semantic foreground colors. Contrast ratio ≥ 5.6:1 in dark mode, ≥ 12.0:1 in light mode. Trailing border line cleanly fills the rest of the window.
- **`classic` (Option 1)**: Pure transparent background with clean colored text blocks separated by dots (`──── ✓ · gemini-3.8-flash · ✦ high · ... ────`).
- **`border` (Option 2)**: Pure transparent background with a dynamic status-colored indicator bar on the left edge (`▌ ✓ · ... ────`).

Information order:

1. Running state symbol: `✓` for idle, animated braille frame + elapsed seconds (e.g. `⠋ 6s (bash)`) while active, `✗` for error, or `■` for stopped.
2. Short model ID.
3. Color-coded thinking level: `✦ high`/`✦ max` (sky blue), `✦ medium` (amber), `✦ low` (emerald), `✦ off` (slate). No brain emoji.
4. Project name and Git branch: `📁 ipiui (dev)`.
5. `↑` cumulative input tokens, `↓` cumulative output tokens, and `Σ` total tokens.
6. Cumulative dollar cost reported by Pi.
7. Context tokens, window and percentage.
8. Trailing horizontal line (`───`) auto-fills to the full window width.

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
- `/topbar pills` — switch to discrete micro-pills (Default · Option 4).
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
