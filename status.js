/**
 * status.js — Health check for Figma Intelligence
 */

const https = require("https");
const http = require("http");
const { existsSync, readFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const PID_PATH = join(homedir(), ".figma-intelligence", "relay.pid");

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON")); }
      });
    }).on("error", reject).on("timeout", () => reject(new Error("Timeout")));
  });
}

async function checkStatus(config) {
  console.log("\n  Figma Intelligence — Status\n");

  // 1. Local relay
  let relayRunning = false;
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    relayRunning = pid && isProcessRunning(pid);
    console.log(`  Local relay:  ${relayRunning ? "running (PID " + pid + ")" : "not running"}`);
  } else {
    console.log("  Local relay:  not running");
  }

  // 2. Cloud server
  if (config.cloudUrl) {
    try {
      const health = await fetchJson(`${config.cloudUrl}/health`);
      console.log(`  Cloud server: online (${health.activeSessions || 0} active sessions, uptime ${health.uptime || 0}s)`);
    } catch (err) {
      console.log(`  Cloud server: unreachable (${err.message})`);
    }
  } else {
    console.log("  Cloud server: not configured");
  }

  // 3. Session token
  console.log(`  Session:      ${config.sessionToken ? config.sessionToken.slice(0, 8) + "…" : "not set"}`);
  console.log(`  Figma token:  ${config.figmaAccessToken ? config.figmaAccessToken.slice(0, 8) + "…" : "not set"}`);
  console.log();
}

module.exports = { checkStatus };
