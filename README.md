# 🧊 Rubik's Cube Face Detector

A browser app that detects a Rubik's cube in a photo and renders the detected
face as a 3×3 colour grid. All vision runs client-side with [OpenCV.js].

## Run

```bash
python3 server.py        # serves http://0.0.0.0:8085 (no-cache + cache-busting)
```

Open <http://0.0.0.0:8085>, drop a cube photo (or click **Load sample**), then
**Detect cube**. The detected face shows on the right with a **Copy** button.

No binaries are committed: OpenCV.js loads from the CDN, and the sample image is
fetched server-side from its origin URL and served same-origin (so reading the
canvas pixels isn't blocked by CORS).

## How detection works

Detection is implemented once in **`detector.js`** and used verbatim by both the
browser (`app.js`) and the Node tests — there is no duplicated algorithm.

`detectCube()` resizes the input to a fixed working width (600 px) so results
are **deterministic regardless of display/source resolution**, then locates the
face with two methods:

1. **Sticker squares** — find every vivid, solid, square sticker and cluster
   them. When ≥5 are found (typical clean cube) the face is their bounding box.
   Stable even if a sticker drops in/out of the mask between browsers.
2. **Green/blue anchors** (fallback) — green and blue hues don't occur in skin,
   brick, wood or paper, so they reliably anchor a cube on a busy/warm
   background where clean squares can't be isolated.

Each grid cell's colour is taken from the dominant *vivid* hue in that cell, so
a sticker is read correctly even when a finger or shadow partly covers it.
Colours are classified in HSV into W/Y/R/O/G/B.

## Files

| file | role |
|------|------|
| `index.html` | UI + styles |
| `detector.js` | shared, DOM-free detection module (`RubikDetector`) |
| `app.js` | browser glue: load image, run detector, draw overlay/result |
| `server.py` | static server: no-cache, cache-busting, sample-image proxy |
| `test/` | Node + headless-Chromium harnesses that run the **same** `detector.js` |

## Tests

```bash
node test/detect.mjs <image.jpg>     # run the shared detector in Node, draw result
node test/harness.mjs <out.png> <img> # drive the real page in headless Chromium
```

[OpenCV.js]: https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js
