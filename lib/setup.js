/**
 * setup.js — First-time setup for Figma Intelligence
 *
 * 1. Generate session token
 * 2. Download platform binary from GitHub Releases
 * 3. Detect installed AI tools
 * 4. Register cloud MCP server URL in each tool's config
 * 5. Prompt for Figma access token
 * 6. Save config
 */

const { randomUUID } = require("crypto");
const { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } = require("fs");
const { join } = require("path");
const { homedir, platform, arch } = require("os");
const { createInterface } = require("readline");
const { downloadBinary } = require("./download-binary");

const CONFIG_DIR = join(homedir(), ".figma-intelligence");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const BIN_DIR = join(CONFIG_DIR, "bin");
const PLUGIN_DIR = join(CONFIG_DIR, "plugin");

// ── UPDATE THIS after Railway deployment ──
const DEFAULT_CLOUD_URL = "https://figma-intelligence-server-production.up.railway.app";

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function runSetup() {
  console.log("\n  Figma Intelligence — Setup\n");

  // 1. Create config directory
  mkdirSync(CONFIG_DIR, { recursive: true });
  mkdirSync(BIN_DIR, { recursive: true });

  // 2. Load existing config or create new
  let config = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      console.log("  Found existing config, updating…\n");
    } catch {}
  }

  // 3. Generate session token (or keep existing)
  if (!config.sessionToken) {
    config.sessionToken = randomUUID();
    console.log(`  Generated session token: ${config.sessionToken.slice(0, 8)}…`);
  } else {
    console.log(`  Using existing session token: ${config.sessionToken.slice(0, 8)}…`);
  }

  // 4. Cloud URL
  config.cloudUrl = config.cloudUrl || DEFAULT_CLOUD_URL;
  const customUrl = await ask(`  Cloud server URL [${config.cloudUrl}]: `);
  if (customUrl) config.cloudUrl = customUrl;

  // 5. Figma access token
  if (!config.figmaAccessToken) {
    console.log("\n  You need a Figma Personal Access Token.");
    console.log("  Get one at: https://www.figma.com/developers/api#access-tokens\n");
    const token = await ask("  Figma Access Token: ");
    if (token) {
      config.figmaAccessToken = token;
    } else {
      console.log("  Skipping — you can add this later in ~/.figma-intelligence/config.json");
    }
  } else {
    console.log(`  Figma token: ${config.figmaAccessToken.slice(0, 8)}… (already set)`);
  }

  // 6. Download binary
  console.log("\n  Downloading relay binary…");
  try {
    const binaryPath = await downloadBinary(BIN_DIR);
    config.binaryPath = binaryPath;
    chmodSync(binaryPath, 0o755);
    console.log(`  Binary saved to: ${binaryPath}`);
  } catch (err) {
    console.log(`  Warning: Could not download binary (${err.message})`);
    console.log("  You can run the relay from source instead with: npm start");
  }

  // 7. Install Figma plugin files
  console.log("\n  Installing Figma plugin…");
  try {
    mkdirSync(PLUGIN_DIR, { recursive: true });
    const pluginSrc = join(__dirname, "..", "plugin");
    const pluginFiles = ["manifest.json", "code.js", "ui.html"];
    for (const file of pluginFiles) {
      const src = join(pluginSrc, file);
      if (existsSync(src)) {
        copyFileSync(src, join(PLUGIN_DIR, file));
      }
    }
    console.log(`  Plugin installed to: ${PLUGIN_DIR}`);
  } catch (err) {
    console.log(`  Warning: Could not install plugin (${err.message})`);
  }

  // 8. Save config
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  console.log(`\n  Config saved to: ${CONFIG_PATH}`);

  // 9. Register MCP server in AI tool configs
  console.log("\n  Registering MCP server with AI tools…\n");
  registerMcpServer(config);

  console.log("\n  Setup complete!\n");
  console.log("  Next steps:");
  console.log("    1. Run: npx figma-intelligence start");
  console.log("    2. Open Figma Desktop and open any design file");
  console.log("    3. In Figma: Plugins > Development > Import plugin from manifest");
  console.log(`       Select: ${PLUGIN_DIR}/manifest.json`);
  console.log("    4. Run the plugin — you should see 'Connected' in the plugin UI");
  console.log("    5. Open Claude Desktop / Cursor / VS Code — your MCP tools are ready\n");
}

function registerMcpServer(config) {
  const mcpUrl = `${config.cloudUrl}/mcp`;

  // ── Claude Desktop / Claude Code ──
  registerClaude(config, mcpUrl);

  // ── Cursor ──
  registerCursor(config, mcpUrl);

  // ── VS Code ──
  registerVSCode(config, mcpUrl);
}

function registerClaude(config, mcpUrl) {
  // Claude Code uses ~/.claude.json for MCP servers
  const claudeConfigPath = join(homedir(), ".claude.json");
  try {
    let claudeConfig = {};
    if (existsSync(claudeConfigPath)) {
      claudeConfig = JSON.parse(readFileSync(claudeConfigPath, "utf8"));
    }

    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
    claudeConfig.mcpServers["figma-intelligence"] = {
      type: "http",
      url: mcpUrl,
      headers: {
        "X-Session-Token": config.sessionToken,
      },
    };

    writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
    console.log("    Claude: registered");
  } catch (err) {
    console.log(`    Claude: skipped (${err.message})`);
  }
}

function registerCursor(config, mcpUrl) {
  const cursorConfigPath = join(homedir(), ".cursor", "mcp.json");
  try {
    let cursorConfig = {};
    if (existsSync(cursorConfigPath)) {
      cursorConfig = JSON.parse(readFileSync(cursorConfigPath, "utf8"));
    }

    if (!cursorConfig.mcpServers) cursorConfig.mcpServers = {};
    cursorConfig.mcpServers["figma-intelligence"] = {
      url: mcpUrl,
      headers: {
        "X-Session-Token": config.sessionToken,
      },
    };

    mkdirSync(join(homedir(), ".cursor"), { recursive: true });
    writeFileSync(cursorConfigPath, JSON.stringify(cursorConfig, null, 2));
    console.log("    Cursor: registered");
  } catch (err) {
    console.log(`    Cursor: skipped (${err.message})`);
  }
}

function registerVSCode(config, mcpUrl) {
  // VS Code MCP config location varies; use the common pattern
  const vscodeConfigDir = join(homedir(), ".vscode");
  const vscodeConfigPath = join(vscodeConfigDir, "mcp.json");
  try {
    let vscodeConfig = {};
    if (existsSync(vscodeConfigPath)) {
      vscodeConfig = JSON.parse(readFileSync(vscodeConfigPath, "utf8"));
    }

    if (!vscodeConfig.servers) vscodeConfig.servers = {};
    vscodeConfig.servers["figma-intelligence"] = {
      type: "http",
      url: mcpUrl,
      headers: {
        "X-Session-Token": config.sessionToken,
      },
    };

    mkdirSync(vscodeConfigDir, { recursive: true });
    writeFileSync(vscodeConfigPath, JSON.stringify(vscodeConfig, null, 2));
    console.log("    VS Code: registered");
  } catch (err) {
    console.log(`    VS Code: skipped (${err.message})`);
  }
}

module.exports = { runSetup };
