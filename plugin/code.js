/**
 * Figma Intelligence Bridge Plugin — Plugin Sandbox (code.js)
 *
 * This runs inside Figma's plugin sandbox. It cannot do network I/O directly.
 * It communicates with the UI iframe (ui.html) via figma.ui.postMessage / onmessage.
 *
 * Flow:
 *   MCP Server → WebSocket → ui.html → postMessage → this code → Figma Plugin API
 *   result  ←   WebSocket ← ui.html ← postMessage ← this code
 */

var UI_WIDTH = 320;
var UI_HEIGHT = 480;
var UI_MIN_HEIGHT = 480;
var UI_MAX_HEIGHT = 960;

figma.showUI(__html__, { visible: true, width: UI_WIDTH, height: UI_HEIGHT });

function normalizeExecuteCode(code) {
  var trimmed = typeof code === "string" ? code.trim() : "";
  if (!trimmed) return "";

  // Many callers already pass an async IIFE. Preserve compatibility by
  // returning its resolved value instead of letting the outer wrapper finish
  // early with `undefined`.
  if (/^\(async\s*\(\)\s*=>\s*\{[\s\S]*\}\)\(\);?$/.test(trimmed)) {
    return "return await " + trimmed;
  }

  return code;
}

function getSelectionSummary() {
  return figma.currentPage.selection.map(function(node) {
    return { id: node.id, name: node.name, type: node.type };
  });
}

function getCurrentPageSummary() {
  return {
    id: figma.currentPage.id,
    name: figma.currentPage.name,
  };
}

function summarizeDocumentChange(change) {
  var summary = { type: change.type || "UNKNOWN" };

  if (change.id) summary.id = change.id;
  if (change.node && change.node.id) {
    summary.nodeId = change.node.id;
    summary.nodeType = change.node.type;
  } else if (change.nodeId) {
    summary.nodeId = change.nodeId;
  }

  return summary;
}

function postBridgeEvent(eventType, payload) {
  figma.ui.postMessage({
    type: "bridge-event",
    eventType: eventType,
    payload: payload,
    timestamp: Date.now(),
  });
}

function emitReadyEvent() {
  postBridgeEvent("bridge.ready", {
    fileName: figma.root.name,
    currentPage: getCurrentPageSummary(),
    pageCount: figma.root.children.length,
    selection: getSelectionSummary(),
    capabilities: getBridgeCapabilities(),
  });
}

function getBridgeCapabilities() {
  return {
    editorType: figma.editorType,
    mode: figma.mode || null,
    variablesApi: !!figma.variables,
    localVariablesApi: !!(figma.variables && figma.variables.getLocalVariableCollectionsAsync),
    localPaintStylesApi: !!figma.getLocalPaintStylesAsync,
    localTextStylesApi: !!figma.getLocalTextStylesAsync,
    localEffectStylesApi: !!figma.getLocalEffectStylesAsync,
    fileName: figma.root.name,
  };
}

function emitSelectionChange() {
  postBridgeEvent("selectionchange", {
    selection: getSelectionSummary(),
  });
}

function emitCurrentPageChange() {
  postBridgeEvent("currentpagechange", {
    currentPage: getCurrentPageSummary(),
    selection: getSelectionSummary(),
  });
}

var documentChangeFlushTimer = null;
var pendingDocumentChanges = [];

function flushDocumentChanges() {
  if (!pendingDocumentChanges.length) return;
  var batch = pendingDocumentChanges.splice(0, 50).map(summarizeDocumentChange);
  postBridgeEvent("documentchange", {
    documentChanges: batch,
  });
}

function scheduleDocumentChangeFlush() {
  if (documentChangeFlushTimer) return;
  // Coalesce noisy document changes so the UI bridge socket stays stable.
  documentChangeFlushTimer = setTimeout(function() {
    documentChangeFlushTimer = null;
    flushDocumentChanges();
  }, 120);
}

function emitDocumentChange(event) {
  var changes = Array.isArray(event && event.documentChanges) ? event.documentChanges : [];
  if (!changes.length) return;
  pendingDocumentChanges = pendingDocumentChanges.concat(changes);
  if (pendingDocumentChanges.length > 200) {
    pendingDocumentChanges = pendingDocumentChanges.slice(-200);
  }
  scheduleDocumentChangeFlush();

  // Detect variable/token changes for taxonomy docs auto-sync
  var hasVariableChange = changes.some(function(c) {
    var t = (c.type || "").toUpperCase();
    return t === "VARIABLE_CHANGE" || t === "VARIABLE_COLLECTION_CHANGE"
      || t === "CREATE" || t === "PROPERTY_CHANGE" || t === "DELETE";
  });
  if (hasVariableChange) {
    postBridgeEvent("variable-change", { timestamp: Date.now() });
  }
}

figma.on("selectionchange", emitSelectionChange);
figma.on("currentpagechange", emitCurrentPageChange);

async function initializeBridgeEvents() {
  try {
    await figma.loadAllPagesAsync();
    figma.on("documentchange", emitDocumentChange);
  } catch (error) {
    console.warn("Failed to enable documentchange events:", error);
  } finally {
    emitReadyEvent();
  }
}

initializeBridgeEvents();

// ─── Operation Cursor System ──────────────────────────────────────────────────
// Single honest cursor that tracks real operations. Moves to the actual target
// node, shows real operation names, and stays invisible when idle.

// Pre-load font for cursor label
figma.loadFontAsync({ family: "Inter", style: "Bold" }).catch(function() {
  figma.loadFontAsync({ family: "Inter", style: "Semi Bold" }).catch(function() {
    figma.loadFontAsync({ family: "Inter", style: "Regular" }).catch(function() {});
  });
});

// ── Cursor Configuration ──────────────────────────────────────────────────────
var CURSOR_NAME = "MCP Power";
var CURSOR_COLOR = { r: 0.43, g: 0.37, b: 0.85 }; // #6E5FD8
var CURSOR_TEXT_COLOR = { r: 1, g: 1, b: 1 };
var CURSOR_ANIM_DURATION = 250; // ms — perceptible but snappy
var SESSION_IDLE_TIMEOUT = 8000;

// ── Methods that skip cursor entirely (they manage their own frames) ──
var THEATRE_SKIP_METHODS = { execute: 1 };

// ── Shared State ──────────────────────────────────────────────────────────────
var opCursor = null;          // { pointer, label, text, x, y, fontStyle }
var operationCount = 0;
var cursorCleanupTimer = null;
var cursorActive = false;

// ── Operation Classification ──────────────────────────────────────────────────
var READ_OPERATIONS = {
  getNode:1, getSelection:1, getStatus:1, getPages:1,
  getStyles:1, getVariables:1, getComponentSets:1,
  searchComponents:1, screenshot:1, getCapabilities:1, ping:1,
};

// ── Human-readable operation labels (shown on cursor) ─────────────────────────
var METHOD_LABELS = {
  createChild: "Creating", createPage: "Creating page",
  moveNode: "Positioning", resizeNode: "Resizing",
  cloneNode: "Duplicating", deleteNode: "Removing",
  setFills: "Styling", setStrokes: "Styling",
  createVariable: "Creating token", updateVariable: "Updating token",
  createVariableCollection: "New collection",
  batchCreateVariables: "Creating tokens", batchUpdateVariables: "Updating tokens",
  deleteVariable: "Removing token",
  setText: "Writing text", renameNode: "Naming",
  setDescription: "Documenting",
  instantiateComponent: "Placing component",
};

// ── Utility ───────────────────────────────────────────────────────────────────
function theatreDelay(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ── Absolute Position Helper ───────────────────────────────────────────────────
function getAbsolutePosition(node) {
  try {
    if (node.absoluteTransform) {
      return {
        x: node.absoluteTransform[0][2],
        y: node.absoluteTransform[1][2],
        width: node.width || 0,
        height: node.height || 0,
      };
    }
  } catch (e) {}
  return { x: node.x || 0, y: node.y || 0, width: node.width || 0, height: node.height || 0 };
}

// ── Get Real Target Position ──────────────────────────────────────────────────
async function getTargetPosition(method, params) {
  try {
    var targetNode = null;
    if (params.nodeId) targetNode = await figma.getNodeByIdAsync(params.nodeId);
    if (!targetNode && params.parentId) targetNode = await figma.getNodeByIdAsync(params.parentId);

    if (targetNode && targetNode.absoluteTransform) {
      var abs = getAbsolutePosition(targetNode);
      // Position cursor just outside the top-left of the target node
      return { x: abs.x - 20, y: abs.y - 6 };
    }

    // Fall back to explicit coordinates if provided
    if (typeof params.x === "number" && typeof params.y === "number") {
      return { x: params.x - 20, y: params.y - 6 };
    }
  } catch (e) {}

  // Last resort: viewport center
  try {
    var vc = figma.viewport.center;
    return { x: vc.x, y: vc.y };
  } catch (e) {
    return { x: 400, y: 300 };
  }
}

// ── Build Operation Label ─────────────────────────────────────────────────────
function buildOperationLabel(method, params) {
  var prefix = METHOD_LABELS[method] || method;
  // Append the element name when available for context
  var name = params && params.name;
  if (!name && params && params.characters) {
    name = params.characters.length > 20 ? params.characters.substring(0, 20) + "…" : params.characters;
  }
  return name ? prefix + ": " + name : prefix;
}

// ── Cursor Creation ─────────────────────────────────────────────────────────
async function createCursorNode(x, y) {
  var POINTER_W = 14;
  var POINTER_H = 21;

  var pointer;
  try {
    pointer = figma.createVector();
    pointer.vectorPaths = [{
      windingRule: "NONZERO",
      data: "M 0 0 L 0 18 L 5 13 L 9 21 L 12 19.5 L 8 11 L 14 11 Z"
    }];
    pointer.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    pointer.strokes = [{ type: "SOLID", color: CURSOR_COLOR }];
    pointer.strokeWeight = 1.5;
    pointer.resize(POINTER_W, POINTER_H);
  } catch (e) {
    pointer = figma.createRectangle();
    pointer.resize(10, 14);
    pointer.cornerRadius = 1;
    pointer.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    pointer.strokes = [{ type: "SOLID", color: CURSOR_COLOR }];
    pointer.strokeWeight = 1;
  }
  pointer.name = "__agent_ptr_op";
  pointer.locked = true;
  pointer.x = x;
  pointer.y = y;
  figma.currentPage.appendChild(pointer);

  var label = figma.createFrame();
  label.name = "__agent_label_op";
  label.locked = true;
  label.fills = [{ type: "SOLID", color: CURSOR_COLOR }];
  label.cornerRadius = 4;
  label.layoutMode = "HORIZONTAL";
  label.primaryAxisSizingMode = "AUTO";
  label.counterAxisSizingMode = "AUTO";
  label.paddingLeft = 6;
  label.paddingRight = 6;
  label.paddingTop = 2;
  label.paddingBottom = 2;
  label.effects = [{
    type: "DROP_SHADOW",
    color: { r: 0, g: 0, b: 0, a: 0.3 },
    offset: { x: 0, y: 2 },
    radius: 4,
    visible: true,
    blendMode: "NORMAL",
    spread: 0,
  }];
  label.x = x + POINTER_W + 2;
  label.y = y + POINTER_H - 4;
  figma.currentPage.appendChild(label);

  var fontStyle = "Regular";
  var textNode = null;
  try {
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Bold" });
      fontStyle = "Bold";
    } catch (e) {
      try {
        await figma.loadFontAsync({ family: "Inter", style: "Semi Bold" });
        fontStyle = "Semi Bold";
      } catch (e2) {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      }
    }
    textNode = figma.createText();
    textNode.fontName = { family: "Inter", style: fontStyle };
    textNode.characters = CURSOR_NAME;
    textNode.fontSize = 10;
    textNode.fills = [{ type: "SOLID", color: CURSOR_TEXT_COLOR }];
    textNode.locked = true;
    label.appendChild(textNode);
  } catch (fontErr) {
    label.resize(50, 18);
  }

  opCursor = {
    pointer: pointer, label: label, text: textNode,
    x: x, y: y, fontStyle: fontStyle,
  };
}

// ── Cursor Label Update ────────────────────────────────────────────────────────
function updateCursorLabel(text) {
  if (!opCursor || !opCursor.text) return;
  try { opCursor.text.characters = text; } catch (e) {}
}

// ── Cursor Movement (instant) ──────────────────────────────────────────────────
function moveCursorTo(x, y) {
  if (!opCursor) return;
  try {
    opCursor.pointer.x = x;
    opCursor.pointer.y = y;
    opCursor.label.x = x + 16;
    opCursor.label.y = y + 17;
    opCursor.x = x;
    opCursor.y = y;
  } catch (e) {}
}

// ── Animated Cursor Movement ───────────────────────────────────────────────────
async function animateCursorTo(targetX, targetY, durationMs) {
  if (!opCursor) return;

  var dur = (typeof durationMs === "number") ? durationMs : CURSOR_ANIM_DURATION;
  var startX = opCursor.x;
  var startY = opCursor.y;
  var dx = targetX - startX;
  var dy = targetY - startY;
  var dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 15) {
    moveCursorTo(targetX, targetY);
    return;
  }

  var steps = Math.max(6, Math.min(18, Math.floor(dist / 18)));
  var stepDelay = Math.floor(dur / steps);

  for (var i = 1; i <= steps; i++) {
    var t = i / steps;
    var ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    moveCursorTo(startX + dx * ease, startY + dy * ease);
    if (i < steps) await theatreDelay(stepDelay);
  }
}

// ── Fade Out Cursor ───────────────────────────────────────────────────────────
async function fadeOutCursor(durationMs) {
  if (!opCursor) return;
  var stepDelay = Math.floor((durationMs || 400) / 5);
  for (var step = 4; step >= 0; step--) {
    var opacity = step / 4;
    try { opCursor.pointer.opacity = opacity; } catch (e) {}
    try { opCursor.label.opacity = opacity; } catch (e) {}
    if (step > 0) await theatreDelay(stepDelay);
  }
  removeCursorNodes();
}

// ── Ensure Cursor Exists ──────────────────────────────────────────────────────
async function ensureCursor(x, y) {
  if (opCursor) return;
  cleanupOrphanedCursors();
  await createCursorNode(x, y);
  cursorActive = true;
}

// ── Cleanup ────────────────────────────────────────────────────────────────────
function removeCursorNodes() {
  if (!opCursor) return;
  try { opCursor.pointer.remove(); } catch (e) {}
  try { opCursor.label.remove(); } catch (e) {}
  opCursor = null;
  cursorActive = false;
}

function cleanupOrphanedCursors() {
  try {
    var orphans = figma.currentPage.findAll(function(n) {
      return n.name && (
        n.name.indexOf("__agent_ptr_") === 0 ||
        n.name.indexOf("__agent_label_") === 0 ||
        n.name.indexOf("__agent_cursor_") === 0 ||
        n.name.indexOf("__cursor_") === 0
      );
    });
    for (var i = 0; i < orphans.length; i++) {
      try { orphans[i].remove(); } catch (e) {}
    }
  } catch (e) {}
}

// ── Bring Cursor to Front ─────────────────────────────────────────────────────
function bringCursorToFront() {
  if (!opCursor) return;
  try {
    if (opCursor.pointer && opCursor.pointer.parent === figma.currentPage) {
      figma.currentPage.appendChild(opCursor.pointer);
    }
    if (opCursor.label && opCursor.label.parent === figma.currentPage) {
      figma.currentPage.appendChild(opCursor.label);
    }
  } catch (e) {}
}

// ── Idle Cleanup Timer ────────────────────────────────────────────────────────
function resetCursorCleanupTimer() {
  if (cursorCleanupTimer) clearTimeout(cursorCleanupTimer);
  cursorCleanupTimer = setTimeout(function() {
    if (opCursor) {
      (async function() { await fadeOutCursor(400); })();
      figma.ui.postMessage({ type: "agent-session-end", timestamp: Date.now() });
    }
    operationCount = 0;
  }, SESSION_IDLE_TIMEOUT);
}

// ── Main Operation Cursor ─────────────────────────────────────────────────────
async function activateAgentForOperation(method, params) {
  if (READ_OPERATIONS[method]) return;

  operationCount++;
  var pos = await getTargetPosition(method, params || {});
  await ensureCursor(pos.x, pos.y);

  // Build label from real operation + element name
  var label = buildOperationLabel(method, params || {});
  updateCursorLabel(label);

  // Animate to actual target position
  await animateCursorTo(pos.x, pos.y);
  bringCursorToFront();

  // Report real activity to UI
  figma.ui.postMessage({
    type: "agent-activity",
    agent: CURSOR_NAME,
    method: method,
    status: label,
    phase: "WORKING",
    timestamp: Date.now(),
  });

  resetCursorCleanupTimer();
}

// ── Post-Operation Effect ──────────────────────────────────────────────────────
async function postOperationEffect(method, params, result) {
  if (READ_OPERATIONS[method]) return;
  if (!opCursor) return;

  // Move cursor to the newly created node's actual position
  if (result && result.id) {
    try {
      var newNode = await figma.getNodeByIdAsync(result.id);
      if (newNode && newNode.absoluteTransform) {
        var abs = getAbsolutePosition(newNode);
        await animateCursorTo(abs.x - 20, abs.y - 6, 150);
      }
    } catch (e) {}
  }

  resetCursorCleanupTimer();
}

// ─── End Operation Cursor System ──────────────────────────────────────────────

// ─── Multi-Agent Cursor System (Swarm Mode) ─────────────────────────────────
// Multiple named agent cursors with unique colors for parallel visual theatre.
// Each agent gets its own pointer + label that can move independently.

var AGENT_COLORS = {
  Layouter:   { r: 0.26, g: 0.52, b: 0.96 },  // #4285F4 blue
  Styler:     { r: 0.60, g: 0.33, b: 0.86 },  // #9955DB purple
  Copywriter: { r: 0.13, g: 0.72, b: 0.45 },  // #22B873 green
  Matcher:    { r: 0.96, g: 0.50, b: 0.14 },  // #F58024 orange
  Reviewer:   { r: 0.90, g: 0.22, b: 0.35 },  // #E63959 red
  Builder:    { r: 0.18, g: 0.73, b: 0.82 },  // #2EBAD1 teal
};

var agentCursors = {};  // { agentId: { pointer, label, text, x, y } }

async function createAgentCursorNode(agentId, x, y) {
  var color = AGENT_COLORS[agentId] || AGENT_COLORS.Builder;

  var pointer;
  try {
    pointer = figma.createVector();
    pointer.vectorPaths = [{
      windingRule: "NONZERO",
      data: "M 0 0 L 0 18 L 5 13 L 9 21 L 12 19.5 L 8 11 L 14 11 Z"
    }];
    pointer.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    pointer.strokes = [{ type: "SOLID", color: color }];
    pointer.strokeWeight = 1.5;
    pointer.resize(14, 21);
  } catch (e) {
    pointer = figma.createRectangle();
    pointer.resize(10, 14);
    pointer.cornerRadius = 1;
    pointer.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    pointer.strokes = [{ type: "SOLID", color: color }];
    pointer.strokeWeight = 1;
  }
  pointer.name = "__agent_ptr_" + agentId;
  pointer.locked = true;
  pointer.x = x;
  pointer.y = y;
  figma.currentPage.appendChild(pointer);

  var label = figma.createFrame();
  label.name = "__agent_label_" + agentId;
  label.locked = true;
  label.fills = [{ type: "SOLID", color: color }];
  label.cornerRadius = 4;
  label.layoutMode = "HORIZONTAL";
  label.primaryAxisSizingMode = "AUTO";
  label.counterAxisSizingMode = "AUTO";
  label.paddingLeft = 6;
  label.paddingRight = 6;
  label.paddingTop = 2;
  label.paddingBottom = 2;
  label.effects = [{
    type: "DROP_SHADOW",
    color: { r: 0, g: 0, b: 0, a: 0.3 },
    offset: { x: 0, y: 2 },
    radius: 4,
    visible: true,
    blendMode: "NORMAL",
    spread: 0,
  }];
  label.x = x + 16;
  label.y = y + 17;
  figma.currentPage.appendChild(label);

  var textNode = null;
  try {
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
    textNode = figma.createText();
    textNode.fontName = { family: "Inter", style: "Bold" };
    textNode.characters = agentId;
    textNode.fontSize = 10;
    textNode.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
    textNode.locked = true;
    label.appendChild(textNode);
  } catch (e) {
    try {
      await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      textNode = figma.createText();
      textNode.fontName = { family: "Inter", style: "Regular" };
      textNode.characters = agentId;
      textNode.fontSize = 10;
      textNode.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
      textNode.locked = true;
      label.appendChild(textNode);
    } catch (e2) {
      label.resize(60, 18);
    }
  }

  agentCursors[agentId] = { pointer: pointer, label: label, text: textNode, x: x, y: y };
}

function moveAgentCursorTo(agentId, x, y) {
  var cursor = agentCursors[agentId];
  if (!cursor) return;
  try {
    cursor.pointer.x = x;
    cursor.pointer.y = y;
    cursor.label.x = x + 16;
    cursor.label.y = y + 17;
    cursor.x = x;
    cursor.y = y;
  } catch (e) {}
}

async function animateAgentCursorTo(agentId, targetX, targetY, durationMs) {
  var cursor = agentCursors[agentId];
  if (!cursor) return;

  var dur = (typeof durationMs === "number") ? durationMs : 250;
  var startX = cursor.x;
  var startY = cursor.y;
  var dx = targetX - startX;
  var dy = targetY - startY;
  var dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 15) {
    moveAgentCursorTo(agentId, targetX, targetY);
    return;
  }

  var steps = Math.max(6, Math.min(14, Math.floor(dist / 20)));
  var stepDelay = Math.floor(dur / steps);

  for (var i = 1; i <= steps; i++) {
    var t = i / steps;
    var ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    moveAgentCursorTo(agentId, startX + dx * ease, startY + dy * ease);
    if (i < steps) await theatreDelay(stepDelay);
  }
}

function updateAgentCursorLabel(agentId, text) {
  var cursor = agentCursors[agentId];
  if (!cursor || !cursor.text) return;
  try { cursor.text.characters = text; } catch (e) {}
}

function removeAgentCursorNode(agentId) {
  var cursor = agentCursors[agentId];
  if (!cursor) return;
  try { cursor.pointer.remove(); } catch (e) {}
  try { cursor.label.remove(); } catch (e) {}
  delete agentCursors[agentId];
}

function removeAllAgentCursorNodes() {
  var ids = Object.keys(agentCursors);
  for (var i = 0; i < ids.length; i++) {
    removeAgentCursorNode(ids[i]);
  }
}

async function createAgentChatNote(agentId, message, x, y) {
  var color = AGENT_COLORS[agentId] || AGENT_COLORS.Builder;

  var note = figma.createFrame();
  note.name = "__agent_chat_" + agentId;
  note.locked = true;
  note.layoutMode = "VERTICAL";
  note.primaryAxisSizingMode = "AUTO";
  note.counterAxisSizingMode = "AUTO";
  note.paddingLeft = 10;
  note.paddingRight = 10;
  note.paddingTop = 6;
  note.paddingBottom = 6;
  note.itemSpacing = 2;
  note.cornerRadius = 8;
  note.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  note.strokes = [{ type: "SOLID", color: color }];
  note.strokeWeight = 1.5;
  note.effects = [{
    type: "DROP_SHADOW",
    color: { r: 0, g: 0, b: 0, a: 0.12 },
    offset: { x: 0, y: 2 },
    radius: 6,
    visible: true,
    blendMode: "NORMAL",
    spread: 0,
  }];
  note.x = x;
  note.y = y;

  try {
    await figma.loadFontAsync({ family: "Inter", style: "Bold" });
    await figma.loadFontAsync({ family: "Inter", style: "Regular" });

    var nameText = figma.createText();
    nameText.fontName = { family: "Inter", style: "Bold" };
    nameText.characters = agentId;
    nameText.fontSize = 10;
    nameText.fills = [{ type: "SOLID", color: color }];
    nameText.locked = true;
    note.appendChild(nameText);

    var msgText = figma.createText();
    msgText.fontName = { family: "Inter", style: "Regular" };
    msgText.characters = message;
    msgText.fontSize = 10;
    msgText.fills = [{ type: "SOLID", color: { r: 0.3, g: 0.3, b: 0.3 } }];
    msgText.locked = true;
    note.appendChild(msgText);
  } catch (e) {
    note.resize(140, 36);
  }

  figma.currentPage.appendChild(note);
  return note.id;
}

function cleanupAgentChatNotes() {
  try {
    var notes = figma.currentPage.findAll(function(n) {
      return n.name && n.name.indexOf("__agent_chat_") === 0;
    });
    for (var i = 0; i < notes.length; i++) {
      try { notes[i].remove(); } catch (e) {}
    }
  } catch (e) {}
}

// ─── End Multi-Agent Cursor System ───────────────────────────────────────────

async function normalizeVariableValue(resolvedType, value) {
  if (value === undefined || value === null) return value;

  if (
    typeof value === "object" &&
    value &&
    value.type === "VARIABLE_ALIAS" &&
    typeof value.variableId === "string"
  ) {
    if (!figma.variables || !figma.variables.getVariableByIdAsync || !figma.variables.createVariableAlias) {
      throw new Error("Variable aliasing is unavailable in this plugin runtime");
    }
    const aliasTarget = await figma.variables.getVariableByIdAsync(value.variableId);
    if (!aliasTarget) {
      throw new Error("Alias target variable not found: " + value.variableId);
    }
    return figma.variables.createVariableAlias(aliasTarget);
  }

  if (resolvedType === "COLOR") {
    if (typeof value === "string") {
      var hex = value.trim().replace(/^#/, "");
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16) / 255,
          g: parseInt(hex.slice(2, 4), 16) / 255,
          b: parseInt(hex.slice(4, 6), 16) / 255,
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
      }
    }
    if (
      typeof value === "object" &&
      typeof value.r === "number" &&
      typeof value.g === "number" &&
      typeof value.b === "number"
    ) {
      return {
        r: value.r,
        g: value.g,
        b: value.b,
        a: typeof value.a === "number" ? value.a : 1,
      };
    }
    throw new Error("Invalid COLOR value: expected #RRGGBB, #RRGGBBAA, or {r,g,b,a}");
  }

  if (resolvedType === "FLOAT") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") {
      var parsed = Number(value);
      if (!Number.isNaN(parsed)) return parsed;
    }
    throw new Error("Invalid FLOAT value: expected number");
  }

  if (resolvedType === "BOOLEAN") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("Invalid BOOLEAN value: expected true/false");
  }

  if (resolvedType === "STRING") {
    return String(value);
  }

  return value;
}

// ─── Handle messages from the UI (which receives them from the WebSocket) ────

figma.ui.onmessage = async (msg) => {
  if (msg.type === "resize-ui") {
    var width = typeof msg.width === "number" ? Math.max(280, Math.round(msg.width)) : UI_WIDTH;
    var height = typeof msg.height === "number"
      ? Math.max(UI_MIN_HEIGHT, Math.min(UI_MAX_HEIGHT, Math.round(msg.height)))
      : UI_HEIGHT;
    UI_WIDTH = width;
    UI_HEIGHT = height;
    figma.ui.resize(UI_WIDTH, UI_HEIGHT);
    return;
  }

  // Handle agent cursor commands from UI
  if (msg.type === "agent-command") {
    if (msg.command === "cleanup") {
      removeAllAgentCursorNodes();
      cleanupOrphanedCursors();
    }
    return;
  }

  // Handle relay start request from UI
  if (msg.type === "open-relay-terminal") {
    figma.notify("Run in terminal: npx figma-intelligence@latest start", { timeout: 8000 });
    return;
  }

  // Open OAuth URL in browser
  if (msg.type === "open-external" && msg.url) {
    figma.openExternal(msg.url);
    return;
  }

  // msg: { type: "bridge-request", id: string, method: string, params: object }
  if (msg.type !== "bridge-request") return;

  const { id, method, params } = msg;

  // Activate agent cursor for this operation (errors must not block the real work)
  try { if (!THEATRE_SKIP_METHODS[method]) await activateAgentForOperation(method, params); } catch (e) {}

  try {
    let result;

    switch (method) {

      // ── Core: execute arbitrary plugin code ────────────────────────────
      case "execute": {
        // params.code is a string of Figma Plugin API code
        // We wrap it in an async function so `return` works
        const normalizedCode = normalizeExecuteCode(params.code);
        const fn = new Function("figma", `return (async () => { ${normalizedCode} })();`);
        result = await fn(figma);
        break;
      }

      // ── Convenience: get node by ID ────────────────────────────────────
      case "getNode": {
        const node = await figma.getNodeByIdAsync(params.nodeId);
        if (!node) throw new Error("Node not found: " + params.nodeId);
        result = serializeNode(node);
        break;
      }

      // ── Convenience: take screenshot ───────────────────────────────────
      case "screenshot": {
        const node = await figma.getNodeByIdAsync(params.nodeId);
        if (!node) throw new Error("Node not found: " + params.nodeId);
        if (!('exportAsync' in node)) throw new Error('Node does not support export');
        const bytes = await node.exportAsync({
          format: "PNG",
          constraint: { type: "SCALE", value: params.scale || 2 },
        });
        // Send bytes as Uint8Array; UI layer will convert to base64
        figma.ui.postMessage({
          type: "bridge-response",
          id,
          resultBytes: Array.from(bytes),
        });
        return; // early return — we sent the response directly
      }

      // ── Convenience: import image from a data URI and return image hash ──
      case "importImage": {
        if (typeof params.imageDataUri !== "string" || !params.imageDataUri.startsWith("data:image")) {
          throw new Error("importImage requires imageDataUri");
        }
        const response = await fetch(params.imageDataUri);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const image = figma.createImage(bytes);
        result = {
          imageHash: image.hash,
          byteLength: bytes.length,
        };
        break;
      }

      // ── Convenience: list pages ────────────────────────────────────────
      case "getPages": {
        result = figma.root.children.map((p) => ({
          id: p.id,
          name: p.name,
        }));
        break;
      }

      // ── Convenience: list component sets ───────────────────────────────
      case "getComponentSets": {
        var sets = figma.currentPage.findAll(function(n) { return n.type === "COMPONENT_SET"; });
        result = sets.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description || "",
          children: s.children.map((c) => ({
            id: c.id,
            name: c.name,
            type: c.type,
          })),
        }));
        break;
      }

      // ── Convenience: get tokens / variables ────────────────────────────
      case "getTokens": {
        const collections = await figma.variables.getLocalVariableCollectionsAsync();
        const filtered = params.collectionId
          ? collections.filter((c) => c.id === params.collectionId)
          : collections;
        const tokens = [];
        for (const col of filtered) {
          for (const varId of col.variableIds) {
            const v = await figma.variables.getVariableByIdAsync(varId);
            if (!v) continue;
            const modeValues = {};
            for (const [modeId, val] of Object.entries(v.valuesByMode)) {
              const mode = col.modes.find((m) => m.modeId === modeId);
              modeValues[mode ? mode.name : modeId] = val;
            }
            var firstVal = Object.values(modeValues)[0];
            tokens.push({
              id: v.id,
              name: v.name,
              type: v.resolvedType,
              value: firstVal !== undefined ? firstVal : null,
              collectionId: col.id,
              modeValues,
              description: v.description || "",
            });
          }
        }
        result = tokens;
        break;
      }

      // ── Ping / health check ────────────────────────────────────────────
      case "ping": {
        result = {
          status: "ok",
          fileName: figma.root.name,
          pageCount: figma.root.children.length,
          timestamp: Date.now(),
        };
        break;
      }

      // ── Navigation & Status ─────────────────────────────────────────────
      case "getStatus": {
        var connStatus = "connected";
        var currentPage = figma.currentPage;
        result = {
          status: connStatus,
          fileName: figma.root.name,
          currentPage: { id: currentPage.id, name: currentPage.name },
          pageCount: figma.root.children.length,
          timestamp: Date.now(),
        };
        break;
      }

      case "getCapabilities": {
        result = getBridgeCapabilities();
        break;
      }

      case "navigate": {
        if (params.nodeId) {
          var navNode = await figma.getNodeByIdAsync(params.nodeId);
          if (navNode) figma.viewport.scrollAndZoomIntoView([navNode]);
          result = { navigated: true, nodeId: params.nodeId };
        } else {
          result = { navigated: false, error: "No nodeId provided" };
        }
        break;
      }

      case "getSelection": {
        var sel = figma.currentPage.selection;
        result = sel.map(function(n) {
          return { id: n.id, name: n.name, type: n.type };
        });
        break;
      }

      // ── Variable CRUD ──────────────────────────────────────────────────
      case "createVariableCollection": {
        var col = figma.variables.createVariableCollection(params.name);
        if (params.initialModeName && col.modes.length > 0) {
          col.renameMode(col.modes[0].modeId, params.initialModeName);
        }
        result = {
          id: col.id,
          name: col.name,
          modes: col.modes.map(function(m) { return { modeId: m.modeId, name: m.name }; }),
        };
        break;
      }

      case "createVariable": {
        var targetCollection = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
        if (!targetCollection) throw new Error("Collection not found: " + params.collectionId);
        var newVar = figma.variables.createVariable(
          params.name,
          targetCollection,
          params.resolvedType
        );
        if (params.description) newVar.description = params.description;
        if (params.valuesByMode) {
          var entries = Object.entries(params.valuesByMode);
          for (var vi = 0; vi < entries.length; vi++) {
            newVar.setValueForMode(entries[vi][0], await normalizeVariableValue(params.resolvedType, entries[vi][1]));
          }
        }
        result = { id: newVar.id, name: newVar.name, resolvedType: newVar.resolvedType };
        break;
      }

      case "updateVariable": {
        var updVar = await figma.variables.getVariableByIdAsync(params.variableId);
        if (!updVar) throw new Error("Variable not found: " + params.variableId);
        updVar.setValueForMode(params.modeId, await normalizeVariableValue(updVar.resolvedType, params.value));
        result = { id: updVar.id, name: updVar.name, updated: true };
        break;
      }

      case "deleteVariable": {
        var delVar = await figma.variables.getVariableByIdAsync(params.variableId);
        if (!delVar) throw new Error("Variable not found: " + params.variableId);
        delVar.remove();
        result = { deleted: true, variableId: params.variableId };
        break;
      }

      case "renameVariable": {
        var renVar = await figma.variables.getVariableByIdAsync(params.variableId);
        if (!renVar) throw new Error("Variable not found: " + params.variableId);
        renVar.name = params.newName;
        result = { id: renVar.id, name: renVar.name, renamed: true };
        break;
      }

      case "deleteVariableCollection": {
        var delCol = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
        if (!delCol) throw new Error("Collection not found: " + params.collectionId);
        delCol.remove();
        result = { deleted: true, collectionId: params.collectionId };
        break;
      }

      case "addMode": {
        var modeCol = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
        if (!modeCol) throw new Error("Collection not found: " + params.collectionId);
        var newMode = modeCol.addMode(params.modeName);
        result = { collectionId: params.collectionId, modeId: newMode, modeName: params.modeName };
        break;
      }

      case "renameMode": {
        var rmCol = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
        if (!rmCol) throw new Error("Collection not found: " + params.collectionId);
        rmCol.renameMode(params.modeId, params.newName);
        result = { collectionId: params.collectionId, modeId: params.modeId, newName: params.newName };
        break;
      }

      case "batchCreateVariables": {
        var batchResults = [];
        for (var bi = 0; bi < params.variables.length; bi++) {
          var spec = params.variables[bi];
          var batchCollection = await figma.variables.getVariableCollectionByIdAsync(spec.collectionId);
          if (!batchCollection) throw new Error("Collection not found: " + spec.collectionId);
          var bVar = figma.variables.createVariable(spec.name, batchCollection, spec.resolvedType);
          if (spec.description) bVar.description = spec.description;
          if (spec.valuesByMode) {
            var bEntries = Object.entries(spec.valuesByMode);
            for (var bj = 0; bj < bEntries.length; bj++) {
              bVar.setValueForMode(bEntries[bj][0], await normalizeVariableValue(spec.resolvedType, bEntries[bj][1]));
            }
          }
          batchResults.push({ id: bVar.id, name: bVar.name, resolvedType: bVar.resolvedType });
        }
        result = { created: batchResults.length, variables: batchResults };
        break;
      }

      case "batchUpdateVariables": {
        var batchUpdated = 0;
        for (var ui = 0; ui < params.updates.length; ui++) {
          var upd = params.updates[ui];
          var buVar = await figma.variables.getVariableByIdAsync(upd.variableId);
          if (buVar) {
            buVar.setValueForMode(upd.modeId, await normalizeVariableValue(buVar.resolvedType, upd.value));
            batchUpdated++;
          }
        }
        result = { updated: batchUpdated, total: params.updates.length };
        break;
      }

      // ── Node Operations ────────────────────────────────────────────────
      case "cloneNode": {
        var srcNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!srcNode) throw new Error("Node not found: " + params.nodeId);
        var cloned = srcNode.clone();
        if (params.x !== undefined) cloned.x = params.x;
        if (params.y !== undefined) cloned.y = params.y;
        result = { id: cloned.id, name: cloned.name, type: cloned.type };
        break;
      }

      case "deleteNode": {
        var delNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!delNode) throw new Error("Node not found: " + params.nodeId);
        delNode.remove();
        result = { deleted: true, nodeId: params.nodeId };
        break;
      }

      case "moveNode": {
        var mvNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!mvNode) throw new Error("Node not found: " + params.nodeId);
        if (params.x !== undefined) mvNode.x = params.x;
        if (params.y !== undefined) mvNode.y = params.y;
        if (params.parentId) {
          var newParent = await figma.getNodeByIdAsync(params.parentId);
          if (newParent && "appendChild" in newParent) {
            newParent.appendChild(mvNode);
          }
        }
        result = { id: mvNode.id, x: mvNode.x, y: mvNode.y };
        break;
      }

      case "resizeNode": {
        var rsNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!rsNode) throw new Error("Node not found: " + params.nodeId);
        if ("resize" in rsNode) {
          rsNode.resize(params.width, params.height);
        }
        result = { id: rsNode.id, width: params.width, height: params.height };
        break;
      }

      case "renameNode": {
        var rnNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!rnNode) throw new Error("Node not found: " + params.nodeId);
        rnNode.name = params.newName;
        result = { id: rnNode.id, name: rnNode.name };
        break;
      }

      case "setFills": {
        var fillNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!fillNode) throw new Error("Node not found: " + params.nodeId);
        if ("fills" in fillNode) {
          fillNode.fills = params.fills;
        }
        result = { id: fillNode.id, fills: params.fills };
        break;
      }

      case "setStrokes": {
        var strokeNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!strokeNode) throw new Error("Node not found: " + params.nodeId);
        if ("strokes" in strokeNode) {
          strokeNode.strokes = params.strokes;
          if (params.strokeWeight !== undefined) strokeNode.strokeWeight = params.strokeWeight;
        }
        result = { id: strokeNode.id, strokes: params.strokes };
        break;
      }

      case "setText": {
        var textNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!textNode) throw new Error("Node not found: " + params.nodeId);
        if (textNode.type !== "TEXT") throw new Error("Node is not a text node");
        await figma.loadFontAsync(textNode.fontName);
        textNode.characters = params.characters;
        if (params.fontSize) textNode.fontSize = params.fontSize;
        result = { id: textNode.id, characters: textNode.characters };
        break;
      }

      // ── Component Operations ───────────────────────────────────────────
      case "searchComponents": {
        var query = (params.query || "").toLowerCase();
        var limit = params.limit || 20;
        var allComponents = figma.currentPage.findAll(function(n) {
          return n.type === "COMPONENT" || n.type === "COMPONENT_SET";
        });
        var matched = [];
        for (var ci = 0; ci < allComponents.length; ci++) {
          if (allComponents[ci].name.toLowerCase().indexOf(query) !== -1) {
            matched.push({
              id: allComponents[ci].id,
              name: allComponents[ci].name,
              type: allComponents[ci].type,
              description: allComponents[ci].description || "",
            });
          }
          if (matched.length >= limit) break;
        }
        result = matched;
        break;
      }

      case "instantiateComponent": {
        var comp = null;
        if (params.nodeId) {
          comp = await figma.getNodeByIdAsync(params.nodeId);
        }
        if (!comp) throw new Error("Component not found");
        if (comp.type === "COMPONENT_SET") {
          // Find matching variant
          var targetVariant = null;
          if (params.variant) {
            var variantStr = Object.entries(params.variant).map(function(e) {
              return e[0] + "=" + e[1];
            }).join(", ");
            for (var vi2 = 0; vi2 < comp.children.length; vi2++) {
              if (comp.children[vi2].name === variantStr) {
                targetVariant = comp.children[vi2];
                break;
              }
            }
          }
          if (!targetVariant) targetVariant = comp.children[0];
          comp = targetVariant;
        }
        if (comp.type !== "COMPONENT") throw new Error("Node is not a component: " + comp.type);
        var instance = comp.createInstance();
        if (params.x !== undefined) instance.x = params.x;
        if (params.y !== undefined) instance.y = params.y;
        if (params.parentId) {
          var instParent = await figma.getNodeByIdAsync(params.parentId);
          if (instParent && "appendChild" in instParent) {
            instParent.appendChild(instance);
          }
        }
        result = { id: instance.id, name: instance.name, type: instance.type, componentId: comp.id };
        break;
      }

      case "setDescription": {
        var descNode = await figma.getNodeByIdAsync(params.nodeId);
        if (!descNode) throw new Error("Node not found: " + params.nodeId);
        if ("description" in descNode) {
          descNode.description = params.description;
        }
        result = { id: descNode.id, description: params.description };
        break;
      }

      case "getVariables": {
        if (!figma.variables || !figma.variables.getLocalVariableCollectionsAsync) {
          throw new Error("Variables API unavailable in this plugin runtime");
        }
        var verbosity = params.verbosity || "summary";
        var gvCollections = await figma.variables.getLocalVariableCollectionsAsync();
        if (params.collectionId) {
          gvCollections = gvCollections.filter(function(c) { return c.id === params.collectionId; });
        }
        var gvResult = [];
        for (var gci = 0; gci < gvCollections.length; gci++) {
          var gCol = gvCollections[gci];
          var gVars = [];
          for (var gvi = 0; gvi < gCol.variableIds.length; gvi++) {
            var gv = await figma.variables.getVariableByIdAsync(gCol.variableIds[gvi]);
            if (!gv) continue;
            var gvEntry = { id: gv.id, name: gv.name, type: gv.resolvedType };
            if (verbosity !== "inventory") {
              var gvModes = {};
              var gvModeEntries = Object.entries(gv.valuesByMode);
              for (var gmi = 0; gmi < gvModeEntries.length; gmi++) {
                var mode = gCol.modes.find(function(m) { return m.modeId === gvModeEntries[gmi][0]; });
                gvModes[mode ? mode.name : gvModeEntries[gmi][0]] = gvModeEntries[gmi][1];
              }
              gvEntry.valuesByMode = gvModes;
              if (verbosity === "full") {
                gvEntry.description = gv.description || "";
                gvEntry.collectionId = gCol.id;
                gvEntry.collectionName = gCol.name;
              }
            }
            gVars.push(gvEntry);
          }
          gvResult.push({
            id: gCol.id,
            name: gCol.name,
            modes: gCol.modes.map(function(m) { return { modeId: m.modeId, name: m.name }; }),
            variables: gVars,
          });
        }
        result = gvResult;
        break;
      }

      case "getStyles": {
        if (!figma.getLocalPaintStylesAsync || !figma.getLocalTextStylesAsync || !figma.getLocalEffectStylesAsync) {
          throw new Error("Local styles APIs unavailable in this plugin runtime");
        }
        var paintStyles = await figma.getLocalPaintStylesAsync();
        var textStyles = await figma.getLocalTextStylesAsync();
        var effectStyles = await figma.getLocalEffectStylesAsync();
        result = {
          paint: paintStyles.map(function(s) {
            return { id: s.id, name: s.name, paints: s.paints, description: s.description || "" };
          }),
          text: textStyles.map(function(s) {
            return {
              id: s.id, name: s.name,
              fontName: s.fontName, fontSize: s.fontSize,
              lineHeight: s.lineHeight, letterSpacing: s.letterSpacing,
              description: s.description || "",
            };
          }),
          effect: effectStyles.map(function(s) {
            return { id: s.id, name: s.name, effects: s.effects, description: s.description || "" };
          }),
        };
        break;
      }

      case "createChild": {
        var parentNode = params.parentId
          ? await figma.getNodeByIdAsync(params.parentId)
          : figma.currentPage;
        if (!parentNode || !("appendChild" in parentNode))
          throw new Error("Invalid parent node");
        var child;
        switch (params.childType) {
          case "FRAME":
            child = figma.createFrame();
            break;
          case "TEXT":
            child = figma.createText();
            await figma.loadFontAsync({ family: "Inter", style: "Regular" });
            if (params.characters) child.characters = params.characters;
            break;
          case "RECTANGLE":
            child = figma.createRectangle();
            break;
          case "ELLIPSE":
            child = figma.createEllipse();
            break;
          case "LINE":
            child = figma.createLine();
            break;
          case "COMPONENT":
            child = figma.createComponent();
            break;
          case "SECTION":
            child = figma.createSection();
            break;
          default:
            child = figma.createFrame();
        }
        if (params.name) child.name = params.name;
        if (params.width && params.height && "resize" in child) child.resize(params.width, params.height);
        if (params.x !== undefined) child.x = params.x;
        if (params.y !== undefined) child.y = params.y;
        parentNode.appendChild(child);
        result = { id: child.id, name: child.name, type: child.type };
        break;
      }

      case "cleanupAgentCursors": {
        removeAllAgentCursorNodes();
        cleanupAgentChatNotes();
        cleanupOrphanedCursors();
        result = { cleaned: true };
        break;
      }

      // ── Swarm Agent Cursor Operations ─────────────────────────────────
      case "spawnAgentCursor": {
        await createAgentCursorNode(params.agentId, params.x || 0, params.y || 0);
        result = { agentId: params.agentId, spawned: true };
        break;
      }

      case "moveAgentCursor": {
        if (params.animate) {
          await animateAgentCursorTo(params.agentId, params.x, params.y, params.durationMs);
        } else {
          moveAgentCursorTo(params.agentId, params.x, params.y);
        }
        result = { agentId: params.agentId, x: params.x, y: params.y };
        break;
      }

      case "updateAgentLabel": {
        updateAgentCursorLabel(params.agentId, params.label);
        result = { agentId: params.agentId, label: params.label };
        break;
      }

      case "removeAgentCursor": {
        removeAgentCursorNode(params.agentId);
        result = { agentId: params.agentId, removed: true };
        break;
      }

      case "agentChat": {
        var noteId = await createAgentChatNote(params.agentId, params.message, params.x || 0, params.y || 0);
        result = { agentId: params.agentId, noteId: noteId };
        break;
      }

      case "cleanupAgentChats": {
        cleanupAgentChatNotes();
        result = { cleaned: true };
        break;
      }

      default:
        throw new Error(`Unknown bridge method: ${method}`);
    }

    // Post-operation: cursor inspects the result (visual operations only)
    try { if (!THEATRE_SKIP_METHODS[method]) await postOperationEffect(method, params, result); } catch (e) {}

    figma.ui.postMessage({ type: "bridge-response", id, result });
  } catch (err) {
    figma.ui.postMessage({
      type: "bridge-response",
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function serializeNode(node) {
  const base = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  if ("x" in node) {
    Object.assign(base, {
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    });
  }
  if ("fills" in node) base.fills = node.fills;
  if ("strokes" in node) base.strokes = node.strokes;
  if ("effects" in node) base.effects = node.effects;
  if ("opacity" in node) base.opacity = node.opacity;
  if ("cornerRadius" in node) base.cornerRadius = node.cornerRadius;
  if ("layoutMode" in node) {
    Object.assign(base, {
      layoutMode: node.layoutMode,
      primaryAxisSizingMode: node.primaryAxisSizingMode,
      counterAxisSizingMode: node.counterAxisSizingMode,
      paddingTop: node.paddingTop,
      paddingBottom: node.paddingBottom,
      paddingLeft: node.paddingLeft,
      paddingRight: node.paddingRight,
      itemSpacing: node.itemSpacing,
    });
  }
  if ("characters" in node) {
    Object.assign(base, {
      characters: node.characters,
      fontSize: node.fontSize,
      fontName: node.fontName,
      lineHeight: node.lineHeight,
      letterSpacing: node.letterSpacing,
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
    });
  }
  if ("children" in node) {
    base.childCount = node.children.length;
    base.children = node.children.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
    }));
  }
  if ("mainComponent" in node) {
    base.mainComponentId = node.mainComponent ? node.mainComponent.id : undefined;
    base.mainComponentName = node.mainComponent ? node.mainComponent.name : undefined;
  }

  return base;
}

// Keep plugin running
figma.on("close", () => {
  removeAllAgentCursorNodes();
  cleanupOrphanedCursors();
});

console.log("✅ Figma Intelligence Bridge Plugin loaded");
