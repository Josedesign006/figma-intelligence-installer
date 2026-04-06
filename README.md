# Figma Intelligence

AI-powered design tools for Figma. 88 MCP tools that give your AI assistant (Claude, Cursor, VS Code) the ability to read, create, audit, and modify Figma designs.

---

## Quick Start

### Prerequisites

- **Node.js 18+** — [download here](https://nodejs.org/)
- **Figma Desktop** — [download here](https://www.figma.com/downloads/)
- **Figma Personal Access Token** — [generate here](https://www.figma.com/developers/api#access-tokens)

### Install

```bash
npx figma-intelligence setup
```

This installs everything and registers MCP tools with Claude, Cursor, and VS Code automatically.

### Start

```bash
npx figma-intelligence start
```

### Load the Figma plugin

1. Open **Figma Desktop** and open any design file
2. Go to **Plugins > Development > Import plugin from manifest**
3. Select `~/.figma-intelligence/plugin/manifest.json`
4. Run the plugin — you should see **Connected**

### Use it

Open your AI tool and try:

> "Audit this Figma page for accessibility issues"

> "Clone this screenshot into Figma using the design system"

> "Generate a React component from the selected Figma component"

---

## Commands

| Command | Description |
|---------|-------------|
| `npx figma-intelligence setup` | Install and configure |
| `npx figma-intelligence start` | Start the relay |
| `npx figma-intelligence stop` | Stop the relay |
| `npx figma-intelligence status` | Check connection |

---

## How It Works

```
Your Machine                              Cloud
+-------------------+                    +------------------+
|  Figma Desktop    |                    |  88 MCP Tools    |
|  (plugin inside)  |                    |  (AI intelligence|
|        |          |                    |   runs here)     |
|        v          |    encrypted       |        ^         |
|  Local Relay  ----+----- tunnel -------+-> Tool Router    |
+-------------------+                    +------------------+
        ^
        |
  Claude / Cursor / VS Code
```

Your design files stay in Figma. No design data is stored on the server.

---

## Troubleshooting

**Plugin shows "Bridge offline"**
- Click the **Reconnect** button in the plugin
- Or restart the relay: `npx figma-intelligence stop && npx figma-intelligence start`

**Plugin shows "Not logged in"**
- Click the **Log in** button in the plugin
- Or run `claude login` in your terminal

**MCP tools not showing in your AI tool**
- Restart Claude / Cursor / VS Code after running setup
- Check: `npx figma-intelligence status`

**Relay won't start**
- Stop existing relay: `npx figma-intelligence stop`
- Check port: `lsof -i :9001`

**Updating to latest version**
- Just re-run setup — it preserves your config:
  ```bash
  npx figma-intelligence@latest setup
  npx figma-intelligence start
  ```

---

## License

CC-BY-NC-ND-4.0
