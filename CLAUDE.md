# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Browser-based Rubik's cube face detector. Drop a photo → get a 3×3 colour grid. All vision runs client-side via OpenCV.js. No build step, no bundler — plain JS served as-is.

## Commands

```bash
# Run the app (serves http://0.0.0.0:8085 with cache-busting)
python3 server.py

# Run shared detector in Node on any image
node test/detect.mjs <image.jpg>

# Drive the real page in headless Chromium (needs server.py running)
node test/harness.mjs <out.png> [image.jpg]

# Test manual perspective sampler with 4 corners (8 numbers, work-space coords)
node test/quad.mjs <image.jpg> x1 y1 x2 y2 x3 y3 x4 y4

# Full pipeline test: ONNX segmentation → geometric detector
node test/full.mjs <image.jpg>

# Verify alternation scoring (axis-aligned vs diagonal gradient energy)
node test/altcheck.mjs <image.jpg>

# Face warp montage: ONNX → geometric → warped face output
node test/faceswarp.mjs <image.jpg>
```

No `npm test` wired up. No linter configured.

## Architecture

**detector.js** — the core. Shared DOM-free detection module (UMD: works in browser as `window.RubikDetector` and in Node via `require()`). Every detection method lives here. `app.js` and all test harnesses import this verbatim — zero algorithm duplication.

**app.js** — browser UI glue. Loads images, calls `RubikDetector.detectCube()` / `detectFaces()` / `detectFacesGeometric()`, draws overlays, handles drag-to-edit wireframe corners, copy-to-clipboard.

**index.html** — single-page UI + inline styles.

**server.py** — Python static file server. Cache-busting (injects `?v=<token>` into script refs per request). Proxies the sample image and ONNX model from their origin URLs to avoid CORS/mixed-content issues.

**test/** — Node harnesses that reuse the same `detector.js`:
- `detect.mjs` — Node-only detection (loads opencv.js + jpeg-js, runs detector, prints result)
- `harness.mjs` — Puppeteer-driven browser test (needs server.py running)
- `quad.mjs` — manual perspective sampler test
- `full.mjs` — ONNX segmentation + geometric detection pipeline
- `altcheck.mjs` — verifies alternation scoring (axis-aligned vs diagonal gradient energy)
- `faceswarp.mjs` — ONNX segmentation → geometric detection → warped face montage

## Detection Pipeline

`detectCube()` resizes input to **600px working width** (deterministic regardless of source resolution), then tries in order:

1. **PCA grid (Method 1)** — find sticker squares via adaptive threshold + contour analysis, cluster by proximity, PCA-based 3×3 grid reconstruction from nearest-neighbor direction vectors. Works with 5+ stickers under perspective. Falls back to `splitByOrientation()` for clusters merging two adjacent faces.
2. **Sticker proximity (Method 2)** — cluster stickers, bounding box if ≥5 found.
3. **Green/blue anchors (Method 3)** — find green+blue blobs (absent from skin/brick/wood backgrounds), cluster, bounding box.
4. **Center crop (Method 4)** — last resort, low confidence.

`detectFaces()` — multi-face, **orientation-first**. The visible faces of an angled cube touch each other, so proximity clustering merges them into one blob; but every sticker on a given face is a parallelogram whose two edge directions are shared across that face (the 2D projection of the face's grid axes), and an adjacent face projects a *different* pair. So `groupByOrientation()` splits the stickers into faces by their unordered edge-angle pair (needs only ≥3 co-oriented stickers per face), then each group is split by proximity (so same-oriented background rectangles apart from the cube — poster grids, tiles — aren't fitted as a face) and `fitGrid()` reconstructs each 3×3. `fitGrid()` handles a full 9-sticker face (sort-by-v group-by-3) and a partial 5–8 face (oblique-basis decomposition + 1D k-means, tolerant to an occluded sticker).

`detectFacesGeometric()` — tries the sticker-orientation path (`detectFaces`) first; for cubes with individually-detectable stickers (bordered/matte, decent lighting) that reads the actual lattice and is far more accurate than the silhouette fit. Falls through to the top-down silhouette path only for glossy/stickerless/borderless cubes where per-sticker segmentation fails: segments the cube as one saturated silhouette (neural model → GrabCut → threshold fallback), approximates to 4-corner (single face) or 6-corner (three faces) polygon, snaps edges to gradient peaks, solves PnP pose for the near-corner, perspective-warps each face quad. For the 6-corner case, picks the correct side/outer alternation via gradient-energy scoring (`altScore()`): the correct decomposition yields axis-aligned sticker edges in warped faces; the wrong one rotates them ~45°.

**Known limit:** a glossy/rounded cube with a *white* face on a *light* background (e.g. the `6071137` fixture) defeats both paths through `detectCube` — sticker contours are too sparse, and the saturation silhouette can't separate the white face from the white background. This needs the neural mask (which `detectCube`'s no-arg signature doesn't supply) or friendlier capture.

## Key Constants

- `WORK_WIDTH = 600` — standard detection resolution
- `GEO_WORK = 900` — geometric path needs more silhouette precision
- Colour classification: HSV thresholds in `classifyColor()` → W/Y/R/O/G/B

## Dependencies

- **opencv.js** — vendored 10MB file, gitignored, loaded from CDN in browser / required directly in Node
- **jpeg-js** — image decode in Node tests
- **onnxruntime-node** — ONNX inference for neural cube segmentation (u2netp model, ~4.5MB, fetched on first run)
- **puppeteer** — headless Chromium for browser integration tests

## Conventions

- All Mat allocations must be `.delete()`d — OpenCV.js doesn't GC them
- Detection functions take a `cv` instance + `cv.Mat`, return plain data objects — no DOM access in detector.js
- Debug arrays: pass `{debug: []}` in opts to collect step images as `{name, width, height, data:RGBA}`
- Corner order convention: `[TL, TR, BR, BL]` via `orderCorners()` (sum/diff trick)

## Source of Truth

Pinned test expectations in `tests/` are the **source of truth** and must never be modified to make a broken detector pass. When a test fails, the fix lives in `detector.js`, `app.js`, or `server.py` — never in the test assertions, fixtures, or the `CASES` array in `tests/detect-url.test.mjs`.

If the detector is wrong about a known input, the expected output is the ground truth and the detector must be made to match. If a new detector behaviour needs pinning, **add a new assertion to the test file** — don't edit an existing one. Pinned values (face grids, side-start indices, color codes) encode intent: changing them silently changes the contract the detector implements.

The `CASES` array in `tests/detect-url.test.mjs` is the canonical record of the expected output for each known input image. For multi-face cases (e.g. the 3-face `algorithms.png`), each of the three faces' `cells` arrays is pinned — top, left, right.
