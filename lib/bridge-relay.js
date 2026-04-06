#!/usr/bin/env node
/**
 * figma-bridge-relay — Local WebSocket relay server
 *
 * Architecture:
 *   MCP Server (figma-bridge.ts) → connects to ws://localhost:PORT as a client
 *   Figma Plugin UI (ui.html)    → connects to ws://localhost:PORT/plugin as a client
 *   Chat (plugin UI)             → sends { type:"chat" } → relay spawns claude subprocess
 *
 * Usage:
 *   node bridge-relay.js              # default port 9001
 *   node bridge-relay.js 9002         # custom port
 *   BRIDGE_PORT=9001 node bridge-relay.js
 */

const { WebSocketServer } = require("ws");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, appendFileSync, existsSync } = require("fs");
const { homedir } = require("os");
const { join, resolve } = require("path");
const { runClaude, resetSession, isClaudeAvailable, getClaudeAuthInfo, writeMcpConfig } = require("./chat-runner");
const { runCodex, isCodexAvailable, getCodexAuthInfo, resetCodexSession } = require("./codex-runner");
const { runGemini } = require("./gemini-runner");
const { runGeminiCli, isGeminiCliAvailable, getGeminiCliAuthInfo } = require("./gemini-cli-runner");
const { runPerplexity } = require("./perplexity-runner");
const { runStitch } = require("./stitch-runner");
const { startStitchAuth, getStitchAccessToken, hasStitchAuth, getStitchEmail, clearStitchAuth } = require("./stitch-auth");
const { runAnthropicChat } = require("./anthropic-chat-runner");
const { parsePdfBuffer, parseDocxBuffer, fetchUrlContent, createContentSource, createChunkedContentSource, buildGroundingContext, scanKnowledgeHub, loadHubFile, searchHub, searchContentForAnswer, searchReferenceSites, getReferenceSites, addReferenceSite, removeReferenceSite, prewarmHub } = require("./content-context");

// ── Sync Figma Design System → Stitch design.md ────────────────────────────
const { mkdirSync } = require("fs"); // readFileSync, writeFileSync, existsSync already imported above
const STITCH_DIR = join(homedir(), ".claude", "stitch");

function isSyncDesignIntent(message) {
  const m = message.toLowerCase();
  return /sync\s+(figma\s+)?design\s*(system|tokens|variables)?|export\s+(figma\s+)?design\s*(system|tokens|variables)?.*stitch|figma\s+variables?\s+to\s+stitch|push\s+design\s*(system)?\s+to\s+stitch|create\s+design\s*(system)?\s+(from|using)\s+figma|figma\s+to\s+stitch\s+design|design\s+system\s+sync/.test(m);
}

function isImportVariablesIntent(message, attachments) {
  const m = message.toLowerCase();
  // Check for explicit "convert/import to figma variables" intent
  if (/convert\s+(these?\s+)?(to\s+)?figma\s+variables|import\s+(these?\s+)?(as\s+)?figma\s+variables|create\s+(figma\s+)?variables\s+(from|using)|make\s+(these?\s+)?figma\s+variables|to\s+figma\s+variables|\.md\s+to\s+(figma\s+)?variables|design\s+tokens?\s+to\s+figma|variables?\s+from\s+(this|the)\s+(file|md|markdown)/.test(m)) {
    return true;
  }
  // If there's an .md attachment and the message explicitly mentions variables/tokens
  if (attachments?.length && attachments.some(a => /\.md$/i.test(a.name))) {
    return /variables|tokens|import\s+(as\s+)?variables|convert\s+(to\s+)?variables|\.md\s+to\s+variables/.test(m);
  }
  return false;
}

// ── Parse design.md → structured variable data ──────────────────────────────

function parseDesignMd(mdContent) {
  const collections = [];
  let currentCollection = null;
  let currentSection = null;

  // Normalize line endings
  const lines = mdContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // ## Collection Name (but not ### which is a sub-section)
    const colMatch = trimmed.match(/^##(?!#)\s+(.+)$/);
    if (colMatch) {
      const name = colMatch[1].trim();
      // Skip non-variable sections
      if (/^(Paint Styles|Typography|Usage Guide)/i.test(name)) {
        currentCollection = null;
        continue;
      }
      currentCollection = { name, variables: [] };
      collections.push(currentCollection);
      currentSection = null;
      continue;
    }

    // ### Section Name (Colors, Strings, Toggles, or a FLOAT sub-group)
    const secMatch = trimmed.match(/^###\s+(.+)$/);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }

    // Variable line formats:
    // - **name**: `value`          (standard)
    // - **name**: value            (no backticks)
    // - **name**: → `alias`        (alias)
    // - * **name**: value          (asterisk list)
    // Also handle lines starting with "- " or "* " or "- [ ]" etc
    const varMatch = trimmed.match(/^[-*]\s+\*\*(.+?)\*\*:\s*(.+)$/);
    if (varMatch && currentCollection) {
      const varName = varMatch[1].trim();
      const rawValue = varMatch[2].trim();

      const parsed = parseVariableValue(rawValue, currentSection);
      currentCollection.variables.push({
        name: varName,
        ...parsed,
      });
      continue;
    }

    // Fallback: lines like "name: value" under a collection (no bold)
    // e.g., "color/primary: #FF0000" or "  spacing/sm: 8px"
    const plainMatch = trimmed.match(/^[-*]?\s*([a-zA-Z][\w/.-]+)\s*:\s*(.+)$/);
    if (plainMatch && currentCollection && !trimmed.startsWith("#") && !trimmed.startsWith(">")) {
      const varName = plainMatch[1].trim();
      const rawValue = plainMatch[2].trim();
      const parsed = parseVariableValue(rawValue, currentSection);
      currentCollection.variables.push({
        name: varName,
        ...parsed,
      });
    }
  }

  // If the standard parser found 0 variables, try the Stitch narrative parser
  const totalVars = collections.reduce((sum, c) => sum + c.variables.length, 0);
  if (totalVars === 0) {
    return parseStitchNarrative(mdContent);
  }

  return collections;
}

/**
 * Parse a Stitch-generated design system narrative (.md) into variable collections.
 * The narrative format embeds colors, fonts, and spacing inline in prose like:
 *   `primary` (#b20070), `surface` (#f9f9ff), etc.
 * Or in labeled lists:
 *   *   **Primary (#b10075):** Used for critical actions
 *
 * Generates 3 collections: Primitives, Semantic, Component
 */
function parseStitchNarrative(mdContent) {
  const primitives = { name: "Primitives", variables: [] };
  const semantic = { name: "Semantic", variables: [] };
  const component = { name: "Component", variables: [] };

  // Track seen variable names to avoid duplicates
  const seen = new Set();

  function addVar(collection, name, value) {
    if (seen.has(name)) return;
    seen.add(name);
    collection.variables.push({ name, ...value });
  }

  // ── Extract named colors from inline patterns ──
  // Pattern: `token_name` (#hexval) or `token_name` (#hexval)
  const inlineColorRe = /[`"](\w[\w_]*)[`"]\s*\(?\s*#([0-9a-fA-F]{6,8})\s*\)?/g;
  let match;
  while ((match = inlineColorRe.exec(mdContent)) !== null) {
    const name = "color/" + match[1].replace(/_/g, "/");
    const hex = "#" + match[2];
    addVar(primitives, name, { type: "COLOR", value: hexToRgb(hex, 1), rawValue: hex });
  }

  // Pattern: **`token_name`** (#hexval) or **token_name** (#hexval) or **Name (#hexval)**
  const boldColorRe = /\*\*`?(\w[\w_/]*)`?\*\*\s*\(?#([0-9a-fA-F]{6,8})\)?/g;
  while ((match = boldColorRe.exec(mdContent)) !== null) {
    const name = "color/" + match[1].replace(/_/g, "/").toLowerCase();
    const hex = "#" + match[2];
    addVar(primitives, name, { type: "COLOR", value: hexToRgb(hex, 1), rawValue: hex });
  }
  // Pattern: **Name (#hexval)** or **Name (#hexval):**
  const boldParenColorRe = /\*\*(\w[\w_/\s]*?)\s*\(#([0-9a-fA-F]{6,8})\)/g;
  while ((match = boldParenColorRe.exec(mdContent)) !== null) {
    const raw = match[1].trim().replace(/\s+/g, "_").toLowerCase();
    const name = "color/" + raw.replace(/_/g, "/");
    const hex = "#" + match[2];
    addVar(primitives, name, { type: "COLOR", value: hexToRgb(hex, 1), rawValue: hex });
  }

  // Pattern: `token_name` (hex) in backtick-name format used in Stitch narratives
  // e.g., `on_surface` (#25181e)
  const backtickHexRe = /`([\w_/]+)`\s*\(?#([0-9a-fA-F]{6,8})\)?/g;
  while ((match = backtickHexRe.exec(mdContent)) !== null) {
    const name = "color/" + match[1].replace(/_/g, "/");
    const hex = "#" + match[2];
    addVar(primitives, name, { type: "COLOR", value: hexToRgb(hex, 1), rawValue: hex });
  }

  // Pattern: (#hexval) with preceding word as token name
  // e.g., "primary (#b20070)" or "Primary: #b20070"
  const wordHexRe = /(?:^|\s)([\w]+(?:[_/][\w]+)*)\s*[:=]?\s*\(?#([0-9a-fA-F]{6,8})\)?/gm;
  while ((match = wordHexRe.exec(mdContent)) !== null) {
    const word = match[1].toLowerCase();
    // Skip generic words that aren't token names
    if (/^(the|and|or|for|with|use|from|set|at|in|to|of|is|it|a|an|hex|rgb|hsl|css|html|style|color|rule|using)$/.test(word)) continue;
    if (word.length < 3) continue;
    const name = "color/" + word.replace(/_/g, "/");
    const hex = "#" + match[2];
    addVar(primitives, name, { type: "COLOR", value: hexToRgb(hex, 1), rawValue: hex });
  }

  // ── Build semantic aliases for common role-based names ──
  // Map role names to their primitive counterparts
  const roleMap = {
    "primary": "color/primary",
    "secondary": "color/secondary",
    "tertiary": "color/tertiary",
    "error": "color/error",
    "surface": "color/surface",
    "background": "color/background",
    "on_primary": "color/on/primary",
    "on_secondary": "color/on/secondary",
    "on_surface": "color/on/surface",
    "on_background": "color/on/background",
    "on_error": "color/on/error",
    "outline": "color/outline",
  };

  for (const [role, target] of Object.entries(roleMap)) {
    const primName = "color/" + role.replace(/_/g, "/");
    if (seen.has(primName)) {
      const semName = "color/action/" + role.replace(/_/g, "/");
      if (!seen.has(semName)) {
        addVar(semantic, semName, { type: "ALIAS", aliasTarget: primName, rawValue: `→ ${primName}` });
      }
    }
  }

  // ── Extract typography ──
  const fontRe = /(?:font|typeface|family)\s*[:=]?\s*["']?([A-Z][\w\s]*?)["']?\s*(?:\(|,|\.|;|\n)/gi;
  const fonts = new Set();
  while ((match = fontRe.exec(mdContent)) !== null) {
    const font = match[1].trim();
    if (font.length > 2 && font.length < 40 && !/^(The|This|That|For|With|And|Use|CSS|HTML|Style)$/i.test(font)) {
      fonts.add(font);
    }
  }
  let fontIdx = 0;
  const fontRoles = ["sans", "mono", "serif", "display"];
  for (const font of fonts) {
    const role = fontRoles[fontIdx] || `font${fontIdx}`;
    addVar(primitives, `fontFamily/${role}`, { type: "STRING", value: font, rawValue: font });
    fontIdx++;
    if (fontIdx >= 4) break;
  }

  // ── Extract spacing/radius values ──
  const spacingRe = /(?:spacing|gap|padding|margin)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(px|rem)/gi;
  const spacingValues = new Set();
  while ((match = spacingRe.exec(mdContent)) !== null) {
    const val = match[2] === "rem" ? parseFloat(match[1]) * 16 : parseFloat(match[1]);
    spacingValues.add(val);
  }
  const sortedSpacing = [...spacingValues].sort((a, b) => a - b);
  const spacingNames = ["xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
  sortedSpacing.forEach((val, i) => {
    const name = `spacing/${spacingNames[i] || i}`;
    addVar(primitives, name, { type: "FLOAT", value: val, rawValue: `${val}px` });
  });

  // ── Extract radius ──
  const radiusRe = /(?:radius|border-radius|rounded)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(px)/gi;
  const radiusValues = new Set();
  while ((match = radiusRe.exec(mdContent)) !== null) {
    radiusValues.add(parseFloat(match[1]));
  }
  // Check for 0px radius mentions (common in Stitch narratives)
  if (/0\s*px\s*(?:radius|border-radius)/i.test(mdContent) || /radius.*0\s*px/i.test(mdContent)) {
    radiusValues.add(0);
  }
  const sortedRadius = [...radiusValues].sort((a, b) => a - b);
  const radiusNames = ["none", "sm", "md", "lg", "xl", "full"];
  sortedRadius.forEach((val, i) => {
    const name = `radius/${radiusNames[i] || i}`;
    addVar(primitives, name, { type: "FLOAT", value: val, rawValue: `${val}px` });
  });

  // Build result — only include collections that have variables
  const result = [];
  if (primitives.variables.length) result.push(primitives);
  if (semantic.variables.length) result.push(semantic);
  if (component.variables.length) result.push(component);

  return result;
}

function parseVariableValue(rawValue, sectionName) {
  // Strip backticks if present: `value` → value
  let clean = rawValue.replace(/^`|`$/g, "").trim();
  // Also handle: `value` (extra text) — extract just the backtick content
  const backtickMatch = rawValue.match(/`(.+?)`/);
  if (backtickMatch) clean = backtickMatch[1];

  // Alias: → `some/variable/name` or → some/variable/name
  const aliasMatch = rawValue.match(/^→\s*`?(.+?)`?\s*$/);
  if (aliasMatch && rawValue.includes("→")) {
    return {
      type: "ALIAS",
      aliasTarget: aliasMatch[1].trim(),
      rawValue,
    };
  }

  // Color: #RRGGBB or #RRGGBBAA (with optional opacity note)
  const hexMatch = clean.match(/^(#[0-9a-fA-F]{6,8})/);
  if (hexMatch) {
    const hex = hexMatch[1];
    const opacityMatch = rawValue.match(/opacity:\s*(\d+)%/);
    const opacity = opacityMatch ? parseInt(opacityMatch[1]) / 100 : 1;
    return {
      type: "COLOR",
      value: hexToRgb(hex, opacity),
      rawValue,
    };
  }

  // RGB color: rgb(R, G, B) or rgba(R, G, B, A)
  const rgbMatch = clean.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (rgbMatch) {
    return {
      type: "COLOR",
      value: {
        r: parseInt(rgbMatch[1]) / 255,
        g: parseInt(rgbMatch[2]) / 255,
        b: parseInt(rgbMatch[3]) / 255,
        a: rgbMatch[4] ? parseFloat(rgbMatch[4]) : 1,
      },
      rawValue,
    };
  }

  // Boolean: true or false
  if (/^(true|false)$/i.test(clean)) {
    return {
      type: "BOOLEAN",
      value: clean.toLowerCase() === "true",
      rawValue,
    };
  }

  // Float/number: NNpx or NN or NN% (only if it's purely numeric)
  const numMatch = clean.match(/^(-?[\d.]+)\s*(?:px|rem|em|pt|%)?$/);
  if (numMatch) {
    return {
      type: "FLOAT",
      value: parseFloat(numMatch[1]),
      rawValue,
    };
  }

  // If section name hints at color, try harder
  if (sectionName && /^colors?$/i.test(sectionName)) {
    const hexInStr = clean.match(/#[0-9a-fA-F]{6,8}/);
    if (hexInStr) return { type: "COLOR", value: hexToRgb(hexInStr[0], 1), rawValue };
  }

  // String fallback
  return { type: "STRING", value: clean, rawValue };
}

function hexToRgb(hex, alpha = 1) {
  hex = hex.replace("#", "");
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : alpha;
  return { r, g, b, a };
}

// ── Import handler: .md → Figma variables with aliasing ─────────────────────

async function handleImportVariables(requestId, message, attachments, onEvent) {
  console.log("  📥 Import variables: .md → Figma");
  // Debug: write to temp file so we can see logs regardless of which process runs
  const _debugLog = (msg) => { try { appendFileSync("/tmp/import-vars-debug.log", `${new Date().toISOString()} ${msg}\n`); } catch {} console.log(msg); };
  _debugLog("  📥 handleImportVariables called");
  _debugLog(`  📥 message: ${message?.slice(0, 200)}`);
  _debugLog(`  📥 attachments: ${JSON.stringify((attachments || []).map(a => ({ name: a.name, type: a.type, dataLen: a.data?.length })))}`);

  onEvent({ type: "phase_start", id: requestId, phase: "Parsing design tokens..." });

  try {
    // 1. Get the .md content from attachment or message code block
    let mdContent = null;
    let sourceName = "design.md";

    // Check attachments first
    if (attachments?.length) {
      const mdFile = attachments.find(a => /\.md$/i.test(a.name));
      if (mdFile) {
        mdContent = mdFile.data;
        sourceName = mdFile.name;
      }
    }

    // If no attachment, look for a code block in the message
    if (!mdContent) {
      const codeBlockMatch = message.match(/```(?:\w*)\n([\s\S]+?)```/);
      if (codeBlockMatch) {
        mdContent = codeBlockMatch[1];
        sourceName = "pasted content";
      }
    }

    // If still nothing, check if there's a saved design.md to import
    if (!mdContent) {
      const { readdirSync } = require("fs");
      const stitchDir = join(homedir(), ".claude", "stitch");
      if (existsSync(stitchDir)) {
        const dirs = readdirSync(stitchDir, { withFileTypes: true }).filter(d => d.isDirectory());
        for (const dir of dirs) {
          const mdPath = join(stitchDir, dir.name, "design.md");
          if (existsSync(mdPath)) {
            mdContent = readFileSync(mdPath, "utf8");
            sourceName = `${dir.name}/design.md`;
            break;
          }
        }
      }
    }

    if (!mdContent) {
      onEvent({
        type: "text_delta",
        id: requestId,
        delta: "No design system file found. Please either:\n" +
               "- Attach a `.md` file using the paperclip button\n" +
               "- Paste the design tokens in a code block in your message\n" +
               "- First run **\"sync figma design system\"** to export, then import\n",
      });
      onEvent({ type: "done", id: requestId, fullText: "" });
      return;
    }

    // 2. Parse the markdown
    _debugLog(`  📥 MD content length: ${mdContent.length}`);
    _debugLog(`  📥 MD first 500 chars: ${mdContent.slice(0, 500)}`);
    const parsed = parseDesignMd(mdContent);
    const totalVars = parsed.reduce((sum, c) => sum + c.variables.length, 0);
    _debugLog(`  📥 Parsed: ${parsed.length} collection(s), ${totalVars} variable(s)`);

    if (parsed.length === 0 || totalVars === 0) {
      onEvent({
        type: "text_delta",
        id: requestId,
        delta: "Could not find any variables in the file. Make sure the .md file follows the design system format:\n\n" +
               "```\n## Collection Name\n### Colors\n- **color/primary**: `#FF0000`\n### Spacing\n- **spacing/sm**: `8px`\n```\n",
      });
      onEvent({ type: "done", id: requestId, fullText: "" });
      return;
    }

    console.log(`  Parsed ${parsed.length} collection(s) with ${totalVars} variable(s) from ${sourceName}`);
    onEvent({ type: "phase_start", id: requestId, phase: `Creating ${totalVars} variables in ${parsed.length} collection(s)...` });

    // 3. Get existing Figma variables to check for duplicates and resolve aliases
    let existingCollections = [];
    try {
      existingCollections = await requestFromPlugin("getVariables", { verbosity: "full" });
      if (!Array.isArray(existingCollections)) existingCollections = [];
    } catch (err) {
      console.log("  Could not fetch existing variables:", err.message);
    }

    // Build a lookup: variable name → variable id (for alias resolution)
    const existingVarMap = new Map(); // name → { id, collectionId }
    for (const col of existingCollections) {
      for (const v of (col.variables || [])) {
        existingVarMap.set(v.name, { id: v.id, collectionId: col.id });
      }
    }

    // Build existing collection name → id lookup
    const existingColMap = new Map();
    for (const col of existingCollections) {
      existingColMap.set(col.name.toLowerCase(), col);
    }

    // 4. Create collections and variables
    const results = { created: 0, skipped: 0, aliased: 0, collections: 0, errors: [] };
    // Track newly created variable names → IDs for alias resolution within the import
    const newVarMap = new Map(); // name → { id, collectionId }
    // Deferred aliases (need all variables created first)
    const deferredAliases = [];

    for (const col of parsed) {
      let collectionId;
      let modeId;

      // Check if collection already exists
      const existing = existingColMap.get(col.name.toLowerCase());
      if (existing) {
        collectionId = existing.id;
        modeId = existing.modes?.[0]?.modeId;
        console.log(`  Using existing collection: ${col.name} (${collectionId})`);
      } else {
        // Create new collection
        try {
          const newCol = await requestFromPlugin("createVariableCollection", { name: col.name });
          collectionId = newCol.id;
          modeId = newCol.modes?.[0]?.modeId;
          results.collections++;
          console.log(`  Created collection: ${col.name} (${collectionId})`);
        } catch (err) {
          results.errors.push(`Failed to create collection "${col.name}": ${err.message}`);
          continue;
        }
      }

      // Separate aliases from direct values
      const directVars = [];
      const aliasVars = [];

      for (const v of col.variables) {
        // Skip if variable already exists
        if (existingVarMap.has(v.name)) {
          results.skipped++;
          // Still record it for alias resolution
          const ev = existingVarMap.get(v.name);
          newVarMap.set(v.name, { id: ev.id, collectionId: ev.collectionId });
          continue;
        }

        if (v.type === "ALIAS") {
          aliasVars.push(v);
        } else {
          directVars.push(v);
        }
      }

      // Batch-create direct (non-alias) variables
      if (directVars.length > 0) {
        const specs = directVars.map(v => ({
          collectionId,
          name: v.name,
          resolvedType: v.type,
          valuesByMode: modeId ? { [modeId]: v.value } : undefined,
        }));

        try {
          const batchResult = await requestFromPlugin("batchCreateVariables", { variables: specs });
          results.created += batchResult.created || specs.length;

          // Record newly created variable IDs
          if (batchResult.variables) {
            for (const nv of batchResult.variables) {
              newVarMap.set(nv.name, { id: nv.id, collectionId });
            }
          }
        } catch (err) {
          // Fallback: create one-by-one
          console.log(`  Batch create failed, falling back to individual: ${err.message}`);
          for (const spec of specs) {
            try {
              const result = await requestFromPlugin("createVariable", spec);
              results.created++;
              newVarMap.set(spec.name, { id: result.id, collectionId });
            } catch (err2) {
              results.errors.push(`"${spec.name}": ${err2.message}`);
            }
          }
        }
      }

      // Queue alias variables for deferred creation
      for (const v of aliasVars) {
        deferredAliases.push({ ...v, collectionId, modeId });
      }
    }

    // 5. Create alias variables (now that all targets should exist)
    if (deferredAliases.length > 0) {
      onEvent({ type: "phase_start", id: requestId, phase: `Setting up ${deferredAliases.length} alias references...` });

      for (const alias of deferredAliases) {
        const targetName = alias.aliasTarget;
        const target = newVarMap.get(targetName) || existingVarMap.get(targetName);

        if (!target) {
          results.errors.push(`Alias "${alias.name}" → "${targetName}": target not found`);
          continue;
        }

        // Determine the resolved type from the target variable
        // We need to look it up from existing or parsed data
        let resolvedType = "COLOR"; // default
        for (const col of parsed) {
          for (const v of col.variables) {
            if (v.name === targetName && v.type !== "ALIAS") {
              resolvedType = v.type;
              break;
            }
          }
        }
        // Also check existing variables
        for (const col of existingCollections) {
          for (const v of (col.variables || [])) {
            if (v.name === targetName) {
              resolvedType = v.resolvedType || v.type || resolvedType;
              break;
            }
          }
        }

        try {
          const result = await requestFromPlugin("createVariable", {
            collectionId: alias.collectionId,
            name: alias.name,
            resolvedType,
            valuesByMode: alias.modeId ? {
              [alias.modeId]: { type: "VARIABLE_ALIAS", variableId: target.id },
            } : undefined,
          });
          results.created++;
          results.aliased++;
          newVarMap.set(alias.name, { id: result.id, collectionId: alias.collectionId });
        } catch (err) {
          results.errors.push(`Alias "${alias.name}": ${err.message}`);
        }
      }
    }

    // 6. Report results
    const report =
      `Figma variables imported from **${sourceName}**!\n\n` +
      `**Results:**\n` +
      `- ${results.created} variable(s) created\n` +
      (results.aliased ? `- ${results.aliased} alias reference(s) linked\n` : "") +
      (results.skipped ? `- ${results.skipped} existing variable(s) skipped\n` : "") +
      (results.collections ? `- ${results.collections} new collection(s) created\n` : "") +
      (results.errors.length ? `\n**Warnings:**\n${results.errors.map(e => `- ${e}`).join("\n")}\n` : "") +
      `\nYou can now use these variables in your Figma designs. Open the **Variables** panel to see them.\n`;

    onEvent({ type: "text_delta", id: requestId, delta: report });
    onEvent({ type: "done", id: requestId, fullText: `Imported ${results.created} variables` });

  } catch (err) {
    console.error("  ❌ Import variables failed:", err.message);
    onEvent({ type: "error", id: requestId, error: `Import failed: ${err.message}` });
    onEvent({ type: "done", id: requestId, fullText: "" });
  }
}

async function handleSyncDesignSystem(requestId, message, onEvent) {
  console.log("  🔄 Sync design system: Figma → Stitch");

  onEvent({ type: "phase_start", id: requestId, phase: "Extracting Figma variables..." });

  try {
    // 1. Request variables from Figma plugin
    // getVariables returns an ARRAY of collections, each with a .variables array
    const varsResult = await requestFromPlugin("getVariables", { verbosity: "full" });

    // varsResult is an array of collection objects
    const collections = Array.isArray(varsResult) ? varsResult : [];
    const totalVars = collections.reduce((sum, c) => sum + (c.variables || []).length, 0);

    if (collections.length === 0 || totalVars === 0) {
      onEvent({ type: "text_delta", id: requestId, delta: "No Figma variables found in this file. Create some variables first (colors, spacing, typography) and try again.\n" });
      onEvent({ type: "done", id: requestId, fullText: "" });
      return;
    }

    console.log(`  Found ${collections.length} collection(s) with ${totalVars} variable(s)`);
    onEvent({ type: "phase_start", id: requestId, phase: `Converting ${totalVars} variables to design system...` });

    // 2. Also try to get paint/text/effect styles
    // getStyles returns { paint: [...], text: [...], effect: [...] }
    let paintStyles = [];
    let textStyles = [];
    try {
      const stylesResult = await requestFromPlugin("getStyles", {});
      if (stylesResult?.paint) paintStyles = stylesResult.paint;
      if (stylesResult?.text) textStyles = stylesResult.text;
    } catch (err) {
      console.log("  Could not fetch styles:", err.message);
    }

    // 3. Convert to design.md
    const designMd = figmaVariablesToDesignMd(collections, paintStyles, textStyles);

    // 4. Extract project name from message or use default
    let projectName = "Figma Intelligence";
    const projMatch = message.match(/(?:for|to|in)\s+(?:project\s+)?["']?([^"',\n]+?)["']?\s*(?:project)?(?:\s*$|\s+(?:design|sync|push))/i);
    if (projMatch) projectName = projMatch[1].trim();

    // 5. Save design.md
    const projDir = join(STITCH_DIR, projectName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60));
    if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
    const designMdPath = join(projDir, "design.md");
    writeFileSync(designMdPath, designMd, "utf8");

    console.log(`  ✅ Design system saved: ${designMdPath} (${designMd.length} chars)`);

    // 6. Report back — emit full design.md as a downloadable code block
    onEvent({
      type: "text_delta",
      id: requestId,
      delta: `Design system synced from Figma to Stitch!\n\n` +
             `**Extracted:**\n` +
             `- ${collections.length} variable collection(s): ${collections.map(c => c.name).join(", ")}\n` +
             `- ${totalVars} variable(s)\n` +
             (paintStyles.length ? `- ${paintStyles.length} paint style(s)\n` : "") +
             (textStyles.length ? `- ${textStyles.length} text style(s)\n` : "") +
             `\n**Saved to:** \`${designMdPath}\`\n` +
             `**Project:** "${projectName}"\n\n` +
             `All future Stitch generations in "${projectName}" will automatically use these design tokens for visual consistency.\n\n` +
             `---\n\n` +
             `**design.md** (hover to copy or download):\n\n` +
             "```download:design.md\n" + designMd + "\n```\n",
    });
    onEvent({ type: "done", id: requestId, fullText: `Design system synced — ${totalVars} variables` });

  } catch (err) {
    console.error("  ❌ Design system sync failed:", err.message);
    onEvent({ type: "error", id: requestId, error: `Design system sync failed: ${err.message}` });
    onEvent({ type: "done", id: requestId, fullText: "" });
  }
}

/**
 * Convert Figma variables (collections + variables) to a design.md format
 * that Stitch can use for consistent generation.
 */
function figmaVariablesToDesignMd(collections, paintStyles, textStyles) {
  const totalVars = collections.reduce((sum, c) => sum + (c.variables || []).length, 0);
  const lines = [];

  lines.push("# Design System — Figma Variables");
  lines.push("");
  lines.push(`> Auto-synced from Figma on ${new Date().toISOString().split("T")[0]}`);
  lines.push(`> ${totalVars} variables across ${collections.length} collection(s)`);
  lines.push("");

  // Process each collection (each already has .variables array)
  for (const col of collections) {
    const colName = col.name || "Unnamed Collection";
    lines.push(`## ${colName}`);
    lines.push("");

    // Group by resolved type
    const byType = {};
    for (const v of (col.variables || [])) {
      const type = v.resolvedType || v.type || "OTHER";
      if (!byType[type]) byType[type] = [];
      byType[type].push(v);
    }

    // Colors
    if (byType.COLOR) {
      lines.push("### Colors");
      lines.push("");
      for (const v of byType.COLOR) {
        const name = v.name || "unnamed";
        const value = formatColorValue(v, collections);
        lines.push(`- **${name}**: ${value}`);
      }
      lines.push("");
    }

    // Numbers (spacing, sizing, border-radius, etc.)
    if (byType.FLOAT) {
      // Sub-group by name prefix (e.g., spacing/sm, radius/md)
      const subGroups = {};
      for (const v of byType.FLOAT) {
        const prefix = (v.name || "").split("/")[0] || "Values";
        if (!subGroups[prefix]) subGroups[prefix] = [];
        subGroups[prefix].push(v);
      }

      for (const [prefix, vars] of Object.entries(subGroups)) {
        lines.push(`### ${prefix}`);
        lines.push("");
        for (const v of vars) {
          const name = v.name || "unnamed";
          const value = formatFloatValue(v, collections);
          lines.push(`- **${name}**: ${value}`);
        }
        lines.push("");
      }
    }

    // Strings (font families, etc.)
    if (byType.STRING) {
      lines.push("### Strings");
      lines.push("");
      for (const v of byType.STRING) {
        const name = v.name || "unnamed";
        const value = formatStringValue(v, collections);
        lines.push(`- **${name}**: ${value}`);
      }
      lines.push("");
    }

    // Booleans
    if (byType.BOOLEAN) {
      lines.push("### Toggles");
      lines.push("");
      for (const v of byType.BOOLEAN) {
        const name = v.name || "unnamed";
        const value = formatBooleanValue(v, collections);
        lines.push(`- **${name}**: ${value}`);
      }
      lines.push("");
    }
  }

  // Paint styles (if available)
  if (paintStyles.length > 0) {
    lines.push("## Paint Styles");
    lines.push("");
    for (const s of paintStyles) {
      const name = s.name || "unnamed";
      const fills = (s.paints || []).map(p => {
        if (p.type === "SOLID" && p.color) {
          const { r, g, b } = p.color;
          return rgbToHex(r, g, b);
        }
        return p.type || "gradient";
      }).join(", ");
      lines.push(`- **${name}**: ${fills}`);
    }
    lines.push("");
  }

  // Text styles (if available)
  if (textStyles.length > 0) {
    lines.push("## Typography");
    lines.push("");
    for (const s of textStyles) {
      const name = s.name || "unnamed";
      const family = s.fontName?.family || s.fontFamily || "";
      const size = s.fontSize || "";
      const weight = s.fontName?.style || s.fontWeight || "";
      const lh = s.lineHeight?.value ? `/${s.lineHeight.value}${s.lineHeight.unit === "PERCENT" ? "%" : "px"}` : "";
      lines.push(`- **${name}**: ${family} ${size}px${lh} ${weight}`);
    }
    lines.push("");
  }

  // Usage guidance for Stitch
  lines.push("---");
  lines.push("");
  lines.push("## Usage Guide for Generation");
  lines.push("");
  lines.push("When generating UI screens, use the exact color values, spacing values, and typography");
  lines.push("defined above. This ensures visual consistency between Figma designs and generated screens.");
  lines.push("");
  lines.push("- Use the COLOR variables for all backgrounds, text, borders, and accents");
  lines.push("- Use the spacing/sizing FLOAT variables for padding, margins, gaps, and dimensions");
  lines.push("- Match typography settings (font family, size, weight) to the styles above");
  lines.push("- Maintain the design language: if colors are dark/muted, generate dark-themed UIs");
  lines.push("");

  return lines.join("\n");
}

function formatColorValue(v, collections) {
  // Try to extract the color from valuesByMode or value
  const modes = v.valuesByMode || {};
  const firstMode = Object.values(modes)[0];
  const val = firstMode || v.value;
  if (val && typeof val === "object" && "r" in val) {
    return `\`${rgbToHex(val.r, val.g, val.b)}\`${val.a !== undefined && val.a < 1 ? ` (opacity: ${Math.round(val.a * 100)}%)` : ""}`;
  }
  // Variable alias — show the referenced variable name
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
    const refName = findVariableName(val.id, collections);
    return refName ? `→ \`${refName}\`` : `→ alias(${val.id})`;
  }
  if (typeof val === "string") return `\`${val}\``;
  return JSON.stringify(val);
}

function findVariableName(varId, collections) {
  for (const col of (collections || [])) {
    for (const v of (col.variables || [])) {
      if (v.id === varId) return v.name;
    }
  }
  return null;
}

function formatFloatValue(v, collections) {
  const modes = v.valuesByMode || {};
  const firstMode = Object.values(modes)[0];
  const val = firstMode !== undefined ? firstMode : v.value;
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
    const refName = findVariableName(val.id, collections);
    return refName ? `→ \`${refName}\`` : `→ alias`;
  }
  return `\`${val}px\``;
}

function formatStringValue(v, collections) {
  const modes = v.valuesByMode || {};
  const firstMode = Object.values(modes)[0];
  const val = firstMode || v.value;
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
    const refName = findVariableName(val.id, collections);
    return refName ? `→ \`${refName}\`` : `→ alias`;
  }
  return `\`${val}\``;
}

function formatBooleanValue(v, collections) {
  const modes = v.valuesByMode || {};
  const firstMode = Object.values(modes)[0];
  const val = firstMode !== undefined ? firstMode : v.value;
  if (val && typeof val === "object" && val.type === "VARIABLE_ALIAS") {
    const refName = findVariableName(val.id, collections);
    return refName ? `→ \`${refName}\`` : `→ alias`;
  }
  return `\`${val}\``;
}

function rgbToHex(r, g, b) {
  const toHex = (c) => {
    const v = Math.round((typeof c === "number" && c <= 1 ? c * 255 : c));
    return v.toString(16).padStart(2, "0");
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// P3: Port fallback — try PORT, then PORT+1 through PORT+9
const BASE_PORT = parseInt(process.argv[2] || process.env.BRIDGE_PORT || "9001", 10);
let PORT = BASE_PORT;
const MCP_SERVER_PATH = resolve(__dirname, "../figma-intelligence-layer/dist/index.js");
const DEFAULT_CODEX_APP_BIN = "/Applications/Codex.app/Contents/Resources/codex";

if (!process.env.CODEX_BIN_PATH && existsSync(DEFAULT_CODEX_APP_BIN)) {
  process.env.CODEX_BIN_PATH = DEFAULT_CODEX_APP_BIN;
}

function readMcpEnv() {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const figmaEnv = s?.mcpServers?.["figma-intelligence-layer"]?.env || {};
      const bridgeEnv = s?.mcpServers?.["design-bridge"]?.env || {};
      return {
        // Merge figma-intelligence-layer env (has UNSPLASH, GEMINI, ANTHROPIC keys etc.)
        ...figmaEnv,
        // Pull Stitch/Unsplash/Pexels from design-bridge as a fallback
        ...(bridgeEnv.UNSPLASH_ACCESS_KEY && !figmaEnv.UNSPLASH_ACCESS_KEY
          ? { UNSPLASH_ACCESS_KEY: bridgeEnv.UNSPLASH_ACCESS_KEY } : {}),
        ...(bridgeEnv.PEXELS_API_KEY && !figmaEnv.PEXELS_API_KEY
          ? { PEXELS_API_KEY: bridgeEnv.PEXELS_API_KEY } : {}),
        ...(bridgeEnv.STITCH_API_KEY && !figmaEnv.STITCH_API_KEY
          ? { STITCH_API_KEY: bridgeEnv.STITCH_API_KEY } : {}),
        ...(bridgeEnv.GOOGLE_CLOUD_PROJECT && !figmaEnv.GOOGLE_CLOUD_PROJECT
          ? { GOOGLE_CLOUD_PROJECT: bridgeEnv.GOOGLE_CLOUD_PROJECT } : {}),
      };
    }
  } catch {}
  return {};
}

let _mcpProc = null;
function startPersistentMcpServer() {
  if (!existsSync(MCP_SERVER_PATH)) {
    console.log("⚠  MCP server not built — run setup.sh");
    return;
  }
  const savedEnv = readMcpEnv();
  _mcpProc = spawn("node", [MCP_SERVER_PATH], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...savedEnv,
      FIGMA_BRIDGE_PORT: String(PORT),
      ENABLE_DECISION_LOG: "true",
    },
  });
  _mcpProc.stderr.on("data", (d) => {
    const t = d.toString().trim();
    if (t) console.log("[mcp]", t);
  });
  _mcpProc.on("close", (code) => {
    _mcpProc = null;
    if (code !== 0 && code !== null) {
      console.log("⚠  MCP server exited — restarting in 3s…");
      setTimeout(startPersistentMcpServer, 3000);
    }
  });
  _mcpProc.on("error", () => {
    _mcpProc = null;
    setTimeout(startPersistentMcpServer, 3000);
  });
}

let pluginSocket = null;
const mcpSockets = new Set();
const vscodeSockets = new Set();          // VS Code chat extension clients
const pendingRequests = new Map();
const activeChatProcesses = new Map();   // requestId → ChildProcess | EventEmitter

// Auth info populated on startup and sent to plugin on connect
let authInfo = { loggedIn: false, email: null };
let openaiAuthInfo = { loggedIn: false, email: null };
let geminiCliAuthInfo = { loggedIn: false, email: null };

// TTL cache for auth refresh — avoid spawning auth subprocesses on every plugin connect
const AUTH_REFRESH_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _lastAuthRefresh = 0;
let _authRefreshInFlight = null;

// ── Active design system ─────────────────────────────────────────────────────
let activeDesignSystemId = null;

// ── Component Doc Generator chooser state ────────────────────────────────────
// When the chooser is shown, we stash the original message (with Figma link)
// so when the user picks a type, we can prepend it to the follow-up.
let pendingDocGenChooser = null; // { originalMessage: string, shownAt: number }

// ── Provider config (persisted to ~/.claude/settings.json) ───────────────────
let providerConfig = { provider: "claude", apiKey: null, projectId: null };

function loadProviderConfig() {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      const saved = s?.figmaIntelligenceProvider;
      if (saved?.provider) {
        providerConfig = { provider: saved.provider, apiKey: saved.apiKey || null, projectId: saved.projectId || null };
        console.log(`  Provider loaded: ${providerConfig.provider}`);
      }
    }
  } catch {}
}

function saveProviderConfig() {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    let settings = {};
    if (existsSync(settingsPath)) {
      try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); } catch {}
    }
    settings.figmaIntelligenceProvider = {
      provider: providerConfig.provider,
      apiKey: providerConfig.apiKey || null,
      projectId: providerConfig.projectId || null,
    };
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("  ⚠ Could not save provider config:", err.message);
  }
}

loadProviderConfig();

// ── Anthropic API Key (for fast chat mode — Tier 3) ─────────────────────────
function getAnthropicApiKey() {
  // 1. Provider-level API key (set via UI)
  if (providerConfig.apiKey && providerConfig.provider === "claude") return providerConfig.apiKey;
  // 2. Environment variable
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  // 3. From settings file
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      const s = JSON.parse(readFileSync(settingsPath, "utf8"));
      if (s?.figmaIntelligenceProvider?.anthropicApiKey) return s.figmaIntelligenceProvider.anthropicApiKey;
    }
  } catch {}
  return null;
}

// ── Knowledge sources grounding context ─────────────────────────────────────
const activeContentSources = new Map(); // sourceId → { id, title, sources, meta, extractedAt }

async function refreshAuthState({ log = false, force = false } = {}) {
  // Return cached auth if within TTL (unless forced or startup log)
  const now = Date.now();
  if (!force && !log && (now - _lastAuthRefresh) < AUTH_REFRESH_TTL_MS) {
    sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
    return;
  }
  // Deduplicate concurrent refresh calls
  if (_authRefreshInFlight) {
    await _authRefreshInFlight;
    sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
    return;
  }
  _authRefreshInFlight = _doRefreshAuthState({ log });
  try {
    await _authRefreshInFlight;
    _lastAuthRefresh = Date.now();
  } finally {
    _authRefreshInFlight = null;
  }
}

async function _doRefreshAuthState({ log = false } = {}) {
  const claudeAvailable = await isClaudeAvailable();
  if (claudeAvailable) {
    authInfo = await getClaudeAuthInfo();
    if (log) {
      if (authInfo.loggedIn) {
        console.log(`✅ Claude: logged in${authInfo.email ? " as " + authInfo.email : ""}`);
      } else {
        console.log("⚠  Claude: not logged in — run 'claude login'");
      }
    }
  } else {
    authInfo = { loggedIn: false, email: null };
    if (log) console.log("⚠  Claude CLI not found — Claude chat unavailable");
  }

  const codexAvailable = await isCodexAvailable();
  if (codexAvailable) {
    openaiAuthInfo = await getCodexAuthInfo();
    if (log) {
      if (openaiAuthInfo.loggedIn) {
        console.log(`✅ OpenAI Codex: logged in${openaiAuthInfo.email ? " as " + openaiAuthInfo.email : ""}`);
      } else {
        console.log("⚠  OpenAI Codex: not logged in — run 'codex login'");
      }
    }
  } else {
    openaiAuthInfo = { loggedIn: false, email: null };
    if (log) console.log("⚠  OpenAI Codex CLI not found — run: npm install -g @openai/codex");
  }

  const geminiCliAvailable = await isGeminiCliAvailable();
  if (geminiCliAvailable) {
    geminiCliAuthInfo = await getGeminiCliAuthInfo();
    if (log) {
      if (geminiCliAuthInfo.loggedIn) {
        console.log(`✅ Gemini CLI: logged in${geminiCliAuthInfo.email ? " as " + geminiCliAuthInfo.email : ""}`);
      } else {
        console.log("⚠  Gemini CLI: not logged in — run 'gemini auth login'");
      }
    }
  } else {
    geminiCliAuthInfo = { loggedIn: false, email: null };
    if (log) console.log("ℹ  Gemini CLI not found — Gemini will use API key mode (install: npm install -g @google/gemini-cli)");
  }

  sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
  // Also send status to all VS Code clients
  for (const vsWs of vscodeSockets) {
    sendRelayStatus(vsWs, hasConnectedMcpSocket());
  }
}

// ── Auth check on startup ───────────────────────────────────────────────────
(async () => {
  await refreshAuthState({ log: true, force: true });
})();

// ── Helpers ─────────────────────────────────────────────────────────────────
function sendRelayStatus(ws, mcpConnected) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "bridge-status",
    mcpConnected,
    claudeLoggedIn: authInfo.loggedIn,
    claudeEmail: authInfo.email,
    openaiLoggedIn: openaiAuthInfo.loggedIn,
    openaiEmail: openaiAuthInfo.email,
    provider: providerConfig.provider,
    hasApiKey: !!(providerConfig.apiKey),
    hasStitchOAuth: hasStitchAuth(),
    stitchEmail: getStitchEmail(),
    geminiLoggedIn: geminiCliAuthInfo.loggedIn,
    geminiEmail: geminiCliAuthInfo.email,
    activeDesignSystemId,
    hasAnthropicKey: !!getAnthropicApiKey(),
    referenceSites: getReferenceSites(),
    knowledgeSources: Array.from(activeContentSources.values()).map(s => ({
      id: s.id, title: s.title, sourceCount: s.sources.length, meta: s.meta || {}, extractedAt: s.extractedAt,
    })),
  }));
}

function hasConnectedMcpSocket() {
  for (const socket of mcpSockets) {
    if (socket.readyState === 1) return true;
  }
  return false;
}

function broadcastToMcpSockets(raw) {
  for (const socket of mcpSockets) {
    if (socket.readyState === 1) {
      socket.send(raw);
    }
  }
}

function sendToPlugin(payload) {
  if (pluginSocket && pluginSocket.readyState === 1) {
    pluginSocket.send(JSON.stringify(payload));
  }
}

// ── Relay-initiated plugin requests (for sync design system etc.) ──────────
const pendingRelayRequests = new Map();

/**
 * Send a bridge-request to the Figma plugin and wait for the response.
 * Returns a Promise that resolves with the result or rejects on error/timeout.
 */
function requestFromPlugin(method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!pluginSocket || pluginSocket.readyState !== 1) {
      reject(new Error("Figma plugin not connected"));
      return;
    }
    const id = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const timer = setTimeout(() => {
      pendingRelayRequests.delete(id);
      reject(new Error(`Plugin request "${method}" timed out`));
    }, timeoutMs);

    pendingRelayRequests.set(id, { resolve, reject, timer });
    sendToPlugin({ type: "bridge-request", id, method, params: params || {} });
  });
}

function sendToVscode(payload, targetWs) {
  if (targetWs && targetWs.readyState === 1) {
    targetWs.send(JSON.stringify(payload));
  }
}

function broadcastToVscodeSockets(payload) {
  const data = JSON.stringify(payload);
  for (const ws of vscodeSockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// ── P3: Grace period — retain plugin state briefly on disconnect ──────────────
const PLUGIN_GRACE_PERIOD_MS = 5000;
let pluginGraceTimer = null;
let pluginGraceState = null; // stashed state during grace period

// ── P3: Heartbeat — detect dead connections ──────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30000;

function setupHeartbeat(wss) {
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (ws._isAlive === false) {
        console.log("  ⚠ Terminating unresponsive connection");
        return ws.terminate();
      }
      ws._isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(interval));
}

// ── P3: Port fallback — try ports 9001-9010 ──────────────────────────────────
function createServerWithFallback(basePort, maxRetries = 9) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function tryPort(port) {
      const server = new WebSocketServer({ port });
      server.on("listening", () => {
        PORT = port;
        resolve(server);
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE" && attempt < maxRetries) {
          attempt++;
          console.log(`  ⚠ Port ${port} in use, trying ${port + 1}…`);
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
    }
    tryPort(basePort);
  });
}

// ── Cloud Tunnel — outbound connection to cloud server ──────────────────────
const WebSocketClient = require("ws");
const CLOUD_CONFIG_PATH = join(homedir(), ".figma-intelligence", "config.json");
let cloudTunnelSocket = null;
let cloudTunnelReconnectTimer = null;
let cloudTunnelReconnectDelay = 2000; // starts at 2s, grows to 30s
const CLOUD_TUNNEL_MAX_RECONNECT_DELAY = 30000;
const cloudPendingTunnelRequests = new Map(); // requestId → true (marks requests originating from cloud)

function loadCloudConfig() {
  try {
    if (existsSync(CLOUD_CONFIG_PATH)) {
      return JSON.parse(readFileSync(CLOUD_CONFIG_PATH, "utf8"));
    }
  } catch {}
  return null;
}

function connectCloudTunnel() {
  const config = loadCloudConfig();
  if (!config || !config.cloudUrl || !config.sessionToken) {
    // No cloud config — running in local-only mode
    return;
  }

  const tunnelUrl = `${config.cloudUrl.replace(/^http/, "ws")}/tunnel?token=${config.sessionToken}`;
  console.log(`   ☁  Connecting to cloud tunnel…`);

  const ws = new WebSocketClient(tunnelUrl);

  ws.on("open", () => {
    cloudTunnelSocket = ws;
    cloudTunnelReconnectDelay = 2000; // reset backoff
    console.log(`   ☁  Cloud tunnel connected`);
  });

  ws.on("message", (data) => {
    // Messages from cloud = Figma bridge requests that need to reach the plugin
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.id && msg.method) {
      // Cloud is requesting something from Figma (e.g. execute, getStatus)
      // Forward to plugin, mark as cloud-origin so response routes back
      if (pluginSocket && pluginSocket.readyState === 1) {
        cloudPendingTunnelRequests.set(msg.id, true);
        pluginSocket.send(JSON.stringify({
          type: "bridge-request",
          id: msg.id,
          method: msg.method,
          params: msg.params || {},
        }));
      } else {
        // Plugin not connected — send error back through tunnel
        ws.send(JSON.stringify({
          id: msg.id,
          error: "Figma plugin is not connected. Open Figma and run the Intelligence Bridge plugin.",
        }));
      }
    }
  });

  ws.on("close", () => {
    cloudTunnelSocket = null;
    console.log(`   ☁  Cloud tunnel disconnected — reconnecting in ${cloudTunnelReconnectDelay / 1000}s`);
    cloudTunnelReconnectTimer = setTimeout(() => {
      cloudTunnelReconnectDelay = Math.min(cloudTunnelReconnectDelay * 1.5, CLOUD_TUNNEL_MAX_RECONNECT_DELAY);
      connectCloudTunnel();
    }, cloudTunnelReconnectDelay);
  });

  ws.on("error", (err) => {
    console.error(`   ☁  Cloud tunnel error:`, err.message);
    // close event will handle reconnection
  });
}

/**
 * Route a plugin response back to the cloud tunnel if it originated there.
 * Returns true if the response was handled (sent to cloud), false otherwise.
 */
function routeToCloudIfNeeded(requestId, raw) {
  if (cloudPendingTunnelRequests.has(requestId)) {
    cloudPendingTunnelRequests.delete(requestId);
    if (cloudTunnelSocket && cloudTunnelSocket.readyState === 1) {
      cloudTunnelSocket.send(raw);
      return true;
    }
  }
  return false;
}

// ── WebSocket Server ─────────────────────────────────────────────────────────
(async () => {
  let wss;
  try {
    wss = await createServerWithFallback(BASE_PORT);
  } catch (err) {
    console.error(`Fatal: could not bind to any port in range ${BASE_PORT}-${BASE_PORT + 9}:`, err.message);
    process.exit(1);
  }

console.log(`\n🔌 Figma Intelligence Bridge Relay`);
console.log(`   Listening on ws://localhost:${PORT}`);
console.log(`   MCP server   → connects to ws://localhost:${PORT}`);
console.log(`   Figma plugin → connects to ws://localhost:${PORT}/plugin`);
console.log(`   VS Code ext  → connects to ws://localhost:${PORT}/vscode`);
console.log(`   Waiting for connections…\n`);

// Connect to cloud tunnel (if configured)
connectCloudTunnel();

// Rewrite MCP config with the actual port (chat-runner wrote initial config with default port)
writeMcpConfig(PORT);

// Start heartbeat monitoring
setupHeartbeat(wss);

// Pre-warm knowledge hub (load .chunks.json files into cache for instant first query)
prewarmHub().then((count) => {
  if (count > 0) console.log(`   📚 Knowledge hub pre-warmed: ${count} chunked source(s) cached`);
}).catch(() => {});

// Start the MCP server as a persistent child process so the plugin
// always shows "Connected" — not just during active chat requests.
startPersistentMcpServer();

wss.on("connection", (ws, req) => {
  const path = req.url || "/";
  const isPlugin = path.includes("/plugin");
  const isVscode = path.includes("/vscode");

  // P3: Heartbeat — mark connection alive on pong
  ws._isAlive = true;
  ws.on("pong", () => { ws._isAlive = true; });

  if (isVscode) {
    vscodeSockets.add(ws);
    console.log("✅ VS Code client connected");
    sendRelayStatus(ws, hasConnectedMcpSocket());
    refreshAuthState().catch(() => {});
    // Notify plugin that VS Code is connected
    sendToPlugin({ type: "vscode-connected", connected: true, count: vscodeSockets.size });
    ws.on("close", () => {
      vscodeSockets.delete(ws);
      console.log("  ↺ VS Code client disconnected");
      sendToPlugin({ type: "vscode-connected", connected: vscodeSockets.size > 0, count: vscodeSockets.size });
    });
  } else if (isPlugin) {
    // P3: Cancel grace timer if plugin reconnects within grace period
    if (pluginGraceTimer) {
      clearTimeout(pluginGraceTimer);
      pluginGraceTimer = null;
      pluginGraceState = null;
      console.log("  ↺ Plugin reconnected within grace period");
    }
    pluginSocket = ws;
    console.log("✅ Figma plugin connected");
    sendRelayStatus(ws, hasConnectedMcpSocket());
    refreshAuthState().catch(() => {});
  } else {
    mcpSockets.add(ws);
    console.log("✅ MCP server connected");
    sendRelayStatus(pluginSocket, true);
  }

  ws.on("message", (data) => {
    const raw = data.toString();
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Global debug: log every message type
    try { appendFileSync("/tmp/import-vars-debug.log", `${new Date().toISOString()} MSG type=${msg.type} isVscode=${isVscode} isPlugin=${isPlugin} keys=${Object.keys(msg).join(",")}\n`); } catch {}

    // ── Messages from VS Code extension ────────────────────────────────────
    if (isVscode) {

      if (msg.type === "vscode-hello") {
        console.log(`  VS Code client: ${msg.clientType || "unknown"} v${msg.version || "?"}`);
        return;
      }

      // Set AI provider
      if (msg.type === "set-provider") {
        providerConfig = { provider: msg.provider || "claude", apiKey: msg.apiKey || null, projectId: msg.projectId || null };
        saveProviderConfig();
        console.log(`  🔑 provider set (vscode): ${providerConfig.provider}`);
        sendToVscode({ type: "provider-stored", provider: providerConfig.provider }, ws);
        refreshAuthState().catch(() => {});
        return;
      }

      // Set design system
      if (msg.type === "set-design-system") {
        const newId = msg.designSystemId || null;
        if (newId !== activeDesignSystemId) {
          activeDesignSystemId = newId;
          resetSession();
          resetCodexSession();
          console.log(`  🎨 design system (vscode): ${newId || "none"} (sessions reset)`);
        }
        sendToVscode({ type: "design-system-stored", designSystemId: activeDesignSystemId }, ws);
        // Broadcast DS change to all connected MCP sockets so intelligence layer stays in sync
        broadcastToMcpSockets(JSON.stringify({ type: "design-system-changed", designSystemId: activeDesignSystemId }));
        return;
      }

      // Chat message from VS Code (supports mode: "dual", "code", "chat")
      if (msg.type === "chat") {
        const requestId = msg.id;
        const prov = providerConfig.provider || "claude";
        const chatMode = msg.mode || "dual";
        let chatMessage = msg.message || "";

        // ── /mcp slash command — diagnostic instead of passing to Claude ───
        if (chatMessage.trim().toLowerCase() === "/mcp") {
          (async () => {
            const cloudConfig = loadCloudConfig();
            const lines = [];
            lines.push("**MCP Diagnostics**\n");

            // 1. Cloud config
            if (cloudConfig && cloudConfig.cloudUrl) {
              lines.push(`✅ Cloud config found: \`${cloudConfig.cloudUrl}\``);
              lines.push(`   Session token: \`${cloudConfig.sessionToken?.slice(0, 8)}…\``);
            } else {
              lines.push("❌ No cloud config — run `npx figma-intelligence setup` to configure");
            }

            // 2. Health check
            if (cloudConfig && cloudConfig.cloudUrl) {
              try {
                const https = require("https");
                const healthUrl = `${cloudConfig.cloudUrl}/health`;
                const health = await new Promise((resolve, reject) => {
                  const req = https.get(healthUrl, { timeout: 5000 }, (res) => {
                    let data = "";
                    res.on("data", (c) => { data += c; });
                    res.on("end", () => {
                      try { resolve(JSON.parse(data)); } catch { resolve(null); }
                    });
                  });
                  req.on("error", reject);
                  req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
                });
                if (health && health.status === "ok") {
                  lines.push(`✅ Cloud server healthy (uptime: ${Math.floor(health.uptime / 60)}m, sessions: ${health.activeSessions})`);
                } else {
                  lines.push("⚠️ Cloud server responded but status is not ok");
                }
              } catch (e) {
                lines.push(`❌ Cloud server unreachable: ${e.message}`);
              }
            }

            // 3. Local relay
            const relayConnected = pluginSockets.size > 0;
            if (relayConnected) {
              lines.push(`✅ Figma plugin connected (${pluginSockets.size} socket(s))`);
            } else {
              lines.push("⚠️ No Figma plugin connected — open the Figma plugin to enable design tools");
            }

            // 4. Tunnel (relay binary)
            try {
              const binPath = cloudConfig?.binaryPath;
              if (binPath && existsSync(binPath)) {
                lines.push(`✅ Relay binary found: \`${binPath.split("/").pop()}\``);
              } else {
                lines.push("⚠️ Relay binary not found at expected path");
              }
            } catch {}

            // 5. Tip
            lines.push("\n💡 If tools aren't working, click **New Conversation** to start a fresh session.");

            const fullText = lines.join("\n");
            sendToVscode({ type: "text_delta", id: requestId, delta: fullText }, ws);
            sendToVscode({ type: "done", id: requestId, fullText }, ws);
          })();
          return;
        }

        // Pre-parse Figma links so the AI doesn't need to extract file_key/node_id
        const figmaLinkMatch = chatMessage.match(/https:\/\/www\.figma\.com\/(?:design|file)\/[^\s]+/);
        if (figmaLinkMatch) {
          try {
            const { parseFigmaLink } = require("./spec-helpers/parse-figma-link");
            const parsed = parseFigmaLink(figmaLinkMatch[0]);
            chatMessage += `\n\n[Pre-parsed Figma link: file_key="${parsed.file_key}", node_id="${parsed.node_id}"]`;
          } catch (e) { /* ignore parse errors */ }
        }

        // ── Component Doc Generator: handle follow-up after chooser (VS Code) ─
        if (pendingDocGenChooser && (chatMode === "code" || chatMode === "dual")) {
          const elapsed = Date.now() - pendingDocGenChooser.shownAt;
          if (elapsed < 10 * 60 * 1000) {
            const reply = (chatMessage || "").trim().toLowerCase();
            const specMap = {
              "1": "anatomy", "anatomy": "anatomy",
              "2": "api", "api": "api",
              "3": "property", "properties": "property", "property": "property",
              "4": "color", "color": "color",
              "5": "structure", "structure": "structure",
              "6": "screen-reader", "screen reader": "screen-reader", "screen-reader": "screen-reader",
              "all": "all",
            };
            const matched = specMap[reply];
            const multiMatch = reply.match(/^[\d,\s]+$/);
            if (matched || multiMatch) {
              const original = pendingDocGenChooser.originalMessage;
              pendingDocGenChooser = null;
              // CRITICAL: Reset session so the AI starts fresh with the correct
              // system prompt containing the spec-type skill addendum.
              // Without this, --resume reuses the old system prompt which lacks
              // the tool restrictions and spec reference instructions.
              resetSession(chatMode);
              console.log(`  📋 Component Doc Generator (vscode): reset ${chatMode} session for fresh system prompt`);
              if (matched === "all" || (multiMatch && reply.replace(/\s/g, "").split(",").length >= 6)) {
                chatMessage = `${original}\n\nThe user selected ALL spec types. Generate all 6 specification documents: anatomy, api, property, color, structure, and screen-reader specs. Start with the anatomy spec, then proceed to each subsequent type.`;
                console.log(`  📋 Component Doc Generator (vscode): user chose ALL`);
              } else if (multiMatch) {
                const nums = reply.replace(/\s/g, "").split(",").filter(Boolean);
                const types = nums.map(n => specMap[n]).filter(Boolean);
                chatMessage = `${original}\n\nThe user selected these spec types: ${types.join(", ")}. Generate a create ${types[0]} spec for the component first.`;
                console.log(`  📋 Component Doc Generator (vscode): user chose [${types.join(", ")}]`);
              } else {
                chatMessage = `${original}\n\nThe user selected: create ${matched} spec for this component.`;
                console.log(`  📋 Component Doc Generator (vscode): user chose "${matched}"`);
              }
            } else {
              pendingDocGenChooser = null;
            }
          } else {
            pendingDocGenChooser = null;
          }
        }

        // ── Component Doc Generator chooser intercept (VS Code) ──────────
        if (chatMode === "code" || chatMode === "dual") {
          const { detectActiveSkills } = require("./shared-prompt-config");
          const detectedSkills = detectActiveSkills(chatMessage);
          if (detectedSkills.some(s => s === "Component Doc Generator:all")) {
            console.log(`  📋 Component Doc Generator (vscode): presenting spec type chooser`);
            pendingDocGenChooser = { originalMessage: chatMessage, shownAt: Date.now() };
            const chooserText = `I can generate the following detailed spec types for your component:\n\n` +
              `1. **Anatomy** — Numbered markers on each element + attribute table with semantic notes\n` +
              `2. **API** — Property tables with values, defaults, required/optional status, and configuration examples\n` +
              `3. **Properties** — Visual exhibits for variant axes, boolean toggles, variable modes, and child properties\n` +
              `4. **Color** — Design token mapping for every element across states and variants\n` +
              `5. **Structure** — Dimensions, spacing, padding tables across size/density variants\n` +
              `6. **Screen Reader** — VoiceOver, TalkBack, and ARIA accessibility specs per platform\n\n` +
              `Which spec(s) would you like me to generate? You can pick one, multiple (e.g. 1, 3, 5), or say **all** to generate everything.`;
            sendToVscode({ type: "phase_start", id: requestId, phase: "Skills: Component Doc Generator" }, ws);
            sendToVscode({ type: "text_delta", id: requestId, delta: chooserText }, ws);
            sendToVscode({ type: "done", id: requestId, fullText: chooserText }, ws);
            return;
          }
        }

        // Inject knowledge grounding if active (relevance-filtered)
        if (activeContentSources.size > 0) {
          const groundingCtx = buildGroundingContext(activeContentSources, msg.message);
          if (groundingCtx) {
            chatMessage = groundingCtx + "\n---\n\nUser question: " + chatMessage;
          }
        }

        console.log(`  💬 vscode chat [${prov}/${chatMode}] (id: ${requestId}): ${chatMessage.slice(0, 60)}…`);

        const onEvent = (event) => {
          // Send to VS Code client AND plugin (so both see the Figma actions)
          sendToVscode(event, ws);
          sendToPlugin(event);
        };

        let proc;
        if (prov === "claude" || !prov || prov === "bridge") {
          const anthropicKey = getAnthropicApiKey();
          if (chatMode === "chat" && anthropicKey) {
            const { buildChatPrompt } = require("./shared-prompt-config");
            proc = runAnthropicChat({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              apiKey: anthropicKey,
              model: msg.model,
              systemPrompt: buildChatPrompt(),
              onEvent,
            });
          } else {
            proc = runClaude({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              frameworkConfig: msg.frameworkConfig,
              onEvent,
            });
          }
        } else if (prov === "openai") {
          proc = runCodex({
            message: chatMessage,
            attachments: msg.attachments,
            requestId,
            model: msg.model,
            designSystemId: activeDesignSystemId,
            mode: chatMode,
            onEvent,
          });
        } else if (prov === "gemini") {
          if (geminiCliAuthInfo.loggedIn) {
            proc = runGeminiCli({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              onEvent,
            });
          } else {
            proc = runGemini({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              apiKey: providerConfig.apiKey,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              onEvent,
            });
          }
        } else if (prov === "stitch") {
          proc = runStitch({
            message: chatMessage,
            requestId,
            apiKey: providerConfig.apiKey,
            projectId: providerConfig.projectId,
            model: msg.model,
            onEvent,
          });
        } else {
          sendToVscode({ type: "error", id: requestId, error: `Unsupported provider: ${prov}` }, ws);
          sendToVscode({ type: "done", id: requestId, fullText: "" }, ws);
          return;
        }

        activeChatProcesses.set(requestId, proc);
        proc.on("close", () => activeChatProcesses.delete(requestId));
        return;
      }

      // Abort chat
      if (msg.type === "abort-chat") {
        const proc = activeChatProcesses.get(msg.id);
        if (proc) {
          proc.kill("SIGTERM");
          activeChatProcesses.delete(msg.id);
          console.log(`  ⛔ vscode chat aborted (id: ${msg.id})`);
        }
        return;
      }

      // New conversation
      if (msg.type === "new-conversation") {
        const resetMode = msg.mode || null;
        resetSession(resetMode);
        resetCodexSession(resetMode);
        console.log(`  🔄 vscode session reset${resetMode ? ` (${resetMode})` : " (all)"}`);
        return;
      }

      return;
    }

    // ── Messages from the Figma plugin ──────────────────────────────────────
    if (isPlugin) {

      // Stitch Google OAuth — "Sign in with Google" button
      if (msg.type === "stitch-auth") {
        (async () => {
          try {
            sendToPlugin({ type: "stitch-auth-status", status: "signing-in" });
            console.log("  Stitch: starting Google OAuth flow...");
            const accessToken = await startStitchAuth();
            providerConfig.apiKey = accessToken; // store as apiKey for relay compatibility
            saveProviderConfig();
            const email = getStitchEmail();
            console.log(`  Stitch: authenticated as ${email || "unknown"}`);
            sendToPlugin({ type: "stitch-auth-status", status: "success", email });
          } catch (err) {
            console.error("  Stitch auth failed:", err.message);
            sendToPlugin({ type: "stitch-auth-status", status: "error", error: err.message });
          }
        })();
        return;
      }

      // Stitch sign-out
      if (msg.type === "stitch-signout") {
        clearStitchAuth();
        console.log("  Stitch: signed out");
        sendToPlugin({ type: "stitch-auth-status", status: "signed-out" });
        return;
      }

      // Set AI provider / API key
      if (msg.type === "set-provider") {
        providerConfig = {
          provider: msg.provider || "claude",
          apiKey: msg.apiKey || null,
          projectId: msg.projectId || null,
        };
        saveProviderConfig();
        console.log(`  🔑 provider set: ${providerConfig.provider}`);
        sendToPlugin({ type: "provider-stored", provider: providerConfig.provider });
        refreshAuthState().catch(() => {});
        return;
      }

      // Set active design system
      if (msg.type === "set-design-system") {
        const newId = msg.designSystemId || null;
        if (newId !== activeDesignSystemId) {
          activeDesignSystemId = newId;
          resetSession();
          resetCodexSession();
          console.log(`  🎨 design system: ${newId || "none"} (sessions reset)`);
        }
        sendToPlugin({ type: "design-system-stored", designSystemId: activeDesignSystemId });
        // Broadcast DS change to all connected MCP sockets so intelligence layer stays in sync
        broadcastToMcpSockets(JSON.stringify({ type: "design-system-changed", designSystemId: activeDesignSystemId }));
        return;
      }

      // ── Knowledge source management ──────────────────────────────────
      if (msg.type === "add-content-file") {
        const fileName = msg.name || "file";
        const dataUrl = msg.data || "";
        console.log(`  📄 Adding file: ${fileName}`);

        (async () => {
          try {
            // Decode base64 DataURL to buffer
            const b64Match = dataUrl.match(/^data:[^;]*;base64,(.+)$/);
            if (!b64Match) throw new Error("Invalid file data");
            const buffer = Buffer.from(b64Match[1], "base64");

            const ext = (fileName.match(/\.(\w+)$/)?.[1] || "").toLowerCase();
            let title, text, meta = { fileName, fileType: ext };

            if (ext === "pdf") {
              const result = await parsePdfBuffer(buffer);
              title = result.title || fileName.replace(/\.\w+$/, "");
              text = result.text;
              meta.pages = result.pages;
            } else if (ext === "docx" || ext === "doc") {
              const result = await parseDocxBuffer(buffer);
              title = result.title || fileName.replace(/\.\w+$/, "");
              text = result.text;
            } else {
              // Plain text formats (txt, md, csv, json, etc.)
              title = fileName.replace(/\.\w+$/, "");
              text = buffer.toString("utf-8");
            }

            if (!text || text.trim().length === 0) {
              throw new Error("No text content could be extracted from this file");
            }

            const source = createContentSource(title, text, meta);
            activeContentSources.set(source.id, source);
            console.log(`  ✅ File added: "${title}" (${text.length} chars${meta.pages ? `, ${meta.pages} pages` : ""})`);
            sendToPlugin({
              type: "content-added",
              source: {
                id: source.id, title: source.title, sourceCount: source.sources.length,
                meta: source.meta, extractedAt: source.extractedAt,
                charCount: text.length,
                preview: text.slice(0, 500).replace(/\s+/g, " ").trim(),
              },
            });
            sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
          } catch (err) {
            console.log(`  ⚠ File error: ${err.message}`);
            sendToPlugin({ type: "content-error", error: err.message, fileName });
          }
        })();
        return;
      }

      if (msg.type === "add-content-url") {
        const url = (msg.url || "").trim();
        console.log(`  🔗 Fetching URL: ${url.slice(0, 60)}…`);

        (async () => {
          try {
            if (!url || !/^https?:\/\//i.test(url)) throw new Error("Invalid URL");
            const result = await fetchUrlContent(url);
            if (!result.text || result.text.trim().length < 20) {
              throw new Error("Could not extract meaningful content from this URL");
            }
            const source = createContentSource(
              result.title || url,
              result.text,
              { url, fileType: "url" }
            );
            activeContentSources.set(source.id, source);
            console.log(`  ✅ URL added: "${source.title}" (${result.text.length} chars)`);
            sendToPlugin({
              type: "content-added",
              source: {
                id: source.id, title: source.title, sourceCount: source.sources.length,
                meta: source.meta, extractedAt: source.extractedAt,
                charCount: result.text.length,
                preview: result.text.slice(0, 500).replace(/\s+/g, " ").trim(),
              },
            });
            sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
          } catch (err) {
            console.log(`  ⚠ URL error: ${err.message}`);
            sendToPlugin({ type: "content-error", error: err.message, url });
          }
        })();
        return;
      }

      if (msg.type === "add-content-text") {
        const title = msg.title || "Pasted Content";
        const content = msg.content || "";
        if (!content.trim()) {
          sendToPlugin({ type: "content-error", error: "No content provided" });
          return;
        }
        const source = createContentSource(title, content, { fileType: "text" });
        activeContentSources.set(source.id, source);
        console.log(`  ✅ Text pasted: "${title}" (${content.length} chars)`);
        sendToPlugin({
          type: "content-added",
          source: {
            id: source.id, title: source.title, sourceCount: source.sources.length,
            meta: source.meta, extractedAt: source.extractedAt,
            charCount: content.length,
            preview: content.slice(0, 500).replace(/\s+/g, " ").trim(),
          },
        });
        sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
        return;
      }

      if (msg.type === "remove-content") {
        const id = msg.sourceId;
        if (activeContentSources.has(id)) {
          const title = activeContentSources.get(id).title;
          activeContentSources.delete(id);
          console.log(`  📄 Source removed: "${title}"`);
          sendToPlugin({ type: "content-removed", sourceId: id });
          sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
        }
        return;
      }

      if (msg.type === "list-content") {
        sendToPlugin({
          type: "content-list",
          sources: Array.from(activeContentSources.values()).map(s => ({
            id: s.id, title: s.title, sourceCount: s.sources.length, meta: s.meta || {}, extractedAt: s.extractedAt,
          })),
        });
        return;
      }

      // ── Knowledge Hub ────────────────────────────────────────────────
      if (msg.type === "hub-scan") {
        const catalog = scanKnowledgeHub();
        console.log(`  📚 Knowledge Hub: ${catalog.length} file(s) found`);
        sendToPlugin({ type: "hub-catalog", files: catalog });
        return;
      }

      if (msg.type === "hub-load") {
        const fileName = msg.fileName;
        console.log(`  📚 Loading hub file: ${fileName}`);
        (async () => {
          try {
            const source = await loadHubFile(fileName);
            activeContentSources.set(source.id, source);
            const text = source.sources[0]?.content || "";
            console.log(`  ✅ Hub file loaded: "${source.title}" (${text.length} chars)`);
            sendToPlugin({
              type: "content-added",
              source: {
                id: source.id, title: source.title, sourceCount: source.sources.length,
                meta: source.meta, extractedAt: source.extractedAt,
                charCount: text.length,
                preview: text.slice(0, 500).replace(/\s+/g, " ").trim(),
              },
            });
            sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
          } catch (err) {
            console.log(`  ⚠ Hub error: ${err.message}`);
            sendToPlugin({ type: "content-error", error: err.message, fileName });
          }
        })();
        return;
      }

      if (msg.type === "hub-search") {
        const results = searchHub(msg.query || "");
        sendToPlugin({ type: "hub-search-results", files: results, query: msg.query });
        return;
      }

      // ── Web Reference Site management ───────────────────────────────
      if (msg.type === "add-reference-site") {
        const site = addReferenceSite({ name: msg.name, baseUrl: msg.baseUrl || msg.url, searchDomain: msg.searchDomain });
        console.log(`  🌐 Reference site added: ${site.name} (${site.searchDomain})`);
        sendToPlugin({ type: "reference-site-added", site });
        sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
        return;
      }

      if (msg.type === "remove-reference-site") {
        removeReferenceSite(msg.id);
        console.log(`  🌐 Reference site removed: ${msg.id}`);
        sendToPlugin({ type: "reference-site-removed", id: msg.id });
        sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
        return;
      }

      if (msg.type === "list-reference-sites") {
        sendToPlugin({ type: "reference-sites-list", sites: getReferenceSites() });
        return;
      }

      // Chat message → route to the configured AI runner
      if (msg.type === "chat") {
        const requestId = msg.id;
        const prov = providerConfig.provider || "claude";
        const chatMode = msg.mode || "code";
        let chatMessage = msg.message || "";

        // ── /mcp slash command — diagnostic (plugin side) ─────────────────
        if (chatMessage.trim().toLowerCase() === "/mcp") {
          (async () => {
            const cloudConfig = loadCloudConfig();
            const lines = [];
            lines.push("**MCP Diagnostics**\n");
            if (cloudConfig && cloudConfig.cloudUrl) {
              lines.push(`✅ Cloud config: \`${cloudConfig.cloudUrl}\``);
              lines.push(`   Token: \`${cloudConfig.sessionToken?.slice(0, 8)}…\``);
            } else {
              lines.push("❌ No cloud config — run `npx figma-intelligence setup`");
            }
            if (cloudConfig && cloudConfig.cloudUrl) {
              try {
                const https = require("https");
                const health = await new Promise((resolve, reject) => {
                  const req = https.get(`${cloudConfig.cloudUrl}/health`, { timeout: 5000 }, (res) => {
                    let data = "";
                    res.on("data", (c) => { data += c; });
                    res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
                  });
                  req.on("error", reject);
                  req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
                });
                if (health && health.status === "ok") {
                  lines.push(`✅ Cloud server healthy (uptime: ${Math.floor(health.uptime / 60)}m, sessions: ${health.activeSessions})`);
                } else {
                  lines.push("⚠️ Cloud server responded but status not ok");
                }
              } catch (e) {
                lines.push(`❌ Cloud server unreachable: ${e.message}`);
              }
            }
            const vsConnected = vscodeSockets.size > 0;
            lines.push(vsConnected ? `✅ VS Code connected (${vscodeSockets.size} socket(s))` : "⚠️ No VS Code extension connected");
            lines.push("\n💡 If tools aren't working, start a **New Conversation** for a fresh MCP session.");
            const fullText = lines.join("\n");
            sendToPlugin({ type: "text_delta", id: requestId, delta: fullText });
            sendToPlugin({ type: "done", id: requestId, fullText });
          })();
          return;
        }

        // Debug: log all incoming chat messages
        try { appendFileSync("/tmp/import-vars-debug.log", `${new Date().toISOString()} CHAT prov=${prov} msg="${chatMessage.slice(0,100)}" attachments=${JSON.stringify((msg.attachments||[]).map(a=>({name:a.name,len:a.data?.length})))}\n`); } catch {}
        try { appendFileSync("/tmp/import-vars-debug.log", `${new Date().toISOString()} isImport=${isImportVariablesIntent(chatMessage, msg.attachments)}\n`); } catch {}

        // Pre-parse Figma links so the AI doesn't need to extract file_key/node_id
        const figmaLinkMatch2 = chatMessage.match(/https:\/\/www\.figma\.com\/(?:design|file)\/[^\s]+/);
        if (figmaLinkMatch2) {
          try {
            const { parseFigmaLink } = require("./spec-helpers/parse-figma-link");
            const parsed = parseFigmaLink(figmaLinkMatch2[0]);
            chatMessage += `\n\n[Pre-parsed Figma link: file_key="${parsed.file_key}", node_id="${parsed.node_id}"]`;
          } catch (e) { /* ignore parse errors */ }
        }

        // /knowledge command — intercept and handle via knowledge hub
        if (/^\s*\/knowledge\b/i.test(chatMessage)) {
          const query = chatMessage.replace(/^\s*\/knowledge\s*/i, "").trim();
          const catalog = scanKnowledgeHub();
          console.log(`  📚 /knowledge command: ${catalog.length} files in hub${query ? `, searching: "${query}"` : ""}`);

          if (query) {
            // Auto-search and load matching hub files
            const matches = searchHub(query);
            if (matches.length > 0) {
              (async () => {
                try {
                  const source = await loadHubFile(matches[0].fileName);
                  activeContentSources.set(source.id, source);
                  const text = source.sources[0]?.content || "";
                  sendToPlugin({
                    type: "content-added",
                    source: {
                      id: source.id, title: source.title, sourceCount: source.sources.length,
                      meta: source.meta, extractedAt: source.extractedAt,
                      charCount: text.length,
                      preview: text.slice(0, 500).replace(/\s+/g, " ").trim(),
                    },
                  });
                  // Send a visible chat response
                  const otherNames = matches.slice(1, 4).map(m => `"${m.title}"`).join(", ");
                  let responseText = `📚 **Loaded "${source.title}"** from Knowledge Hub (${text.length.toLocaleString()} chars).\n\nYou can now ask me questions about this source — I'll ground my answers in its content.`;
                  if (matches.length > 1) responseText += `\n\n_${matches.length - 1} other match(es): ${otherNames}_`;
                  sendToPlugin({ type: "text_delta", id: requestId, delta: responseText });
                  sendToPlugin({ type: "done", id: requestId, fullText: responseText });
                  sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
                } catch (err) {
                  sendToPlugin({ type: "text_delta", id: requestId, delta: `⚠️ Could not load: ${err.message}` });
                  sendToPlugin({ type: "done", id: requestId, fullText: err.message });
                }
              })();
            } else {
              // No matches — show what's available
              const fileList = catalog.map(f => `• ${f.title} (${f.fileType.toUpperCase()})`).join("\n");
              const responseText = `📚 No files matching "${query}" found in the Knowledge Hub.\n\n**Available files (${catalog.length}):**\n${fileList || "(empty)"}\n\n_Try: \`/knowledge <keyword>\` to search, or click the 📖 icon to browse._`;
              sendToPlugin({ type: "text_delta", id: requestId, delta: responseText });
              sendToPlugin({ type: "done", id: requestId, fullText: responseText });
              sendToPlugin({ type: "hub-catalog", files: catalog, query });
            }
          } else {
            // Just "/knowledge" — show catalog as chat response + open panel
            const fileList = catalog.map(f => `• **${f.title}** (${f.fileType.toUpperCase()}, ${(f.sizeBytes / 1024).toFixed(0)} KB)`).join("\n");
            const activeList = Array.from(activeContentSources.values()).map(s => `• ✅ ${s.title}`).join("\n");
            let responseText = `📚 **Knowledge Hub** — ${catalog.length} file(s) available\n\n`;
            if (catalog.length > 0) {
              responseText += `**Library:**\n${fileList}\n\n`;
              responseText += `_Use \`/knowledge <keyword>\` to load a specific file, or click the 📖 icon to browse and activate._`;
            } else {
              responseText += `No files yet. Add PDFs, DOCX, or TXT files to:\n\`figma-bridge-plugin/knowledge-hub/\``;
            }
            if (activeList) responseText += `\n\n**Currently active sources:**\n${activeList}`;
            sendToPlugin({ type: "text_delta", id: requestId, delta: responseText });
            sendToPlugin({ type: "done", id: requestId, fullText: responseText });
            sendToPlugin({ type: "hub-catalog", files: catalog });
          }
          return;
        }

        // ── Import .md → Figma variables (works from any provider) ──────
        if (isImportVariablesIntent(chatMessage, msg.attachments)) {
          handleImportVariables(requestId, chatMessage, msg.attachments, (ev) => sendToPlugin(ev));
          return;
        }

        // ── Component Doc Generator: handle follow-up after chooser ─────
        // If the chooser was shown and user replies with a type selection,
        // rewrite the message to include the original context + specific spec type.
        if (pendingDocGenChooser && (chatMode === "code" || chatMode === "dual")) {
          const elapsed = Date.now() - pendingDocGenChooser.shownAt;
          if (elapsed < 10 * 60 * 1000) { // within 10 minutes
            const reply = (chatMessage || "").trim().toLowerCase();
            const specMap = {
              "1": "anatomy", "anatomy": "anatomy",
              "2": "api", "api": "api",
              "3": "property", "properties": "property", "property": "property",
              "4": "color", "color": "color",
              "5": "structure", "structure": "structure",
              "6": "screen-reader", "screen reader": "screen-reader", "screen-reader": "screen-reader",
              "all": "all",
            };
            // Check if reply matches a spec type choice
            const matched = specMap[reply];
            // Also check for multi-select like "1, 3, 5" or "1 3 5"
            const multiMatch = reply.match(/^[\d,\s]+$/);
            if (matched || multiMatch) {
              const original = pendingDocGenChooser.originalMessage;
              pendingDocGenChooser = null;
              // CRITICAL: Reset session so the AI starts fresh with the correct
              // system prompt containing the spec-type skill addendum.
              resetSession(chatMode);
              console.log(`  📋 Component Doc Generator (plugin): reset ${chatMode} session for fresh system prompt`);
              if (matched === "all" || (multiMatch && reply.replace(/\s/g, "").split(",").length >= 6)) {
                // User wants all specs — send each type
                chatMessage = `${original}\n\nThe user selected ALL spec types. Generate all 6 specification documents: anatomy, api, property, color, structure, and screen-reader specs. Start with the anatomy spec, then proceed to each subsequent type.`;
                console.log(`  📋 Component Doc Generator: user chose ALL — rewriting message`);
              } else if (multiMatch) {
                const nums = reply.replace(/\s/g, "").split(",").filter(Boolean);
                const types = nums.map(n => specMap[n]).filter(Boolean);
                chatMessage = `${original}\n\nThe user selected these spec types: ${types.join(", ")}. Generate a create ${types[0]} spec for the component first.`;
                console.log(`  📋 Component Doc Generator: user chose [${types.join(", ")}] — rewriting message`);
              } else {
                chatMessage = `${original}\n\nThe user selected: create ${matched} spec for this component.`;
                console.log(`  📋 Component Doc Generator: user chose "${matched}" — rewriting message`);
              }
            } else {
              // Reply doesn't look like a spec choice — clear pending state
              pendingDocGenChooser = null;
            }
          } else {
            pendingDocGenChooser = null; // expired
          }
        }

        // ── Component Doc Generator — no chooser, generate complete spec directly ────────
        // The tool now auto-enriches all sections from the knowledge base in a single call.
        // No need to present options or use a 2-phase workflow.

        // ── Design Decision: auto-register NN Group + proactive article fetch ──
        {
          const { detectActiveSkills } = require("./shared-prompt-config");
          const msgSkills = detectActiveSkills(chatMessage);
          if (msgSkills.includes("Design Decision")) {
            const sites = getReferenceSites();
            if (!sites.some(s => s.searchDomain === "nngroup.com")) {
              addReferenceSite({ name: "Nielsen Norman Group", searchDomain: "nngroup.com" });
              console.log("  📖 Auto-registered nngroup.com as reference site for Design Decision");
            }
            // Proactive search — fetch NN Group article and inject as grounding
            (async () => {
              try {
                const nnResult = await Promise.race([
                  searchReferenceSites(chatMessage),
                  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
                ]);
                if (nnResult) {
                  const nnSource = createContentSource(nnResult.title, nnResult.text, { url: nnResult.url, source: "nngroup.com" });
                  activeContentSources.set(nnSource.id, nnSource);
                  console.log(`  📖 NN Group article loaded: "${nnResult.title}"`);
                }
              } catch (e) {
                console.error(`  ⚠ NN Group search failed: ${e.message}`);
              }
            })();
          }
        }

        // ── Chat Tiers: always route through AI with grounding ─────────
        const rawMessage = chatMessage; // preserve original for knowledge/web search

        // Tier 1: Fetch web reference articles async, then route to AI
        // (No more raw text "instant answers" — AI always synthesizes the response)
        if (chatMode === "chat" && getReferenceSites().length > 0) {
          (async () => {
            try {
              const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000));
              const webAnswer = await Promise.race([searchReferenceSites(rawMessage), timeoutPromise]);
              if (webAnswer) {
                // Add fetched article as a content source for grounding, don't return it raw
                const webSource = createContentSource(webAnswer.title, webAnswer.text || "", {
                  url: webAnswer.url,
                  source: webAnswer.siteName,
                });
                activeContentSources.set(webSource.id, webSource);
                console.log(`  🌐 Web reference loaded: ${webAnswer.siteName} — ${webAnswer.title}`);
              }
            } catch (err) {
              console.error(`  ⚠ Web reference search error: ${err.message}`);
            }
            routeToAiProvider();
          })();
          return; // async — routeToAiProvider called inside the async block
        }

        routeToAiProvider();
        return;

        function routeToAiProvider() {

        // Inject knowledge source grounding context if sources are active
        if (activeContentSources.size > 0) {
          const groundingCtx = buildGroundingContext(activeContentSources, rawMessage);
          if (groundingCtx) {
            chatMessage = groundingCtx +
              "\n---\n\n" +
              "INSTRUCTIONS: Use the knowledge context above to answer the user's question. " +
              "Synthesize the information into a clear, structured answer — do NOT just quote raw text. " +
              "Cite the source name when referencing specific information. " +
              "If the context doesn't contain relevant information, say so and answer from your general knowledge.\n\n" +
              "User question: " + chatMessage;
            console.log(`  📄 Injected ${activeContentSources.size} knowledge source(s) as grounding context`);
          }
        }

        console.log(`  💬 chat [${prov}/${chatMode}] (id: ${requestId}): ${(chatMessage).slice(0, 60)}…`);

        const onEvent = (event) => {
          // Intercept figma_command events — forward as bridge-request to plugin
          if (event.type === "figma_command") {
            const cmdId = `stitch-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            sendToPlugin({
              type: "bridge-request",
              id: cmdId,
              method: event.method,
              params: event.params || {},
            });
            console.log(`  🎨 stitch → figma: ${event.method}`);
            return;
          }

          sendToPlugin(event);
          // In dual mode, also forward to VS Code clients for code extraction
          if (chatMode === "dual") {
            broadcastToVscodeSockets(event);
          }
          if (event.type === "tool_start") {
            console.log(`  🔧 tool_start: ${event.tool}`);
          } else if (event.type === "tool_done") {
            console.log(`  ✅ tool_done:  ${event.tool}${event.isError ? " [ERROR]" : ""}`);
          } else if (event.type === "phase_start") {
            console.log(`  📋 phase: ${event.phase}`);
          }
        };

        let proc;
        if (prov === "openai") {
          // Use Codex CLI (subscription-based) — no API key needed
          proc = runCodex({
            message: chatMessage,
            attachments: msg.attachments,
            conversation: msg.conversation,
            requestId,
            model: msg.model,
            designSystemId: activeDesignSystemId,
            mode: chatMode,
            onEvent,
          });
        } else if (prov === "gemini") {
          if (geminiCliAuthInfo.loggedIn) {
            // Subscription mode — use Gemini CLI (Google One AI Premium / Gemini Advanced)
            proc = runGeminiCli({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              onEvent,
            });
          } else {
            // API key mode — fallback for users without subscription CLI auth
            proc = runGemini({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              apiKey: providerConfig.apiKey,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              onEvent,
            });
          }
        } else if (prov === "perplexity") {
          proc = runPerplexity({
            message: chatMessage,
            attachments: msg.attachments,
            conversation: msg.conversation,
            requestId,
            apiKey: providerConfig.apiKey,
            model: msg.model,
            mode: "chat",
            onEvent,
          });
        } else if (prov === "stitch") {
          // ── Check for "sync design system" intent before routing to Stitch ──
          if (isSyncDesignIntent(chatMessage)) {
            handleSyncDesignSystem(requestId, chatMessage, onEvent);
            return;
          }

          if (isImportVariablesIntent(chatMessage, msg.attachments)) {
            handleImportVariables(requestId, chatMessage, msg.attachments, onEvent);
            return;
          }

          // If a .md file is attached, extract its content as design context for generation
          let designContext = null;
          if (msg.attachments?.length) {
            const mdFile = msg.attachments.find(a => /\.md$/i.test(a.name));
            if (mdFile?.data) designContext = mdFile.data;
          }

          console.log(`  🎨 Routing to Stitch runner (apiKey: ${providerConfig.apiKey ? "set" : "MISSING"}${designContext ? ", with .md design context" : ""})`);
          proc = runStitch({
            message: chatMessage,
            requestId,
            apiKey: providerConfig.apiKey,
            projectId: providerConfig.projectId,
            model: msg.model,
            designContext,
            onEvent,
          });
        } else if (prov === "bridge") {
          // Bridge-only mode: no built-in AI — tell the plugin immediately
          sendToPlugin({
            type: "error",
            id: requestId,
            error: "Bridge mode is active. Chat is handled by your external AI tool (VS Code, Cursor, etc.) via MCP — not by the plugin itself.",
          });
          sendToPlugin({ type: "done", id: requestId, fullText: "" });
          return;
        } else {
          // Default: Claude
          const anthropicKey = getAnthropicApiKey();
          if (chatMode === "chat" && anthropicKey) {
            // Tier 3: Direct Anthropic API — fast streaming (~200ms first token)
            const { buildChatPrompt } = require("./shared-prompt-config");
            proc = runAnthropicChat({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              apiKey: anthropicKey,
              model: msg.model,
              systemPrompt: buildChatPrompt(),
              onEvent,
            });
          } else {
            // Tier 4: Claude CLI subprocess (code/dual mode, or no API key)
            proc = runClaude({
              message: chatMessage,
              attachments: msg.attachments,
              conversation: msg.conversation,
              requestId,
              model: msg.model,
              designSystemId: activeDesignSystemId,
              mode: chatMode,
              frameworkConfig: msg.frameworkConfig || {},
              onEvent,
            });
          }
        }

        activeChatProcesses.set(requestId, proc);
        proc.on("close", () => activeChatProcesses.delete(requestId));
        return;
        } // end routeToAiProvider
      }

      // Abort a running chat
      if (msg.type === "abort-chat") {
        const proc = activeChatProcesses.get(msg.id);
        if (proc) {
          proc.kill("SIGTERM");
          activeChatProcesses.delete(msg.id);
          console.log(`  ⛔ chat aborted (id: ${msg.id})`);
        }
        return;
      }

      // Reset conversation session (user clicked "New Chat" in plugin UI)
      if (msg.type === "new-conversation" || msg.type === "clear-history") {
        const resetMode = msg.mode || null; // null = reset all modes
        resetSession(resetMode);
        resetCodexSession(resetMode);
        console.log(`  🔄 conversation session reset${resetMode ? ` (${resetMode})` : " (all)"}`);
        return;
      }

      // Bridge events (selection change, doc change etc.) → forward to MCP
      if (msg.type === "bridge-event") {
        broadcastToMcpSockets(raw);
        console.log(`  ↺ plugin event: ${msg.eventType || "unknown"}`);
        return;
      }

      // Plugin hello
      if (msg.type === "plugin-hello") {
        console.log(`  Plugin identified: ${msg.fileName || "unknown"}`);
        return;
      }

      // Trigger login from plugin UI
      if (msg.type === "trigger-login") {
        const { execSync } = require("child_process");
        const provider = msg.provider || "claude";
        console.log(`  Triggering ${provider} login…`);
        try {
          if (provider === "claude") {
            require("child_process").spawn("claude", ["login"], { stdio: "inherit", detached: true }).unref();
          } else if (provider === "openai") {
            require("child_process").spawn("codex", ["login"], { stdio: "inherit", detached: true }).unref();
          }
        } catch (err) {
          console.log(`  Login trigger failed: ${err.message}`);
        }
        return;
      }



      // MCP tool response from plugin → route back to the requesting MCP socket
      if (msg.id && !msg.method) {
        // Check if this is a relay-initiated request first
        const relayReq = pendingRelayRequests.get(msg.id);
        if (relayReq) {
          clearTimeout(relayReq.timer);
          pendingRelayRequests.delete(msg.id);
          if (msg.error) {
            relayReq.reject(new Error(msg.error));
          } else {
            relayReq.resolve(msg.result);
          }
          console.log(`  ← relay request response (id: ${msg.id})`);
          return;
        }

        // Cloud tunnel: route response back to cloud if it originated there
        if (routeToCloudIfNeeded(msg.id, raw)) {
          console.log(`  ← plugin response → cloud tunnel (id: ${msg.id})`);
          return;
        }

        const targetSocket = pendingRequests.get(msg.id);
        if (targetSocket && targetSocket.readyState === 1) {
          targetSocket.send(raw);
          console.log(`  ← plugin response (id: ${msg.id})`);
        } else {
          broadcastToMcpSockets(raw);
        }
        pendingRequests.delete(msg.id);
      }
      return;
    }

    // ── Messages from an MCP server ─────────────────────────────────────────
    if (msg.id && msg.method) {
      // Handle getActiveDesignSystemId directly — no need to forward to plugin
      if (msg.method === "getActiveDesignSystemId") {
        ws.send(JSON.stringify({ id: msg.id, result: activeDesignSystemId }));
        console.log(`  ← relay responded: getActiveDesignSystemId = ${activeDesignSystemId || "none"}`);
        return;
      }
      if (pluginSocket && pluginSocket.readyState === 1) {
        pendingRequests.set(msg.id, ws);
        pluginSocket.send(JSON.stringify({
          type: "bridge-request",
          id: msg.id,
          method: msg.method,
          params: msg.params || {},
        }));
        console.log(`  → mcp request: ${msg.method} (id: ${msg.id})`);
      } else {
        ws.send(JSON.stringify({
          id: msg.id,
          error: "Figma plugin is not connected. Open Figma and run the Intelligence Bridge plugin.",
        }));
        console.log(`  ✗ No plugin connected for: ${msg.method}`);
      }
    }
  });

  ws.on("close", () => {
    if (isPlugin) {
      // P3: Grace period — wait before fully disconnecting plugin
      console.log(`⚠  Figma plugin disconnected — ${PLUGIN_GRACE_PERIOD_MS / 1000}s grace period`);
      pluginGraceState = { activeDesignSystemId };
      pluginGraceTimer = setTimeout(() => {
        pluginSocket = null;
        pluginGraceTimer = null;
        pluginGraceState = null;
        console.log("⚠  Plugin grace period expired — fully disconnected");
        sendRelayStatus(null, hasConnectedMcpSocket());
      }, PLUGIN_GRACE_PERIOD_MS);
    } else {
      mcpSockets.delete(ws);
      for (const [requestId, requestSocket] of pendingRequests.entries()) {
        if (requestSocket === ws) pendingRequests.delete(requestId);
      }
      console.log("⚠  MCP server disconnected");
      sendRelayStatus(pluginSocket, hasConnectedMcpSocket());
    }
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error (${isPlugin ? "plugin" : "mcp"}):`, err.message);
  });
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log("\nShutting down relay…");
  for (const proc of activeChatProcesses.values()) proc.kill();
  if (_mcpProc) _mcpProc.kill();
  if (pluginGraceTimer) clearTimeout(pluginGraceTimer);
  if (cloudTunnelReconnectTimer) clearTimeout(cloudTunnelReconnectTimer);
  if (cloudTunnelSocket) cloudTunnelSocket.close(1000, "Relay shutting down");
  wss.close();
  process.exit(0);
});

})(); // end async IIFE for port fallback
