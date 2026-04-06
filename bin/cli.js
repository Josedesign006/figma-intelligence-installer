#!/usr/bin/env node
/**
 * figma-intelligence CLI
 *
 * Commands:
 *   setup   — First-time setup: download binary, generate token, register MCP
 *   start   — Start the local relay (connects to cloud)
 *   stop    — Stop the local relay
 *   status  — Health check
 */

const { join } = require("path");
const { homedir } = require("os");
const { existsSync, readFileSync } = require("fs");
const { execSync } = require("child_process");

const command = process.argv[2] || "help";
const CURRENT_VERSION = require("../package.json").version;
const CONFIG_DIR = join(homedir(), ".figma-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

function loadConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    }
  } catch {}
  return null;
}

/**
 * Check npm for the latest version. If we're outdated, re-exec with @latest.
 * Returns true if we re-launched (caller should exit), false to continue.
 */
function autoUpdate() {
  try {
    console.log(`\n  Current version: ${CURRENT_VERSION}`);
    console.log("  Checking for updates…");
    const latest = execSync("npm view figma-intelligence version", {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (latest && latest !== CURRENT_VERSION) {
      console.log(`  Update available: ${CURRENT_VERSION} → ${latest}`);
      console.log("  Downloading latest version…\n");
      execSync(`npx figma-intelligence@latest ${command}`, {
        stdio: "inherit",
        timeout: 120000,
      });
      return true; // we re-launched, caller should exit
    }
    console.log(`  Already on latest (${CURRENT_VERSION})\n`);
  } catch (err) {
    // Network error or timeout — continue with current version
    console.log(`  Could not check for updates — continuing with v${CURRENT_VERSION}\n`);
  }
  return false;
}

async function main() {
  switch (command) {
    case "setup": {
      if (autoUpdate()) return; // re-launched with latest, done
      const { runSetup } = require("../lib/setup");
      await runSetup();
      break;
    }

    case "start": {
      if (autoUpdate()) return; // re-launched with latest, done
      const { startRelay } = require("../lib/start-relay");
      await startRelay();
      break;
    }

    case "stop": {
      const { stopRelay } = require("../lib/start-relay");
      await stopRelay();
      break;
    }

    case "status": {
      const config = loadConfig();
      if (!config) {
        console.log("Not set up yet. Run: figma-intelligence setup");
        process.exit(1);
      }

      const { checkStatus } = require("../lib/status");
      await checkStatus(config);
      break;
    }

    case "help":
    default:
      console.log(`
  figma-intelligence — AI-powered design tools for Figma

  Commands:
    setup    First-time setup (download, configure, register)
    start    Start the local relay
    stop     Stop the local relay
    status   Check connection status

  Usage:
    npx figma-intelligence setup
    npx figma-intelligence start
`);
      break;
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
