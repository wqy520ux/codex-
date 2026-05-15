/**
 * Cross-platform "open this URL in the user's default browser" helper.
 *
 * No external dependency: spawns the platform-native command and
 * detaches it so the adapter process is not blocked or affected by
 * the browser's lifecycle.
 *
 *  - win32  → `cmd /c start "" "<url>"` (the bare-string `""` argument
 *             is the window-title placeholder `start` requires; without
 *             it `start` would interpret the URL as the title.)
 *  - darwin → `open <url>`
 *  - linux  → `xdg-open <url>` (falls back silently when not installed)
 *
 * Failures are swallowed: we log a hint at info level via the supplied
 * logger but never throw, because opening a browser is a UX nicety
 * — never essential for the adapter to run.
 */

import { spawn } from "node:child_process";

/** Minimal logger shape — same as elsewhere in the codebase. */
export interface OpenBrowserLogger {
  info?(msg: string, extra?: object): void;
  warn?(msg: string, extra?: object): void;
}

export interface OpenBrowserOptions {
  readonly logger?: OpenBrowserLogger;
}

/**
 * Best-effort launch of the user's default browser pointing at `url`.
 * Resolves immediately; the spawned process is unref'd so the adapter
 * can exit independently of it.
 */
export function openBrowser(url: string, opts: OpenBrowserOptions = {}): void {
  const platform = process.platform;
  let command: string;
  let args: readonly string[];

  if (platform === "win32") {
    // `cmd.exe`'s built-in `start` is the most reliable launcher on
    // Windows. The empty string `""` is mandatory — `start` consumes
    // the first quoted argument as a window title.
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    // Assume Linux / freebsd / other unix-likes.
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
    child.on("error", (err) => {
      opts.logger?.warn?.("admin: failed to open browser", {
        platform,
        command,
        error: err.message,
      });
    });
    child.unref();
    opts.logger?.info?.("admin: opened browser", { url });
  } catch (err) {
    opts.logger?.warn?.("admin: openBrowser threw", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
