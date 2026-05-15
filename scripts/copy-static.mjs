#!/usr/bin/env node
// Post-build step: copy non-TypeScript assets (admin static frontend)
// from src/ into dist/ so the published package and the Docker image
// both ship a self-contained admin panel.
//
// We only need three files (HTML, CSS, JS), so a hand-rolled
// directory copy is simpler than pulling in a build tool.

import { mkdir, copyFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, "..", "src", "admin", "static");
const DST = path.resolve(__dirname, "..", "dist", "admin", "static");

async function copyDir(src, dst) {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src);
  for (const name of entries) {
    const srcPath = path.join(src, name);
    const dstPath = path.join(dst, name);
    const st = await stat(srcPath);
    if (st.isDirectory()) {
      await copyDir(srcPath, dstPath);
    } else {
      await copyFile(srcPath, dstPath);
    }
  }
}

try {
  await copyDir(SRC, DST);
  console.log(`[copy-static] copied ${SRC} -> ${DST}`);
} catch (err) {
  console.error(`[copy-static] failed: ${err.message}`);
  process.exit(1);
}
