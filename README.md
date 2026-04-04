# Figma Intelligence

AI-powered design tools for Figma — 29+ MCP tools for visual intelligence, accessibility auditing, design system accuracy, code generation, and more.

## Quick Start

```bash
npx figma-intelligence setup
npx figma-intelligence start
```

## What It Does

Once installed, your AI tool (Claude Desktop, Cursor, VS Code) gains 29+ Figma-specific tools:

- **Screen Cloner** — Reconstruct screenshots as Figma frames using your design system
- **Accessibility Audit** — WCAG 2.2 compliance checking (A/AA/AAA)
- **Visual Audit** — UX quality audit with severity ranking
- **Component Archaeologist** — Find and reuse existing components
- **Design System Linting** — Enforce design system rules
- **Code Generation** — Generate React/Vue/Svelte from Figma components
- And 23 more tools across 5 phases

## Requirements

- Node.js 18+
- Figma Desktop app
- One of: Claude Desktop, Cursor, VS Code (with MCP support)
- A Figma Personal Access Token ([get one here](https://www.figma.com/developers/api#access-tokens))

## Commands

| Command | Description |
|---------|-------------|
| `figma-intelligence setup` | First-time setup — downloads binary, configures MCP |
| `figma-intelligence start` | Start the local relay |
| `figma-intelligence stop` | Stop the local relay |
| `figma-intelligence status` | Check connection status |

## How It Works

1. A lightweight local relay runs on your machine (handles Figma plugin communication)
2. The AI intelligence runs on a cloud server (your MCP tools connect here)
3. Your Figma plugin connects to the local relay
4. When your AI tool invokes a Figma tool → cloud processes it → relay forwards to Figma → result comes back

Your design files never leave Figma. The cloud server only processes tool logic.

## License

CC-BY-NC-ND-4.0
