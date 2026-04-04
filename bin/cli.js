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

const command = process.argv[2] || "help";
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

async function main() {
  switch (command) {
    case "setup": {
      const { runSetup } = require("../lib/setup");
      await runSetup();
      break;
    }

    case "start": {
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
