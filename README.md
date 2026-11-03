# ipiui - Pi Top Floating Status Bar

A clean, non-intrusive floating status bar extension for the [Pi coding agent](https://github.com/earendil-works/pi).

## Features

- 🚀 **Real-time Status Overlay**: Floats at the very top of your terminal window (`top-center`, `100%` width).
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

## License

MIT
