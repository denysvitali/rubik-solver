// Node-only regression test for specific public image URLs. Fetches each
// image, runs detectCube, and asserts structural invariants. Some of these
// images are KNOWN to trigger bugs in the detector — those assertions are
// kept in the test suite so the bug doesn't regress silently. Skip cleanly
// when the network is unreachable — CI may run without it.
//
//   node --test tests/detect-url.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Each case: a remote URL plus a local cache file. `knownBug` is an optional
// predicate that, if it returns a string, marks that case as a documented
// bug — the test asserts the bug is present so a future fix is a one-line
// flip (change the assertion from "is buggy" to "is fixed").
const CASES = [
  {
    name: "6071137 (emuncloud)",
    url: "https://s3.amazonaws.com/emuncloud-staticassets/productImages/sm075/hires/6071137.jpg",
    cache: "fixtures/6071137.jpg",
    // The cube carries a printed logo on the white centre sticker. The
    // cellColor average across the cell pulls hue/sat into a non-white bin,
    // so the centre of the white face is mis-classified as a colour.
    knownBug: (result) => result.face.cells[4]?.code !== "W"
      ? `centre cell classified as ${result.face.cells[4].code} (logo on white sticker bleeds into the average)`
      : null,
  },
  {
    name: "wargamer how-to",
    url: "https://www.wargamer.com/wp-content/sites/wargamer/2023/09/how-to-solve-a-rubiks-cube.jpg",
    cache: "fixtures/wargamer-how-to.jpg",
    // This image is documented as failing detection entirely. The structural
    // assertions below will pass; this entry simply records the case in the
    // suite so future runs report on it. Add a specific assertion here once
    // the failure mode is known.
    knownBug: null,
  },
];

// opencv.js is gitignored; bail out early so the test file still loads.
let cv, RD;
try {
  cv = require("../opencv.js");
  await new Promise((r) => { cv.onRuntimeInitialized = r; });
  RD = require("../detector.js");
} catch (err) {
  test("detect-url: opencv.js not present — skipping", { skip: true }, () => {});
}

async function fetchWithTimeout(url, ms = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "User-Agent": "node-test" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

async function loadImage(cacheFile) {
  fs.mkdirSync(new URL("./fixtures", import.meta.url), { recursive: true });
  if (!fs.existsSync(cacheFile)) {
    const buf = await fetchWithTimeout(TEST_URL_FOR(cacheFile));
    fs.writeFileSync(cacheFile, buf);
  }
  return jpeg.decode(fs.readFileSync(cacheFile), { useTArray: true });
}

// map cache file → source URL (the case object holds both, but we need
// the URL at fetch time, not case-construction time)
function TEST_URL_FOR(cacheFile) {
  const c = CASES.find((c) => new URL("./" + c.cache, import.meta.url).pathname === cacheFile.pathname);
  return c?.url;
}

if (!cv) {
  // opencv.js missing — no further tests can run
} else {
  for (const c of CASES) {
    const cacheFile = new URL("./" + c.cache, import.meta.url);
    let result, error;
    try {
      const img = await loadImage(cacheFile);
      const src = cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
      result = RD.detectCube(cv, src);
      src.delete();
    } catch (err) {
      error = err;
    }

    const tag = `detect-url[${c.name}]`;

    if (error) {
      test(`${tag}: could not load image — ${error.message}`, { skip: true }, () => {});
      continue;
    }

    test(`${tag}: returns a face object`, () => {
      assert.ok(result.face, "result.face missing");
      assert.equal(typeof result.method, "string");
    });

    test(`${tag}: face has 9 cells`, () => {
      assert.equal(result.face.cells.length, 9, `got ${result.face.cells.length}`);
    });

    test(`${tag}: every cell has a valid colour code`, () => {
      for (const cell of result.face.cells) {
        assert.match(cell.code, /^[WYROGB]$/, `bad code: ${cell.code}`);
        assert.ok(Array.isArray(cell.rgb) && cell.rgb.length === 3);
      }
    });

    test(`${tag}: stickerCount and squareCount are non-negative integers`, () => {
      assert.equal(typeof result.stickerCount, "number");
      assert.ok(result.stickerCount >= 0);
      assert.equal(typeof result.squareCount, "number");
      assert.ok(result.squareCount >= 0);
    });

    if (c.knownBug) {
      test(`${tag}: known bug — ${c.knownBug(result) ?? "see knownBug in detect-url.test.mjs"}`, () => {
        // The knownBug predicate returns a non-null string ONLY when the
        // bug is present. Asserting it is present pins the bug so a future
        // fix is a one-line flip (replace with the fixed-state assertion).
        const msg = c.knownBug(result);
        assert.ok(
          msg,
          "bug is fixed — update this test to assert the new (correct) behaviour",
        );
      });
    }
  }
}
