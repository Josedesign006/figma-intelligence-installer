/**
 * start-relay.js — Start/stop the compiled relay binary as a background process.
 */

const { spawn, execSync } = require("child_process");
const { existsSync, readFileSync, writeFileSync } = require("fs");
const { join } = require("path");
const { homedir } = require("os");

const CONFIG_DIR = join(homedir(), ".figma-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PID_PATH = join(CONFIG_DIR, "relay.pid");

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error("Not set up yet. Run: figma-intelligence setup");
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0); // signal 0 = just check existence
    return true;
  } catch {
    return false;
  }
}

async function startRelay() {
  const config = loadConfig();

  // Check if already running
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
    if (pid && isProcessRunning(pid)) {
      console.log(`  Relay already running (PID ${pid})`);
      return;
    }
    // Stale PID file
  }

  const binaryPath = config.binaryPath;
  if (!binaryPath || !existsSync(binaryPath)) {
    throw new Error(
      `Relay binary not found at ${binaryPath}. Run: figma-intelligence setup`
    );
  }

  console.log("  Starting Figma Intelligence relay…");

  // Set env vars for the relay to use
  const env = {
    ...process.env,
    FIGMA_INTELLIGENCE_CLOUD_URL: config.cloudUrl,
    FIGMA_INTELLIGENCE_SESSION_TOKEN: config.sessionToken,
    FIGMA_ACCESS_TOKEN: config.figmaAccessToken || "",
  };

  const child = spawn(binaryPath, [], {
    env,
    stdio: "ignore",
    detached: true,
  });

  child.unref();
  writeFileSync(PID_PATH, String(child.pid));

  console.log(`  Relay started (PID ${child.pid})`);
  console.log(`  Local relay: ws://localhost:9001`);
  console.log(`  Cloud tunnel: ${config.cloudUrl}/tunnel`);
  console.log("\n  Open Figma Desktop and load the Intelligence Bridge plugin.");
}

async function stopRelay() {
  if (!existsSync(PID_PATH)) {
    console.log("  Relay is not running.");
    return;
  }

  const pid = parseInt(readFileSync(PID_PATH, "utf8").trim(), 10);
  if (!pid) {
    console.log("  Invalid PID file.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`  Relay stopped (PID ${pid})`);
  } catch (err) {
    if (err.code === "ESRCH") {
      console.log("  Relay was not running (stale PID).");
    } else {
      throw err;
    }
  }

  // Clean up PID file
  try {
    require("fs").unlinkSync(PID_PATH);
  } catch {}
}

module.exports = { startRelay, stopRelay };
