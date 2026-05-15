#!/usr/bin/env node
/**
 * One-click launcher for codex-responses-adapter.
 *
 * What this script does in order:
 *   1. Verifies Node.js >= 20.
 *   2. Runs `npm install` if `node_modules` is missing.
 *   3. Runs `npm run build` if `dist/cli/index.js` is missing or stale.
 *   4. Creates a default config at `~/.codex-responses-adapter/config.yaml`
 *      if no config exists, pre-populated with the 5 providers we've
 *      end-to-end tested (DeepSeek, Qwen, MiMo, Doubao, Kimi). API
 *      keys are left blank so the admin panel can collect them.
 *   5. Frees the listen port if a stale process is still bound to it.
 *   6. Launches `dist/cli/index.js start` which auto-opens the admin
 *      panel in your default browser.
 *
 * The script is idempotent — safe to re-run after a code update or
 * after crashing the previous instance.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(PROJECT_ROOT, "node_modules");
const CLI_ENTRY = path.join(PROJECT_ROOT, "dist", "cli", "index.js");
const SRC_DIR = path.join(PROJECT_ROOT, "src");
const PKG_JSON = path.join(PROJECT_ROOT, "package.json");
const CONFIG_DIR = path.join(homedir(), ".codex-responses-adapter");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.yaml");

// ---------------------------------------------------------------------------
// Pretty logging helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true;
const c = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const ok = (msg) => console.log(`${c("32", "✓")} ${msg}`);
const info = (msg) => console.log(`${c("36", "▸")} ${msg}`);
const warn = (msg) => console.log(`${c("33", "!")} ${msg}`);
const fail = (msg) => console.error(`${c("31", "✗")} ${msg}`);

function header(title) {
  console.log("");
  console.log(c("1", `── ${title} ${"─".repeat(Math.max(2, 60 - title.length))}`));
}

// ---------------------------------------------------------------------------
// Step 1: Node.js version
// ---------------------------------------------------------------------------

function checkNodeVersion() {
  header("Checking Node.js");
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 20) {
    fail(
      `Node.js 20+ required, but found v${process.versions.node}. ` +
        `Install from https://nodejs.org/`,
    );
    process.exit(1);
  }
  ok(`Node.js v${process.versions.node}`);
}

// ---------------------------------------------------------------------------
// Step 2: npm install (only when needed)
// ---------------------------------------------------------------------------

function runNpm(args, label) {
  // On Windows, npm is a .cmd file and must be invoked via the shell.
  // `shell: true` lets the OS find it via PATHEXT.
  const result = spawnSync("npm", args, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    fail(`${label} failed (exit ${String(result.status)})`);
    process.exit(result.status ?? 1);
  }
}

function ensureDependencies() {
  header("Checking dependencies");
  if (!existsSync(NODE_MODULES)) {
    info("node_modules missing — running `npm install` (this may take a minute)…");
    runNpm(["install"], "npm install");
    ok("Dependencies installed");
    return;
  }
  // Quick freshness check: if package.json is newer than node_modules, npm
  // install has been skipped after a dependency change. Re-run to be safe.
  try {
    const pkgMtime = statSync(PKG_JSON).mtimeMs;
    const nmMtime = statSync(NODE_MODULES).mtimeMs;
    if (pkgMtime > nmMtime) {
      info("package.json is newer than node_modules — re-running `npm install`…");
      runNpm(["install"], "npm install");
      ok("Dependencies refreshed");
      return;
    }
  } catch {
    /* mtime check is best-effort */
  }
  ok("Dependencies up to date");
}

// ---------------------------------------------------------------------------
// Step 3: Build (only when needed)
// ---------------------------------------------------------------------------

function ensureBuild() {
  header("Checking build");
  if (!existsSync(CLI_ENTRY)) {
    info("dist/ missing — running `npm run build`…");
    runNpm(["run", "build"], "build");
    ok("Build complete");
    return;
  }
  // Compare the newest .ts under src/ with the build entry. If src is
  // newer, rebuild.
  const newestSrc = walkNewestMtime(SRC_DIR);
  const cliMtime = statSync(CLI_ENTRY).mtimeMs;
  if (newestSrc > cliMtime) {
    info("Source files newer than build — rebuilding…");
    runNpm(["run", "build"], "build");
    ok("Build refreshed");
    return;
  }
  ok("Build up to date");
}

/** Recursively scan a directory and return the largest mtime across .ts files. */
function walkNewestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries;
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    }
  }
  return newest;
}

// ---------------------------------------------------------------------------
// Step 4: Default config
// ---------------------------------------------------------------------------

function ensureConfig() {
  header("Checking config");
  if (existsSync(CONFIG_PATH)) {
    ok(`Config found at ${CONFIG_PATH}`);
    return;
  }
  info(`No config — creating a default one at ${CONFIG_PATH}`);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, DEFAULT_CONFIG_YAML, "utf8");
  ok("Default config written");
  warn(
    "All providers ship with placeholder API keys. After the panel " +
      "opens, go to the Providers tab to paste your real keys.",
  );
}

const DEFAULT_CONFIG_YAML = `# codex-responses-adapter — default config
# Generated by start.mjs on first run. Edit via the admin panel at
# http://127.0.0.1:11434/admin/ or by hand.

listen:
  host: 127.0.0.1
  port: 11434
  max_concurrency: 64

log:
  level: info

# admin_key intentionally left blank — the adapter binds to 127.0.0.1
# only, so the loopback socket itself is the security boundary. To
# expose the panel on a LAN, set admin_key here AND change listen.host.

# Pre-populated with the 5 providers we've end-to-end tested with
# Codex CLI. Replace the api_key for whichever ones you actually use,
# or delete the providers you don't need.
providers:
  - name: deepseek
    type: openai_compatible
    base_url: https://api.deepseek.com/v1
    api_key: REPLACE_ME
    models:
      - deepseek-chat
      - deepseek-reasoner
    capabilities:
      vision: false
      reasoning: true
    reasoning_param_name: reasoning_effort

  - name: qwen
    type: openai_compatible
    base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
    api_key: REPLACE_ME
    models:
      - qwen-max
      - qwen-plus
      - qwen-turbo
    capabilities:
      vision: false
      reasoning: false

  - name: xiaomi
    type: openai_compatible
    base_url: https://api.xiaomimimo.com/v1
    api_key: REPLACE_ME
    models:
      - mimo-v2.5-pro
      - mimo-v2-flash
    capabilities:
      vision: false
      reasoning: true

  - name: doubao
    type: openai_compatible
    base_url: https://ark.cn-beijing.volces.com/api/v3
    api_key: REPLACE_ME
    models:
      - doubao-seed-2-0-lite-260428
    capabilities:
      vision: false
      reasoning: true

  - name: kimi
    type: openai_compatible
    base_url: https://api.moonshot.cn/v1
    api_key: REPLACE_ME
    models:
      - kimi-k2.6
      - kimi-k2.5
      - moonshot-v1-32k
    capabilities:
      vision: false
      reasoning: true

# Codex sends a model name (we map "gpt-4o" by default to deepseek-chat).
# Edit these, or add more, via the admin panel's "Mappings" tab.
model_mappings:
  - alias: gpt-4o
    provider: deepseek
    upstream_model: deepseek-chat
  - alias: gpt-4o-mini
    provider: deepseek
    upstream_model: deepseek-chat

default_model: gpt-4o
`;

// ---------------------------------------------------------------------------
// Step 5: Free the listen port if a stale process owns it
// ---------------------------------------------------------------------------

function readListenPort() {
  // Cheap regex parse so we don't have to spin up the YAML parser here.
  try {
    const text = readFileSync(CONFIG_PATH, "utf8");
    const m = /^\s*port:\s*(\d+)/m.exec(text);
    if (m !== null) return Number.parseInt(m[1] ?? "11434", 10);
  } catch {
    /* fall through */
  }
  return 11434;
}

async function ensurePortFree(port) {
  header(`Checking port ${String(port)}`);
  const inUse = await new Promise((resolve) => {
    const tester = net.createServer();
    tester.once("error", () => resolve(true));
    tester.once("listening", () => {
      tester.close(() => resolve(false));
    });
    tester.listen(port, "127.0.0.1");
  });
  if (!inUse) {
    ok(`Port ${String(port)} is free`);
    return;
  }
  warn(
    `Port ${String(port)} is busy — attempting to free it. ` +
      "If this is your own running adapter, that's fine; this script " +
      "will replace it.",
  );
  await freePort(port);
}

async function freePort(port) {
  const plat = osPlatform();
  if (plat === "win32") {
    // `netstat -ano` then `taskkill /F /PID <pid>` for each owner.
    const ns = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of (ns.stdout ?? "").split(/\r?\n/)) {
      if (line.includes(`:${String(port)} `)) {
        const m = /\s+(\d+)\s*$/.exec(line);
        if (m !== null) pids.add(m[1]);
      }
    }
    for (const pid of pids) {
      info(`Killing PID ${pid}`);
      spawnSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
    }
  } else {
    // macOS / Linux: lsof reports the PID, then SIGTERM/SIGKILL.
    const ls = spawnSync("lsof", ["-ti", `tcp:${String(port)}`], {
      encoding: "utf8",
    });
    for (const pid of (ls.stdout ?? "").split(/\s+/).filter(Boolean)) {
      info(`Killing PID ${pid}`);
      try {
        process.kill(Number.parseInt(pid, 10), "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  // Give the OS a moment to release the socket.
  await new Promise((r) => setTimeout(r, 500));
}

// ---------------------------------------------------------------------------
// Step 6: Launch the adapter
// ---------------------------------------------------------------------------

function launchAdapter() {
  header("Starting codex-responses-adapter");
  info(`Config: ${CONFIG_PATH}`);
  info("The admin panel will open in your default browser.");
  info("Press Ctrl+C to stop.");
  console.log("");

  const child = spawn(
    process.execPath,
    [CLI_ENTRY, "start", "--config", CONFIG_PATH],
    {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      env: process.env,
    },
  );

  // Forward Ctrl+C to the child so it can gracefully stop.
  const onSigint = () => {
    try {
      child.kill("SIGINT");
    } catch {
      /* ignore */
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  });

  child.on("exit", (code, signal) => {
    process.off("SIGINT", onSigint);
    if (signal !== null) {
      info(`Adapter stopped (signal ${signal})`);
      process.exit(0);
    }
    process.exit(code ?? 0);
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(c("1", "codex-responses-adapter — one-click launcher"));
  checkNodeVersion();
  ensureDependencies();
  ensureBuild();
  ensureConfig();
  const port = readListenPort();
  await ensurePortFree(port);
  launchAdapter();
}

main().catch((err) => {
  fail(`Launch failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
