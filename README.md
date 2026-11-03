# ipiui - Pi Top Floating Status Bar

A clean, non-intrusive floating status bar extension for the [Pi coding agent](https://github.com/earendil-works/pi).

## Features

- 🚀 **Real-time Status Bar**: Displays a persistent, full-width widget above the prompt editor.
- ⚡ **Passive & Non-capturing**: Does not capture focus or interfere with prompt typing, autocomplete, or keyboard shortcuts.
- ⏱ **Live Execution Timer & Tool Tracking**: Displays execution duration and active tool (e.g. `bash`, `edit`, `read`) while the agent runs.
- 🤖 **Model & Thinking Level**: Shows current LLM model (`provider/modelId`) and reasoning/thinking level.
- 📊 **Context Token Usage**: Displays active token count and percentage of context window.
- ⚠️ **Error & Exit Indicators**: Clearly signals when an agent turn ends due to an error, rate limit, or user abort (`Esc`/`Ctrl+C`).
- 🎨 **Adaptive Theming**: Automatically blends with Pi's active color theme.
- ⌨️ **Commands**: Toggle on/off anytime with `/topbar`.

## Installation

### Local testing
In your terminal / project directory:
```bash
pi -e I:/ispace/ipiui
```

### Global installation
Add to your `~/.pi/agent/settings.json`:
```json
{
  "extensions": [
    "I:/ispace/ipiui"
  ]
}
```

## Usage

- `/topbar` — Toggle top status bar visibility
- `/topbar on` — Show status bar
- `/topbar off` — Hide status bar

## Verification

Run `npm test` to check all status badges using Pi 1.5.0's real `dark`, `light`, and `system` themes, narrow terminal widths, context usage, and lifecycle transitions. Tests use installed Pi development peers or the default Pi 1.5.0 installation; set `PI_TEST_HOST_ROOT` to its `node_modules` directory if it is elsewhere.

After updating the extension, restart Pi with `pi -e I:/ispace/ipiui` (or run `/reload` in an instance started with that option). Send a prompt to check `RUNNING`, then press Escape during execution to check `STOPPED`.

## License

MIT
