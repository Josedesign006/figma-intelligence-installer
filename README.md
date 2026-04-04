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

## All 88 Tools

### Phase 1: Visual Intelligence (7 tools)
| Tool | What It Does |
|------|-------------|
| `figma_screen_cloner` | Reconstruct any screenshot as a Figma frame using your design system |
| `figma_visual_audit` | UX quality audit with severity ranking |
| `figma_a11y_audit` | WCAG 2.2 accessibility compliance (A/AA/AAA) |
| `figma_a11y_keyboard_screenreader_order` | Keyboard and screen reader focus order documentation |
| `figma_a11y_annotate` | Visual numbered markers for focus order |
| `figma_sketch_to_design` | Hand-drawn wireframe to production-quality frame |
| `figma_design_from_ref` | Reference image to design using your design system |

### Phase 2: Design System Accuracy (6 tools)
| Tool | What It Does |
|------|-------------|
| `figma_intent_translator` | Natural language to design system mapping |
| `figma_layout_intelligence` | Auto layout constraint analysis |
| `figma_variant_expander` | Generate component variants |
| `figma_theme_generator` | Create themes from color palettes |
| `figma_lint_rules` | Design system linting |
| `figma_component_audit` | Component consistency checking |

### Phase 3: Generation and Scaffolding (12 tools)
| Tool | What It Does |
|------|-------------|
| `figma_component_archaeologist` | Find and reuse existing components |
| `figma_page_architect` | Multi-frame page composition |
| `figma_generate_image_and_insert` | AI image generation + insertion into Figma |
| `figma_unsplash_search` | Stock photo search and insertion |
| `figma_url_to_frame` | Screenshot any URL into a Figma frame |
| `figma_system_drift` | Detect design system deviations |
| `figma_prototype_map` | Visualize prototype flow |
| `figma_prototype_scan` | Scan prototype connections |
| `figma_prototype_wire` | Wire prototype flows |
| `figma_animated_build` | Animation spec generation |
| `figma_composition_builder` | Build complex UI compositions |
| `figma_swarm_build` | Multi-agent parallel building |

### Phase 4: Sync and Code (9 tools)
| Tool | What It Does |
|------|-------------|
| `figma_animation_specifier` | Animation documentation |
| `figma_sync_from_code` | Sync code changes back to design |
| `figma_export_tokens` | Export design tokens (JSON, CSS, SCSS) |
| `figma_generate_component_code` | Generate React/Vue/Svelte code from components |
| `figma_webhook_listener` | Webhook handling |
| `figma_handoff_spec` | Developer handoff documentation |
| `figma_ci_check` | CI design integration checks |
| `figma_watch_docs` | Documentation auto-sync |
| `figma_icon_library_sync` | Icon library synchronization |

### Phase 5: Governance and Health (18 tools)
| Tool | What It Does |
|------|-------------|
| `figma_design_system_scaffolder` | Scaffold a design system from scratch |
| `figma_design_system_primitives` | Define primitive design tokens |
| `figma_design_system_variables` | Manage design system variables |
| `figma_token_naming_convention` | Token naming conventions |
| `figma_decision_log` | Decision logging |
| `figma_design_decision_log` | Design decision documentation |
| `figma_health_report` | Design system health metrics |
| `figma_component_spec` | Component specification documentation |
| `figma_component_spec_sheet` | Full component spec sheets |
| `figma_apg_doc` | ARIA Authoring Practices documentation |
| `figma_token_migrate` | Token migration |
| `figma_token_analytics` | Token usage analytics |
| `figma_token_docs` | Token documentation |
| `figma_taxonomy_docs` | Taxonomy documentation |
| `figma_validate_dtcg` | DTCG token format validation |
| `figma_token_math` | Token math operations |
| `figma_color_operations` | Color manipulation and operations |
| `figma_execute` | Execute arbitrary Figma plugin scripts |

### Direct Figma Operations (36 tools)
| Tool | What It Does |
|------|-------------|
| `figma_get_status` | Get Figma connection status |
| `figma_navigate` | Navigate to a node |
| `figma_get_selection` | Get current selection |
| `figma_take_screenshot` | Screenshot a node |
| `figma_get_node` | Get node details |
| `figma_get_node_deep` | Deep node tree inspection |
| `figma_batch_get_nodes` | Batch get multiple nodes |
| `figma_clone_node` | Clone a node |
| `figma_delete_node` | Delete a node |
| `figma_move_node` | Move a node |
| `figma_resize_node` | Resize a node |
| `figma_rename_node` | Rename a node |
| `figma_set_fills` | Set fill colors |
| `figma_set_strokes` | Set stroke styles |
| `figma_set_text` | Set text content |
| `figma_set_description` | Set node description |
| `figma_get_styles` | Get all styles |
| `figma_create_child` | Create child elements |
| `figma_search_components` | Search for components |
| `figma_instantiate_component` | Create component instances |
| `figma_get_pages` | List all pages |
| `figma_create_page` | Create a new page |
| `figma_create_variable_collection` | Create variable collection |
| `figma_create_variable` | Create a variable |
| `figma_update_variable` | Update variable value |
| `figma_delete_variable` | Delete a variable |
| `figma_rename_variable` | Rename a variable |
| `figma_delete_variable_collection` | Delete variable collection |
| `figma_add_mode` | Add a mode to collection |
| `figma_rename_mode` | Rename a mode |
| `figma_batch_create_variables` | Batch create variables |
| `figma_batch_update_variables` | Batch update variables |
| `figma_get_variables` | Get all variables |
| `figma_switch_mode` | Switch variable mode on a frame |
| `figma_list_modes` | List modes in a collection |
| `figma_bind_variables_multi_mode` | Bind variables across modes |

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

**Your design files stay in Figma.** The cloud server only processes tool logic (layout analysis, accessibility rules, code generation templates). No design data is stored on the server.

---

## Troubleshooting

**"Figma plugin is not connected"**
- Make sure Figma Desktop is open with a design file
- Run the Intelligence Bridge plugin inside Figma
- Check that the relay is running: `npx figma-intelligence status`

**"MCP tools not showing in Claude/Cursor"**
- Restart your AI tool after running `setup`
- Check status: `npx figma-intelligence status`
- Verify the cloud server is reachable (status should show "Cloud server: online")

**"Relay won't start"**
- Check if port 9001 is in use: `lsof -i :9001`
- Stop any existing relay: `npx figma-intelligence stop`
- Try again: `npx figma-intelligence start`

---

## License

CC-BY-NC-ND-4.0
