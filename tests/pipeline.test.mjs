// End-to-end pipeline regression over URL-backed fixtures. These tests exercise
// the readable step array in pipeline/pipeline.js rather than one detector path.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const CASES = [
  {
    name: "flat sticker sample",
    cache: "../sample.jpg",
    format: "jpg",
    expected: "GRYGBOGYB",
  },
  {
    name: "6071137",
    url: "https://s3.amazonaws.com/emuncloud-staticassets/productImages/sm075/hires/6071137.jpg",
    cache: "fixtures/6071137.jpg",
    format: "jpg",
  },
  {
    name: "wargamer how-to",
    url: "https://www.wargamer.com/wp-content/sites/wargamer/2023/09/how-to-solve-a-rubiks-cube.jpg",
    cache: "fixtures/wargamer-how-to.jpg",
    format: "jpg",
  },
  {
    name: "rubik-cube-algorithms",
    url: "https://images.saymedia-content.com/.image/ar_1:1,c_fill,cs_srgb,q_auto:eco,w_1200/MTk3MDg5MjU5NDA3MDI1MjM1/rubik-cube-algorithms.png",
    cache: "fixtures/rubik-cube-algorithms.png",
    format: "png",
  },
  {
    name: "spin6063964",
    url: "https://stoysnetcdn.com/spin/spin6063964/spin6063964_1.jpg",
    cache: "fixtures/spin6063964.jpg",
    format: "jpg",
  },
  {
    name: "wikipedia rubik's cube",
    url: "https://upload.wikimedia.org/wikipedia/commons/e/e2/Rubik%27s_Cube.jpg",
    cache: "fixtures/wikipedia-rubiks-cube.jpg",
    format: "jpg",
  },
];

let cv, RD;
try {
  cv = require("../opencv.js");
  await new Promise((r) => { cv.onRuntimeInitialized = r; });
  RD = require("../detector.js");
} catch (err) {
  test("pipeline: opencv.js not present - skipping", { skip: true }, () => {});
}
const Pipeline = require("../pipeline/pipeline.js");

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

async function loadImage(c) {
  const cacheFile = new URL("./" + c.cache, import.meta.url);
  if (c.url) fs.mkdirSync(new URL("./fixtures", import.meta.url), { recursive: true });
  if (c.url && !fs.existsSync(cacheFile)) {
    fs.writeFileSync(cacheFile, await fetchWithTimeout(c.url));
  }
  const raw = fs.readFileSync(cacheFile);
  if (c.format === "png") {
    return await new Promise((res, rej) => new PNG().parse(raw, (e, x) => (e ? rej(e) : res(x))));
  }
  return jpeg.decode(raw, { useTArray: true });
}

if (cv) {
  test("pipeline: step array is readable and ordered", () => {
    assert.deepEqual(
      Pipeline.PIPELINE_STEPS.map((s) => s.id),
      [
        "sticker-faces",
        "single-face-fallback",
        "learned-face-localization",
        "geometric-silhouette",
        "low-confidence-single-face",
      ],
    );
  });

  for (const c of CASES) {
    const cacheFile = new URL("./" + c.cache, import.meta.url);
    test(`pipeline: ${c.name}`, { skip: !c.url && !fs.existsSync(cacheFile) }, async () => {
      const img = await loadImage(c);
      const src = cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
      let result;
      try {
        result = await Pipeline.runPipeline(cv, src, { detector: RD });
      } finally {
        src.delete();
      }

      assert.notEqual(result.kind, "none");
      assert.ok(result.pipeline.length >= 1, "pipeline artifacts missing");
      assert.ok(result.pipeline.some((s) => s.status === "accepted"), "no accepted pipeline step");

      const faces = result.kind === "multi" ? result.faces.map((f) => f.face) : [result.result.face];
      assert.ok(faces.length >= 1, "no faces returned");
      for (const face of faces) {
        assert.equal(face.cells.length, 9);
        for (const cell of face.cells) assert.match(cell.code, /^[WYROGB]$/);
      }
      if (c.expected) {
        assert.equal(faces.length, 1);
        assert.equal(faces[0].cells.map((cell) => cell.code).join(""), c.expected);
      }
    });
  }
}
