#!/usr/bin/env node
/**
 * Build a portable distribution zip of codex-responses-adapter.
 *
 * Steps:
 *   1. Run a clean build (`npm run build`) so dist/ is fresh.
 *   2. Collect every file the runtime needs:
 *        - dist/                       (compiled JS + admin static)
 *        - scripts/start.mjs           (one-click launcher)
 *        - scripts/copy-static.mjs     (used by `npm run build`)
 *        - start.bat / start.sh        (platform entry points)
 *        - package.json + package-lock.json
 *        - README.md, docs/, Dockerfile
 *      Excludes node_modules/, tests/, src/, tmp-*, .git/, log files.
 *   3. Write the zip to release/codex-responses-adapter-vX.Y.Z.zip
 *      with a top-level directory of the same name so the user gets
 *      one folder when they extract.
 *
 * Usage:
 *   npm run package
 *
 * The recipient unzips the file and double-clicks `start.bat`
 * (Windows) or runs `./start.sh` (macOS/Linux). The launcher will
 * pick up the missing `node_modules/` and run `npm install` once on
 * first launch — so the zip stays small (a few hundred KB) while the
 * UX is still "extract → double-click → done".
 */

// archiver v8 ships as native ESM and exposes the format-specific
// classes directly (ZipArchive / TarArchive / JsonArchive) rather
// than the legacy `archiver(format, options)` factory function.
// We use ZipArchive directly.
import { ZipArchive } from "archiver";

import { spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RELEASE_DIR = path.join(ROOT, "release");

// ---------- console helpers ------------------------------------------------

const useColor = process.stdout.isTTY === true;
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = (msg) => console.log(`${c("32", "✓")} ${msg}`);
const info = (msg) => console.log(`${c("36", "▸")} ${msg}`);
const fail = (msg) => console.error(`${c("31", "✗")} ${msg}`);

function header(title) {
  console.log("");
  console.log(c("1", `── ${title} ${"─".repeat(Math.max(2, 50 - title.length))}`));
}

// ---------- 1. Read version & ensure clean build ---------------------------

function readVersion() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("package.json is missing a version field");
  }
  return pkg.version;
}

function runBuild() {
  header("Building project");
  const result = spawnSync("npm", ["run", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    fail(`npm run build failed (exit ${String(result.status)})`);
    process.exit(result.status ?? 1);
  }
  ok("Build succeeded");
}

// ---------- 2. Choose what goes into the zip -------------------------------

/**
 * Files / directories included in the portable release.
 *
 * Everything is relative to the project root. Directories are zipped
 * recursively. The top-level folder inside the zip is fixed at
 * `codex-responses-adapter-v<version>` so that extraction yields a
 * single tidy folder rather than spilling files into wherever the
 * user is browsing.
 */
const INCLUDE = [
  // Compiled runtime — required.
  "dist",
  // Launcher scripts — required.
  "start.bat",
  "start.sh",
  "install-and-start.bat",
  "install-and-start.sh",
  "scripts/start.mjs",
  "scripts/copy-static.mjs",
  // npm metadata — required so `npm install` resolves the same versions.
  "package.json",
  "package-lock.json",
  // Documentation — nice to have.
  "README.md",
  "docs",
  "Dockerfile",
  ".dockerignore",
];

/**
 * Glob-ish patterns that always get stripped, even if a parent
 * directory is in the include list. Keeps the zip small and avoids
 * shipping anything provider-specific by mistake.
 */
const EXCLUDE_NAMES = new Set([
  "node_modules",
  ".git",
  ".kiro",
  ".vscode",
  "release",
  "tmp-records",
  "tmp-verify",
  "out.log",
]);

const EXCLUDE_SUFFIXES = [".log", ".tsbuildinfo"];

function shouldInclude(absPath) {
  const name = path.basename(absPath);
  if (EXCLUDE_NAMES.has(name)) return false;
  for (const suf of EXCLUDE_SUFFIXES) {
    if (name.endsWith(suf)) return false;
  }
  return true;
}

// ---------- 3. Build the zip -----------------------------------------------

async function buildZip(version) {
  header("Packaging");
  if (!existsSync(RELEASE_DIR)) mkdirSync(RELEASE_DIR, { recursive: true });

  const folder = `codex-responses-adapter-v${version}`;
  const zipPath = path.join(RELEASE_DIR, `${folder}.zip`);

  if (existsSync(zipPath)) {
    info(`Removing previous ${path.basename(zipPath)}`);
    rmSync(zipPath, { force: true });
  }

  const output = createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });

  const done = new Promise((resolve, reject) => {
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("error", reject);
    archive.on("warning", (err) => {
      if (err.code === "ENOENT") {
        info(`warning: ${err.message}`);
      } else {
        reject(err);
      }
    });
  });

  archive.pipe(output);

  // Add a top-level NOTES.txt with a one-page quickstart so the user
  // knows what to do with the extracted folder.
  archive.append(makeNotesTxt(version), { name: `${folder}/NOTES.txt` });

  for (const rel of INCLUDE) {
    const abs = path.join(ROOT, rel);
    if (!existsSync(abs)) {
      info(`skipping missing entry: ${rel}`);
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      archive.directory(abs, `${folder}/${rel}`, (entry) =>
        shouldInclude(entry.name ?? "") ? entry : false,
      );
    } else if (shouldInclude(abs)) {
      archive.file(abs, { name: `${folder}/${rel}` });
    }
  }

  await archive.finalize();
  await done;

  const size = statSync(zipPath).size;
  ok(`Wrote ${zipPath}`);
  ok(`Size: ${(size / 1024).toFixed(1)} KB`);
  return zipPath;
}

function makeNotesTxt(version) {
  return [
    `codex-responses-adapter v${version} — portable release`,
    "=".repeat(60),
    "",
    "WHAT IT IS",
    "  A local HTTP adapter that lets the OpenAI Codex CLI talk to",
    "  Chinese LLM providers (DeepSeek, Qwen, Xiaomi MiMo, Doubao,",
    "  Kimi). Runs on your machine; no data leaves until you call",
    "  the upstream provider.",
    "",
    "REQUIREMENTS",
    "  - Node.js 20 or newer  (https://nodejs.org/)",
    "",
    "FIRST RUN",
    "  Windows:        double-click  install-and-start.bat   (auto-installs Node.js if missing)",
    "                  or             start.bat              (requires Node.js 20+ already installed)",
    "  macOS / Linux:  ./install-and-start.sh                (auto-installs via brew/nvm)",
    "                  or              ./start.sh            (requires Node.js 20+ already installed)",
    "",
    "  install-and-start scripts use Chinese mirrors (npmmirror) so they work without VPN.",
    "  The first launch downloads npm dependencies once (1-2 min).",
    "  Every subsequent launch is instant.",
    "",
    "AFTER THE PANEL OPENS",
    "  http://127.0.0.1:11434/admin/  opens in your browser.",
    "  1. Click 'Providers' in the top nav.",
    "  2. Edit each provider you plan to use, paste your API key.",
    "  3. Click 'Test connection' to verify the key works.",
    "  4. Point Codex CLI at:",
    "       OPENAI_BASE_URL=http://127.0.0.1:11434/v1",
    "       OPENAI_API_KEY=<anything; the adapter ignores it when",
    "                       admin_key is unset>",
    "",
    "STOPPING",
    "  Ctrl+C in the terminal window, or just close it.",
    "",
    "DOCS",
    "  README.md            full setup and CLI reference",
    "  docs/cc-switch.md    integration with cc-switch",
    "",
  ].join("\n");
}

// ---------- main -----------------------------------------------------------

async function main() {
  console.log(c("1", "codex-responses-adapter — release packager"));
  const version = readVersion();
  info(`version: ${version}`);
  runBuild();
  const zipPath = await buildZip(version);
  console.log("");
  console.log(c("32", "Release ready:"), zipPath);
}

main().catch((err) => {
  fail(`Packaging failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
