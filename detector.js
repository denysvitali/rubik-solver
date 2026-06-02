/* Rubik's Cube face detector — SHARED by the browser (app.js) and the Node
 * test harness. No DOM access here: every function takes an OpenCV.js `cv`
 * instance and/or a cv.Mat and returns plain data. This guarantees the browser
 * and the tests run byte-for-byte the same detection code.
 *
 * Determinism: detectCube() resizes the input to a FIXED working width before
 * doing anything, so the result no longer depends on the display/source size.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RubikDetector = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const WORK_WIDTH = 600; // fixed internal processing width

  // Standard cube colors (display swatch + classification target).
  const COLORS = {
    W: { name: "White",  css: "#f5f5f5" },
    Y: { name: "Yellow", css: "#ffd500" },
    R: { name: "Red",    css: "#d11a1a" },
    O: { name: "Orange", css: "#ff7a1a" },
    G: { name: "Green",  css: "#1faa46" },
    B: { name: "Blue",   css: "#175fd6" },
  };

  function classifyColor(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    const s = mx === 0 ? 0 : d / mx, v = mx / 255;
    if (s < 0.22 && v > 0.5) return "W";
    if (v < 0.12) return "W";
    if (h < 16 || h >= 330) return "R";
    if (h < 40) return "O";   // orange sits near 15-30°
    if (h < 70) return "Y";   // yellow ~45-60°
    if (h < 175) return "G";
    if (h < 265) return "B";
    return "R";
  }

  // Representative color of one cell. Stickers are vivid; fingers/shadows/
  // gridlines are duller. Keep vivid pixels, bin by hue (plus a white bin),
  // average the dominant bin — so a sticker shows through partial occlusion.
  function cellColor(mat, cx, cy, hx, hy) {
    const W = mat.cols, H = mat.rows, data = mat.data;
    const px = [];
    for (let y = Math.floor(cy - hy); y < cy + hy; y++) {
      for (let x = Math.floor(cx - hx); x < cx + hx; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d) {
          if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
          h *= 60; if (h < 0) h += 360;
        }
        px.push({ r, g, b, h, s: mx === 0 ? 0 : d / mx, v: mx / 255 });
      }
    }
    if (!px.length) return [0, 0, 0];
    let pool = px.filter((p) => p.s >= 0.7 && p.v >= 0.4);
    if (pool.length < px.length * 0.05) pool = px; // pale/white cell
    const bins = {};
    for (const p of pool) {
      const key = (p.s < 0.25 && p.v > 0.5) ? "W" : Math.floor(p.h / 30);
      (bins[key] = bins[key] || []).push(p);
    }
    let best = null;
    for (const k in bins) if (!best || bins[k].length > bins[best].length) best = k;
    const grp = bins[best];
    let r = 0, g = 0, b = 0;
    for (const p of grp) { r += p.r; g += p.g; b += p.b; }
    return [r / grp.length, g / grp.length, b / grp.length];
  }

  function sampleGrid(mat, region, detected) {
    const cells = [];
    const cw = region.w / 3, ch = region.h / 3;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const cx = region.x + cw * (gx + 0.5);
        const cy = region.y + ch * (gy + 0.5);
        const [r, g, b] = cellColor(mat, cx, cy, Math.max(4, cw * 0.28), Math.max(4, ch * 0.28));
        cells.push({ code: classifyColor(r, g, b), rgb: [Math.round(r), Math.round(g), Math.round(b)], cx, cy });
      }
    }
    return { cells, detected };
  }

  // Detect ALL vivid, solid, square stickers (any hue). Robust on clean cubes
  // where most of the 9 stickers are clearly bounded by black borders.
  function findStickerSquares(cv, mat, imgArea) {
    const rgb = new cv.Mat(); cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 90, 60, 0]);
    const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 255, 255, 0]);
    const mask = new cv.Mat(); cv.inRange(hsv, lo, hi, mask);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, k);
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, k);
    const cnts = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(mask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const st = [];
    for (let i = 0; i < cnts.size(); i++) {
      const c = cnts.get(i); const area = cv.contourArea(c); const r = cv.boundingRect(c);
      const ar = r.width / r.height, fill = area / (r.width * r.height);
      if (area > imgArea * 0.0008 && area < imgArea * 0.04 && ar > 0.6 && ar < 1.7 && fill > 0.62) {
        st.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: (r.width + r.height) / 2, rect: r });
      }
      c.delete();
    }
    rgb.delete(); hsv.delete(); lo.delete(); hi.delete(); mask.delete(); k.delete(); cnts.delete(); hier.delete();
    return st;
  }

  // Cluster by proximity, optionally requiring similar sizes (for real
  // sticker squares that should all be about the same size).
  function clusterStickers(items, sizeSimilar) {
    const n = items.length;
    if (!n) return [];
    const sides = items.map((s) => s.side).sort((a, b) => a - b);
    const med = sides[n >> 1] || 20;
    const par = items.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = items[i], b = items[j], bg = Math.max(a.side, b.side);
        const ok = !sizeSimilar || Math.min(a.side, b.side) / bg > 0.55;
        if (ok && Math.hypot(a.cx - b.cx, a.cy - b.cy) < bg * (sizeSimilar ? 1.8 : 4)) par[find(i)] = find(j);
      }
    }
    const g = {};
    items.forEach((s, i) => { const r = find(i); (g[r] = g[r] || []).push(s); });
    return Object.values(g).sort((a, b) => b.length - a.length);
  }

  // Green+blue blobs — hues absent from skin/brick/wood/paper backgrounds.
  function findColorAnchors(cv, mat, imgArea) {
    const rgb = new cv.Mat();
    cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 70, 45, 0]);
    const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [135, 255, 255, 0]);
    const mask = new cv.Mat();
    cv.inRange(hsv, lo, hi, mask);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN,
      cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));

    const cnts = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(mask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const anchors = [];
    for (let i = 0; i < cnts.size(); i++) {
      const cnt = cnts.get(i);
      const area = cv.contourArea(cnt);
      const r = cv.boundingRect(cnt);
      const ar = r.width / r.height;
      const fill = area / (r.width * r.height);
      if (area > imgArea * 0.0004 && area < imgArea * 0.05 &&
          ar > 0.3 && ar < 3.2 && fill > 0.45) {
        anchors.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: Math.min(r.width, r.height), rect: r });
      }
      cnt.delete();
    }
    rgb.delete(); hsv.delete(); lo.delete(); hi.delete();
    mask.delete(); cnts.delete(); hier.delete();
    return anchors;
  }

  function pickCubeCluster(anchors) {
    const n = anchors.length;
    if (!n) return null;
    const sides = anchors.map((a) => a.side).sort((x, y) => x - y);
    const med = sides[n >> 1] || 20;
    const par = anchors.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(anchors[i].cx - anchors[j].cx, anchors[i].cy - anchors[j].cy);
        if (d < med * 4) par[find(i)] = find(j);
      }
    }
    const groups = {};
    anchors.forEach((a, i) => { const r = find(i); (groups[r] = groups[r] || []).push(a); });
    return Object.values(groups).sort((a, b) => b.length - a.length)[0];
  }

  function squaredBBox(cluster, W, H, pad) {
    if (pad == null) pad = 0.10;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of cluster) {
      minX = Math.min(minX, a.rect.x); minY = Math.min(minY, a.rect.y);
      maxX = Math.max(maxX, a.rect.x + a.rect.width); maxY = Math.max(maxY, a.rect.y + a.rect.height);
    }
    const rw = (maxX - minX) * (1 + 2 * pad), rh = (maxY - minY) * (1 + 2 * pad);
    const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
    const sz = Math.max(rw, rh);
    let x = Math.max(0, Math.min(cX - sz / 2, W - sz));
    let y = Math.max(0, Math.min(cY - sz / 2, H - sz));
    return { x, y, w: sz, h: sz };
  }

  // Order 4 arbitrary points into [TL, TR, BR, BL] (standard sum/diff trick).
  function orderCorners(pts) {
    const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
    const tl = bySum[0], br = bySum[3];
    const byDiff = [...pts].sort((a, b) => (a.x - a.y) - (b.x - b.y));
    const bl = byDiff[0], tr = byDiff[3];
    return [tl, tr, br, bl];
  }

  // Sample a face from 4 user-clicked corners (full-res coords) by warping the
  // quad to a square with a perspective transform, then reading the 3x3. Works
  // for any angle/perspective. Returns a face {cells, detected} + the ordered
  // corners used.
  function sampleQuad(cv, src, corners) {
    const o = orderCorners(corners);
    const S = 300;
    const srcTri = cv.matFromArray(4, 1, cv.CV_32FC2,
      [o[0].x, o[0].y, o[1].x, o[1].y, o[2].x, o[2].y, o[3].x, o[3].y]);
    const dstTri = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, S, 0, S, S, 0, S]);
    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(S, S), cv.INTER_AREA, cv.BORDER_REPLICATE, new cv.Scalar());
    const face = sampleGrid(warped, { x: 0, y: 0, w: S, h: S }, true);
    face.corners = o;
    srcTri.delete(); dstTri.delete(); M.delete(); warped.delete();
    return face;
  }

  // Main entry. `src` is a full-resolution RGBA cv.Mat. Returns the detected
  // face + region/anchors expressed in `src` (full-resolution) coordinates,
  // so the caller can overlay them on the original image at any display scale.
  function detectCube(cv, src) {
    const W0 = src.cols, H0 = src.rows;
    // Resize to a fixed working width so detection is deterministic.
    const scale = WORK_WIDTH / W0;
    const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale));
    const work = new cv.Mat();
    cv.resize(src, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const imgArea = W * H;

    // Method A — all vivid sticker squares + grid. Robust on clean cubes:
    // most of the 9 stickers are found, so the bounding box is stable even if
    // a couple of stickers drop in/out across browsers' JPEG decoding.
    const squares = findStickerSquares(cv, work, imgArea);
    const sqClusters = clusterStickers(squares, true);
    const sqBest = sqClusters[0] || [];

    // Method B — green/blue anchors. Fallback for small cubes on busy/warm
    // backgrounds (brick, wood) where Method A can't isolate clean squares.
    let method, regionW, confident, overlayBoxes;
    if (sqBest.length >= 5) {
      regionW = squaredBBox(sqBest, W, H, 0.04); // stickers already span the face
      confident = true; method = "stickers"; overlayBoxes = sqBest;
    } else {
      const anchors = findColorAnchors(cv, work, imgArea);
      const cluster = pickCubeCluster(anchors);
      if (cluster && cluster.length) {
        regionW = squaredBBox(cluster, W, H, 0.10);
        confident = true; method = "green/blue"; overlayBoxes = cluster;
      } else {
        regionW = { x: W * 0.2, y: H * 0.2, w: W * 0.6, h: H * 0.6 };
        confident = false; method = "center-crop"; overlayBoxes = [];
      }
    }
    const stickerCount = overlayBoxes.length;

    // Sample colors on the work image (already at processing resolution).
    const face = sampleGrid(work, regionW, confident);

    // Scale geometry back to full-resolution coordinates for the overlay.
    const inv = 1 / scale;
    const region = { x: regionW.x * inv, y: regionW.y * inv, w: regionW.w * inv, h: regionW.h * inv };
    const clusterSrc = overlayBoxes.map((a) => ({
      rect: { x: a.rect.x * inv, y: a.rect.y * inv, width: a.rect.width * inv, height: a.rect.height * inv },
    }));
    face.region = region;
    face.stickerCount = stickerCount;
    work.delete();

    return {
      face, region, confident, method,
      cluster: clusterSrc,
      stickerCount,
      squareCount: squares.length,
      workSize: { w: W, h: H },
    };
  }

  return { detectCube, sampleQuad, orderCorners, classifyColor, sampleGrid, cellColor, findStickerSquares, clusterStickers, findColorAnchors, pickCubeCluster, squaredBBox, COLORS, WORK_WIDTH };
});
