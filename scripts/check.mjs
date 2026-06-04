#!/usr/bin/env node
// Smoke check: syntax-validates every JS+Python source file in the repo.
// Runs in <100ms; catches typos, missing braces, TDZ, ESM/CJS mismatches.
import { execSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const targets = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "tmp" || name === ".git") continue;
    // opencv.js is the 10MB vendored Emscripten bundle (WASM embedded) — not
    // valid JS syntax. We test by loading it at runtime, not by parsing.
    if (name === "opencv.js") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if ([".js", ".mjs"].includes(extname(p))) targets.push(p);
  }
}

walk(ROOT);
// also check the .py server explicitly
const pyFiles = ["server.py"].map((f) => join(ROOT, f)).filter(existsSync);

let failed = 0;
for (const f of targets) {
  try {
    execSync(`node --check "${f}"`, { stdio: "pipe" });
    console.log(`OK  ${f.replace(ROOT, "")}`);
  } catch (e) {
    console.error(`FAIL ${f.replace(ROOT, "")}\n${e.stderr?.toString() || e.message}`);
    failed++;
  }
}
for (const f of pyFiles) {
  try {
    execSync(`python3 -m py_compile "${f}"`, { stdio: "pipe" });
    console.log(`OK  ${f.replace(ROOT, "")}`);
  } catch (e) {
    console.error(`FAIL ${f.replace(ROOT, "")}\n${e.stderr?.toString() || e.message}`);
    failed++;
  }
}

// Catch the TDZ class of bug that node --check misses: actually evaluate
// detector.js so any "use before declaration" crashes the check.
try {
  execSync(`node -e "require('./detector.js')"`, { cwd: ROOT, stdio: "pipe" });
  console.log(`OK  detector.js loads`);
} catch (e) {
  console.error(`FAIL detector.js load\n${e.stderr?.toString() || e.message}`);
  failed++;
}

if (failed) {
  console.error(`\n${failed} file(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
