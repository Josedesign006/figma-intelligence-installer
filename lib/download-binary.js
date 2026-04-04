/**
 * download-binary.js — Downloads the correct platform binary from GitHub Releases.
 *
 * Binary naming convention:
 *   figma-intelligence-macos-arm64
 *   figma-intelligence-macos-x64
 *   figma-intelligence-linux-x64
 *   figma-intelligence-windows-x64.exe
 */

const https = require("https");
const { createWriteStream, existsSync, unlinkSync } = require("fs");
const { join } = require("path");
const { platform, arch } = require("os");

// ── UPDATE THIS with your actual GitHub repo and release tag ──
const GITHUB_OWNER = "Josedesign006";
const GITHUB_REPO = "figma-intelligence-installer";
const RELEASE_TAG = "latest";

function getPlatformBinaryName() {
  const os = platform();
  const cpu = arch();

  if (os === "darwin" && cpu === "arm64") return "figma-intelligence-macos-arm64";
  if (os === "darwin" && cpu === "x64") return "figma-intelligence-macos-x64";
  if (os === "linux" && cpu === "x64") return "figma-intelligence-linux-x64";
  if (os === "win32" && cpu === "x64") return "figma-intelligence-windows-x64.exe";

  throw new Error(`Unsupported platform: ${os}-${cpu}. Supported: macOS (arm64/x64), Linux (x64), Windows (x64).`);
}

function getDownloadUrl(binaryName) {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/${RELEASE_TAG}/download/${binaryName}`;
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const request = (urlStr) => {
      https.get(urlStr, { headers: { "User-Agent": "figma-intelligence-installer" } }, (res) => {
        // Follow redirects (GitHub releases use 302)
        if (res.statusCode === 301 || res.statusCode === 302) {
          request(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          file.close();
          unlinkSync(destPath);
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(destPath);
        });
      }).on("error", (err) => {
        file.close();
        if (existsSync(destPath)) unlinkSync(destPath);
        reject(err);
      });
    };
    request(url);
  });
}

async function downloadBinary(destDir) {
  const binaryName = getPlatformBinaryName();
  const destPath = join(destDir, binaryName);

  // Skip if already downloaded
  if (existsSync(destPath)) {
    console.log(`  Binary already exists: ${destPath}`);
    return destPath;
  }

  const url = getDownloadUrl(binaryName);
  console.log(`  Downloading from: ${url}`);
  await download(url, destPath);
  return destPath;
}

// When run as postinstall script
if (require.main === module) {
  const { join: pathJoin } = require("path");
  const { homedir: home } = require("os");
  const { mkdirSync } = require("fs");

  const binDir = pathJoin(home(), ".figma-intelligence", "bin");
  mkdirSync(binDir, { recursive: true });

  downloadBinary(binDir)
    .then((path) => console.log(`  Binary ready: ${path}`))
    .catch((err) => {
      // Don't fail the npm install — binary can be downloaded during setup
      console.log(`  Note: Binary download deferred (${err.message}). Run 'figma-intelligence setup' to complete.`);
    });
}

module.exports = { downloadBinary, getPlatformBinaryName };
