#!/usr/bin/env node
// Watches source files and re-runs the harness on every save.
// Replaces the manual "save → switch tab → refresh → click detect" ritual
// with a passive "save → look at fresh shot.png" loop.
//
//   node scripts/watch.mjs                # defaults to harness.mjs + sample.jpg
//   node scripts/watch.mjs detect.mjs sample.jpg
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { resolve, join, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = process.argv[2] || "test/harness.mjs";
const IMG = process.argv[3] || "sample.jpg";
const OUT = process.argv[4] || `tmp/${basename(SCRIPT, ".mjs")}-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.png`;

// Files that, when changed, should re-run the harness.
const WATCH = ["detector.js", "app.js", "index.html", SCRIPT, "scripts/check.mjs"];

let running = false, queued = false, timer = null;
function run() {
  if (running) { queued = true; return; }
  running = true;
  const t0 = Date.now();
  const proc = spawn("node", [SCRIPT, OUT, IMG], { cwd: ROOT, stdio: "inherit" });
  proc.on("exit", (code) => {
    const ms = Date.now() - t0;
    console.log(`\n[watch] ${SCRIPT} exited ${code} in ${ms}ms; screenshot: ${OUT}`);
    running = false;
    if (queued) { queued = false; run(); }
  });
}

function debouncedRun() {
  clearTimeout(timer);
  timer = setTimeout(run, 80);
}

console.log(`[watch] watching ${WATCH.join(", ")} → ${SCRIPT} ${OUT} ${IMG}`);
for (const f of WATCH) {
  try { watch(resolve(ROOT, f), { persistent: true }, debouncedRun); }
  catch (e) { console.warn(`[watch] cannot watch ${f}: ${e.message}`); }
}
run();
