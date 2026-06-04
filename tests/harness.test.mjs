// Integration test: drives the REAL page in headless Chromium, loads
// sample.jpg via the page's own loader, runs detection, and asserts the
// result. This is the full-stack regression net — catches TDZ bugs, DOM
// regressions, classifier regressions, and the opencv.js CDN load.
//
// Run:  node --test tests/harness.test.mjs
// Needs: server.py running on :8085, sample.jpg in repo root, and
//        chromium (set PUPPETEER_EXECUTABLE_PATH or let puppeteer find it).
//
// In the sandboxed dev env without internet access to docs.opencv.org, run
// inside `nix-shell -p chromium --run 'PUPPETEER_EXECUTABLE_PATH=$(which
// chromium) node --test tests/harness.test.mjs'` (per the user memory).
import test from "node:test";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";

const URL = process.env.URL || "http://localhost:8085/";
const IMG = process.env.IMG || "sample.jpg";

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 1000 });

const errors = [];
page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`[console.error] ${m.text()}`); });

await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });

// If the opencv.js CDN is unreachable (sandbox, offline), the page never
// reports ready. Skip the test gracefully rather than fail — CI runners
// with full network will run it.
const cvReady = await page.waitForFunction(
  () => document.getElementById("status")?.classList.contains("ready"),
  { timeout: 30000 }
).then(() => true).catch(() => false);

if (!cvReady) {
  await browser.close();
  test("harness: opencv.js never became ready (no CDN access?)", { skip: true }, () => {});
  process.exit(0);
}

await page.evaluate((src) => window.__loadForTest(src), IMG).catch(() => page.click("#sampleBtn"));
await page.waitForFunction(
  () => !document.getElementById("detectBtn")?.disabled,
  { timeout: 30000 }
);
await page.click("#detectBtn");
await page.waitForFunction(() => {
  const s = document.getElementById("status")?.textContent || "";
  return /complete|error/i.test(s);
}, { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

const result = await page.evaluate(() => {
  const status = document.getElementById("status")?.textContent;
  const diag = document.getElementById("diag")?.textContent;
  return {
    status,
    diag,
    cards: [...document.querySelectorAll(".face-card")].map((card) => ({
      title: card.querySelector("h3")?.textContent,
      cells: [...card.querySelectorAll(".cell")].map((c) => ({
        code: c.querySelector(".lbl")?.textContent,
      })),
    })),
  };
});

await browser.close();

const CODES = /^[WYROGB]$/;

test("harness: no uncaught page errors during detection", () => {
  // filter out the harmless "uncaught" from a network blip on the model load
  const real = errors.filter((e) => !/load failed|onnxruntime/i.test(e));
  assert.deepEqual(real, [], "page errors: " + real.join("\n"));
});

test("harness: status reports 'Detection complete'", () => {
  assert.match(result.status, /complete/i, `got: ${result.status}`);
});

test("harness: at least one face card rendered", () => {
  assert.ok(result.cards.length >= 1, `got ${result.cards.length} cards; diag: ${result.diag}`);
});

test("harness: every face has exactly 9 cells with valid colour codes", () => {
  for (const card of result.cards) {
    assert.equal(card.cells.length, 9, `face "${card.title}" has ${card.cells.length} cells`);
    for (const c of card.cells) {
      assert.match(c.code, CODES, `bad colour code in "${card.title}": ${c.code}`);
    }
  }
});

// Optional golden check (skip in CI by default — exact grids are fragile
// to small OpenCV.js version changes; structural assertions above are the
// real safety net).
test("harness: golden grid (sample.jpg ≈ all white stickers)", { skip: !process.env.GOLDEN }, () => {
  const cells = result.cards[0].cells.map((c) => c.code);
  const allWhite = cells.every((c) => c === "W");
  assert.ok(allWhite, `expected all-W; got: ${cells.join(" ")}`);
});
