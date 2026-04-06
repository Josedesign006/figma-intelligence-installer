#!/usr/bin/env node
/**
 * mcp-stdio-proxy.js — Bridges stdio MCP ↔ StreamableHTTP MCP
 *
 * Claude CLI (any version) spawns this as a stdio MCP server.
 * This proxy forwards JSON-RPC requests to the cloud StreamableHTTP endpoint
 * and pipes responses back over stdout.
 *
 * Usage:
 *   node mcp-stdio-proxy.js <cloud-url> <session-token>
 *
 * The proxy is stateless per-request — each JSON-RPC message is a separate
 * HTTP POST. The Mcp-Session-Id from the initialize response is cached and
 * sent on subsequent requests so the cloud server maintains session continuity.
 */

const https = require("https");
const http = require("http");
const { URL } = require("url");

const cloudUrl = process.argv[2];
const sessionToken = process.argv[3];

if (!cloudUrl || !sessionToken) {
  process.stderr.write("Usage: mcp-stdio-proxy <cloud-url> <session-token>\n");
  process.exit(1);
}

const mcpEndpoint = `${cloudUrl}/mcp?token=${sessionToken}`;
const parsedUrl = new URL(mcpEndpoint);
const transport = parsedUrl.protocol === "https:" ? https : http;

let mcpSessionId = null;

// Read newline-delimited JSON from stdin
let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      forwardRequest(request);
    } catch (e) {
      process.stderr.write(`[mcp-proxy] Invalid JSON: ${e.message}\n`);
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

function forwardRequest(request) {
  const body = JSON.stringify(request);

  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Content-Length": Buffer.byteLength(body),
  };

  if (mcpSessionId) {
    headers["Mcp-Session-Id"] = mcpSessionId;
  }

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: "POST",
    headers,
    timeout: 60000,
  };

  const req = transport.request(options, (res) => {
    let data = "";

    res.on("data", (chunk) => {
      data += chunk.toString();
    });

    res.on("end", () => {
      // Capture Mcp-Session-Id from response headers
      const newSessionId = res.headers["mcp-session-id"];
      if (newSessionId) {
        mcpSessionId = newSessionId;
      }

      // The cloud server may respond with SSE-formatted events or plain JSON
      const contentType = res.headers["content-type"] || "";

      if (contentType.includes("text/event-stream")) {
        // Parse SSE events and extract JSON data lines
        const events = data.split("\n");
        for (const eventLine of events) {
          if (eventLine.startsWith("data: ")) {
            const jsonStr = eventLine.slice(6).trim();
            if (jsonStr) {
              process.stdout.write(jsonStr + "\n");
            }
          }
        }
      } else {
        // Plain JSON response
        if (data.trim()) {
          process.stdout.write(data.trim() + "\n");
        }
      }
    });
  });

  req.on("error", (err) => {
    process.stderr.write(`[mcp-proxy] Request error: ${err.message}\n`);
    // Send JSON-RPC error response back
    const errorResponse = {
      jsonrpc: "2.0",
      error: { code: -32000, message: `Proxy error: ${err.message}` },
      id: request.id || null,
    };
    process.stdout.write(JSON.stringify(errorResponse) + "\n");
  });

  req.on("timeout", () => {
    req.destroy();
    process.stderr.write("[mcp-proxy] Request timeout\n");
    const errorResponse = {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Proxy timeout" },
      id: request.id || null,
    };
    process.stdout.write(JSON.stringify(errorResponse) + "\n");
  });

  req.write(body);
  req.end();
}
