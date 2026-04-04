# Figma Intelligence

AI-powered design tools for Figma. 88 MCP tools that give your AI assistant (Claude, Cursor, VS Code) the ability to read, create, audit, and modify Figma designs.

---

## Setup (2 minutes)

### Prerequisites

- **Node.js 18+** — [download here](https://nodejs.org/) if you don't have it
- **Figma Desktop app** — [download here](https://www.figma.com/downloads/)
- **An AI tool with MCP support** — Claude Desktop, Cursor, or VS Code
- **Figma Personal Access Token** — [generate one here](https://www.figma.com/developers/api#access-tokens)

### Step 1: Install and configure

Open your terminal and run:

```bash
npx figma-intelligence setup
```

This will:
- Download the relay binary for your platform
- Ask for your Figma access token
- Automatically register the MCP server with Claude Desktop, Cursor, and VS Code

### Step 2: Start the relay

```bash
npx figma-intelligence start
```

This starts a lightweight local process that bridges your AI tool to Figma.

### Step 3: Open Figma

1. Open **Figma Desktop**
2. Open any design file
3. Go to **Plugins** > **Development** > **Import plugin from manifest**
4. Navigate to `~/.figma-intelligence/plugin/manifest.json` and select it
5. Run the plugin — you should see "Connected" in the plugin UI

### Step 4: Use it

Open your AI tool (Claude Desktop, Cursor, or VS Code) and start using Figma tools. Try:

> "Audit this Figma page for accessibility issues"

> "Clone this screenshot into Figma using the design system"

> "Generate a React component from the selected Figma component"

Your AI assistant now has direct access to your Figma file.

---

## Commands

```bash
npx figma-intelligence setup    # First-time setup
npx figma-intelligence start    # Start the local relay
npx figma-intelligence stop     # Stop the relay
npx figma-intelligence status   # Check connection status
```

---

## How It Works

```
Your Machine                              Cloud
+-------------------+                    +------------------+
|  Figma Desktop    |                    |  88 MCP Tools    |
|  (plugin runs     |                    |  (AI intelligence|
|   inside Figma)   |                    |   runs here)     |
|        |          |                    |        ^         |
|        v          |    encrypted       |        |         |
|  Local Relay  ----+----- tunnel -------+-> Tool Router    |
|  (port 9001)      |                    |                  |
+-------------------+                    +------------------+
        ^
        |
  Claude / Cursor / VS Code
  (connects to cloud MCP endpoint)
```

1. Your AI tool connects to the cloud MCP server
2. The local relay connects your Figma plugin to the cloud
3. When you ask your AI to do something in Figma, the request flows: AI tool -> cloud -> relay -> Figma plugin -> Figma
4. Results flow back the same path

**Your design files stay in Figma.** The cloud server only processes tool logic. No design data is stored on the server.

---

## Troubleshooting

**"Figma plugin is not connected"**
- Make sure Figma Desktop is open with a design file
- Run the Intelligence Bridge plugin inside Figma
- Check that the relay is running: `npx figma-intelligence status`

**"MCP tools not showing in Claude/Cursor"**
- Restart your AI tool after running `setup`
- Check status: `npx figma-intelligence status`

**"Relay won't start"**
- Check if port 9001 is in use: `lsof -i :9001`
- Stop any existing relay: `npx figma-intelligence stop`
- Try again: `npx figma-intelligence start`

---

## License

CC-BY-NC-ND-4.0
