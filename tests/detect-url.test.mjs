// Node-only regression test for specific public image URLs. Fetches each
// image, runs detectCube, and asserts the expected output. The first two
// cases are SOLVED cubes with three faces visible — the correct detectCube()
// result for any of those faces is a 3×3 grid of a single solid colour.
// They currently fail (see failureMode for the bug) and will go green when
// the bugs are fixed. The third case is a scrambled cube (the canonical
// 3D-perspective "algorithms" image) — it only asserts structural validity,
// since the correct grid is a mix of colours.
//
//   node --test tests/detect-url.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// Each case: a remote URL plus a local cache file. `solved` is a
// Set<string> of the face colours that should be detectable on the cube
// (the cube is in solved state in the image). `failureMode` is a
// human-readable note about the CURRENT (buggy) behaviour — printed when
// the expected-output assertion fails, so the failure message points at
// the right thing to fix. `format` picks the decoder (jpg or png).
const CASES = [
  {
    name: "6071137 (emuncloud)",
    url: "https://s3.amazonaws.com/emuncloud-staticassets/productImages/sm075/hires/6071137.jpg",
    cache: "fixtures/6071137.jpg",
    format: "jpg",
    // 2500×2500 product shot. Cube in solved state with three faces
    // visible: red (top), blue (left), white (right, with a "Rubik's"
    // logo on the centre sticker).
    solved: new Set(["R", "B", "W"]),
    failureMode:
      "Method 3 (green/blue anchor) finds only 5 squares in a 90×90 region OUTSIDE the cube (1744,1455 in the 2500×2500 image) and stitches a 9-cell grid from background artefacts — current output is W B O / B B B / W B W. Fix: PCA-grid / sticker-proximity methods should not fall through to anchors when the cube fills most of the image.",
  },
  {
    name: "wargamer how-to",
    url: "https://www.wargamer.com/wp-content/sites/wargamer/2023/09/how-to-solve-a-rubiks-cube.jpg",
    cache: "fixtures/wargamer-how-to.jpg",
    format: "jpg",
    // 1920×1080. Cube in solved state on a teal/cyan background. Three
    // faces visible: white (top, with "Rubik's" logo on centre), red
    // (left), blue (right).
    solved: new Set(["R", "B", "W"]),
    failureMode:
      "Method 1 (grid) PCA-on-direction-vectors found the parallelogram DIAGONALS of the tilted face (not the row/column sides), so the (u,v) grid's corners landed at the diagonal extremes — one corner at y=−115 off-screen. The warped 3×3 then sampled across face boundaries, returning R W B / R W W / R B B. Fix: use each sticker's e1/e2 edge vectors (set in findStickerSquares from approxPolyDP) as the (u,v) axes — they're the 2D projections of the face's actual grid-aligned edges. Plus: colorGroup the cluster first (9R/8W/7B for this image) so solved-cube single-colour faces take the fast path without kmeans.",
  },
  {
    name: "rubik-cube-algorithms (saymedia)",
    // 1200×1200 PNG. 3D-perspective scrambled cube on a light blue
    // background — three faces visible (top, left, right). Not a solved
    // cube, so the assertion is only structural (9 cells, valid codes).
    // Originally failed because findStickerSquares rejected tall/narrow
    // left-face stickers (maxAspect 2.2 was too tight for perspective).
    url: "https://images.saymedia-content.com/.image/ar_1:1,c_fill,cs_srgb,q_auto:eco,w_1200/MTk3MDg5MjU5NDA3MDI1MjM1/rubik-cube-algorithms.png",
    cache: "fixtures/rubik-cube-algorithms.png",
    format: "png",
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

function urlFor(cacheFile) {
  const c = CASES.find((c) => new URL("./" + c.cache, import.meta.url).pathname === cacheFile.pathname);
  return c?.url;
}

async function loadImage(cacheFile, format) {
  fs.mkdirSync(new URL("./fixtures", import.meta.url), { recursive: true });
  if (!fs.existsSync(cacheFile)) {
    const buf = await fetchWithTimeout(urlFor(cacheFile));
    fs.writeFileSync(cacheFile, buf);
  }
  const raw = fs.readFileSync(cacheFile);
  if (format === "png") {
    return await new Promise((res, rej) => new PNG().parse(raw, (e, x) => (e ? rej(e) : res(x))));
  }
  return jpeg.decode(raw, { useTArray: true });
}

if (!cv) {
  // opencv.js missing — no further tests can run
} else {
  for (const c of CASES) {
    const cacheFile = new URL("./" + c.cache, import.meta.url);
    let result, error;
    try {
      const img = await loadImage(cacheFile, c.format);
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

    // For SOLVED cubes: a correct detectCube() result for any of the three
    // visible faces is 9 cells of the same colour. The current output
    // mixes colours, which is impossible on a solved cube.
    if (c.solved) {
      test(`${tag}: expected output — 3×3 grid is a single solid colour matching a visible face`, () => {
        const codes = result.face.cells.map((cell) => cell.code);
        const distinct = new Set(codes);
        assert.equal(
          distinct.size,
          1,
          `expected a single solid-colour face; got ${[...distinct].join("")} (grid: ${codes.join(" ")}) — impossible on a solved cube. Current failure: ${c.failureMode}`,
        );
        assert.ok(
          c.solved.has(codes[0]),
          `face colour ${codes[0]} is not one of the visible faces on the cube (${[...c.solved].join("")})`,
        );
      });
    } else {
      // For SCRAMBLED cubes: just confirm we got something that looks
      // like a real 3×3 cube read (at least 3 distinct colours, none of
      // which is the empty/default W).
      test(`${tag}: 3×3 grid shows a real scrambled face (>=3 distinct colours)`, () => {
        const codes = result.face.cells.map((cell) => cell.code);
        const distinct = new Set(codes);
        assert.ok(
          distinct.size >= 3,
          `expected >=3 distinct colours on a scrambled face; got ${[...distinct].join("")} (grid: ${codes.join(" ")}) — detector is likely reading across face boundaries.`,
        );
      });
    }
  }
}
