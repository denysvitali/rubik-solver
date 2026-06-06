// Node-only regression test for specific public image URLs. Fetches each
// image, runs the detector, and asserts the expected output.
//
// Each case pins the canonical 3×3 output for every visible face of the
// cube. These pinned values ARE the source of truth — see CLAUDE.md. When
// a test fails, the fix lives in detector.js / app.js / server.py, never
// in the assertions, fixtures, or the CASES array below.
//
// The first two cases are SOLVED cubes with three faces visible — the
// correct output for any of those faces is a 3×3 grid of a single solid
// colour. The third case is a scrambled cube (the canonical 3D-
// perspective "algorithms" image) — all three face grids are pinned.
//
//   node --test tests/detect-url.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

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
    // background — three faces visible (top, left, right). All three face
    // grids are pinned as the source of truth.
    url: "https://images.saymedia-content.com/.image/ar_1:1,c_fill,cs_srgb,q_auto:eco,w_1200/MTk3MDg5MjU5NDA3MDI1MjM1/rubik-cube-algorithms.png",
    cache: "fixtures/rubik-cube-algorithms.png",
    format: "png",
    // Each row of `faces` is a 3×3 grid read from the cube. The order is
    // [top, right, left] (top is the upward-tilted face). Sticker colours
    // are read off the image itself — these are the canonical values the
    // detector must reproduce.
    faces: [
      ["Y", "Y", "B", "B", "Y", "W", "W", "G", "R"], // top
      ["O", "R", "B", "R", "G", "W", "B", "G", "G"], // right
      ["Y", "B", "W", "W", "R", "G", "O", "G", "Y"], // left
    ],
  },
  {
    name: "spin6063964 (stoysnetcdn)",
    url: "https://stoysnetcdn.com/spin/spin6063964/spin6063964_1.jpg",
    cache: "fixtures/spin6063964.jpg",
    format: "jpg",
    // 1024×1024 lifestyle shot: a child holds a scrambled cube at an angle,
    // three faces visible against a textured background (grey t-shirt + striped
    // bedsheet), fingers occluding the front-bottom. Only the TOP face is fully
    // visible and unoccluded — the left/right faces are heavily foreshortened
    // with white stickers tucked under the fingers, so their contours can't be
    // recovered classically (see CLAUDE.md). The previous detector returned two
    // garbage faces: orientation-grouping ran across the whole image, so
    // background squares (t-shirt folds, bedsheet creases) polluted the face
    // groups. Clustering by proximity FIRST isolates the cube blob before the
    // orientation split, so the fully-visible top face now reads correctly.
    // `stickerTopFace` is the canonical 3×3 of that top face; detectFaces (the
    // app's primary path) must return it.
    stickerTopFace: "BGOBGBBRO",
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
    } else if (c.faces) {
      // SCRAMBLED 3-face cube: pin each of the three face grids as source
      // of truth. detectCube only returns ONE face, so we use
      // detectFacesGeometric for this case — the multi-face geometric
      // path is the right tool. We compute the same u2netp mask the
      // browser does (see test/full.mjs) so the test exercises the
      // actual production path, not a degraded Node-only fallback.
      const img2 = await loadImage(cacheFile, c.format);
      const src2 = cv.matFromImageData({ data: img2.data, width: img2.width, height: img2.height });
      let faces;
      try {
        // Run the u2netp model to segment the cube (mirrors what
        // app.js:segmentCube does in the browser).
        const sess = await ort.InferenceSession.create("./u2netp.onnx");
        const rs = new cv.Mat(); cv.resize(src2, rs, new cv.Size(320, 320), 0, 0, cv.INTER_AREA);
        const rgb = new cv.Mat(); cv.cvtColor(rs, rgb, cv.COLOR_RGBA2RGB);
        const d = rgb.data;
        const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
        const inp = new Float32Array(3 * 320 * 320);
        for (let i = 0; i < 320 * 320; i++) for (let k = 0; k < 3; k++) inp[k * 320 * 320 + i] = ((d[i * 3 + k] / 255) - mean[k]) / std[k];
        const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, 320, 320]) });
        const sal = out[sess.outputNames[0]].data;
        let mn = 1e9, mx = -1e9; for (const v of sal) { if (v < mn) mn = v; if (v > mx) mx = v; }
        const m320 = new cv.Mat(320, 320, cv.CV_8U);
        for (let i = 0; i < 320 * 320; i++) m320.data[i] = ((sal[i] - mn) / (mx - mn)) > 0.5 ? 255 : 0;
        const cubeMask = new cv.Mat();
        cv.resize(m320, cubeMask, new cv.Size(img2.width, img2.height), 0, 0, cv.INTER_NEAREST);
        rs.delete(); rgb.delete(); m320.delete();
        try {
          faces = RD.detectFacesGeometric(cv, src2, { cubeMask });
        } finally {
          cubeMask.delete();
        }
      } finally {
        src2.delete();
      }
      test(`${tag}: detects 3 faces`, () => {
        assert.equal(faces.length, 3, `expected 3 faces from the 3-face cube; got ${faces.length}`);
      });
      test(`${tag}: every face has 9 valid cells`, () => {
        for (const f of faces) {
          assert.equal(f.face.cells.length, 9);
          for (const cell of f.face.cells) {
            assert.match(cell.code, /^[WYROGB]$/, `bad code: ${cell.code}`);
          }
        }
      });
      test(`${tag}: all three face grids match the source of truth`, () => {
        const got = faces.map((f) => f.face.cells.map((cell) => cell.code).join(""));
        const want = c.faces.map((row) => row.join(""));
        const missing = want.filter((g) => !got.includes(g));
        const extra = got.filter((g) => !want.includes(g));
        assert.equal(
          missing.length + extra.length,
          0,
          `face grids differ. got=${JSON.stringify(got)} want=${JSON.stringify(want)} ` +
            (missing.length ? `missing=${JSON.stringify(missing)} ` : "") +
            (extra.length ? `extra=${JSON.stringify(extra)}` : ""),
        );
      });
    } else if (c.stickerTopFace) {
      // Angled hand-held cube where only the top face is fully visible: the
      // app's primary path is detectFaces (sticker-orientation). Assert it
      // recovers the pinned top-face grid. (detectCube — run above — returns a
      // single best-effort face and is NOT the path the app uses for this kind
      // of multi-face shot, so it is not asserted here.)
      const img3 = await loadImage(cacheFile, c.format);
      const src3 = cv.matFromImageData({ data: img3.data, width: img3.width, height: img3.height });
      let stickerFaces;
      try {
        stickerFaces = RD.detectFaces(cv, src3);
      } finally {
        src3.delete();
      }
      test(`${tag}: detectFaces recovers the fully-visible top face`, () => {
        const got = stickerFaces.map((f) => f.face.cells.map((cell) => cell.code).join(""));
        assert.ok(
          got.includes(c.stickerTopFace),
          `expected top face ${c.stickerTopFace} among detected faces ${JSON.stringify(got)} — ` +
            `background squares are likely polluting the orientation groups (cluster by proximity before splitting by orientation).`,
        );
      });
    } else {
      // For SCRAMBLED cubes without a pinned 3-face grid: just confirm
      // we got something that looks like a real 3×3 cube read.
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
