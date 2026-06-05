/* Rubik's Cube face detector — SHARED by the browser (app.js) and the Node
 * test harness. No DOM access here: every function takes an OpenCV.js `cv`
 * instance and/or a cv.Mat and returns plain data. This guarantees the browser
 * and the tests run byte-for-byte the same detection code.
 *
 * Determinism: detectCube() resizes the input to a FIXED working width before
 * doing anything, so the result no longer depends on the display/source size.
 *
 * Public API (JSDoc on each):
 *   detectCube(cv, src)                   → single face, region/grid/anchor/crop
 *   detectFaces(cv, src, opts?)           → multi-face sticker-based detector
 *   detectFacesGeometric(cv, src, opts?)  → multi-face geometric/silhouette detector
 *   facesFromWireframe(cv, src, wf)       → 3 quads from editable {near, ring[6], sideStart}
 *   readFaceQuad(cv, src, quad)           → 3×3 read of a 4-corner quad
 *   sampleQuad(cv, src, corners)          → perspective-warp + 3×3 read
 *   orderCorners(pts)                     → [TL,TR,BR,BL] from 4 unordered points
 *   classifyColor(r,g,b)                  → 'W' | 'Y' | 'R' | 'O' | 'G' | 'B'
 *   COLORS, WORK_WIDTH                    → constants
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RubikDetector = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // ---- Constants ----
  const WORK_WIDTH = 600;   // fixed internal processing width for detectCube/detectFaces
  const GEO_WORK   = 900;   // geometric path needs more silhouette precision
  const WARP_SIZE  = 300;   // pixels along each side of a perspective-warped face
  const SAMPLE_STD_TOLERANCE = 8; // px — cell-centre tolerance for "structural" tests

  // All magic numbers, hoisted. Tweaking a threshold is a one-line edit here.
  const T = {
    // findStickerSquares
    sticker: {
      areaFrac: [0.0005, 0.03],   // [min, max] as fraction of image area
      polyEpsilonK: 0.06,         // approxPolyDP epsilon = k * perimeter
      minFill: 0.6,                // contour fill ratio (area / bbox area)
      // 3.5 catches tall/narrow stickers on a strongly angled cube's left/right
      // face (e.g. a 25x80 px sticker in projection has minAreaRect aspect ≈
      // 3.2). At ≤2.0 we'd drop most of the top/left face on a 3D-tilted shot.
      maxAspect: 3.5,              // max(w, h) / min(w, h)
      thresholdBlocks: [41, 61, 81], // multi-scale adaptive threshold block sizes
      dedupDistK: 0.5,            // dedup radius = side * k
    },
    // findStickerSquares vivid HSV pass (recovers saturated stickers)
    vividHsv: { lo: [0, 90, 60, 0],   hi: [180, 255, 255, 0] },
    // findColorAnchors — green+blue blobs (absent from skin/brick/wood)
    anchor: {
      hsvLo: [40, 70, 45, 0],
      hsvHi: [135, 255, 255, 0],
      areaFrac: [0.0004, 0.05],
      aspect: [0.3, 3.2],
      minFill: 0.45,
      clusterDistK: 4,            // cluster distance = median_side * k
    },
    // squaredBBox
    pad: { crop: 0.20, cluster: 0.04, anchor: 0.10 },
    // clusterStickers
    cluster: {
      minSizeRatio: 0.55,         // min(side)/max(side) of two stickers to be similar
      proximityK: 1.8,            // neighbour distance = max(side) * k
    },
    // fitGrid
    grid: {
      borderK: 0.55,              // face-corner extrapolation = avgSide * k
      spacingRatioMin: 0.2,       // min(outer gaps) / max(outer gaps) — uniformity check
    },
    // splitByOrientation
    split: { minClusterSide: 1.3 }, // gap / median_side must exceed this to split
    // detectFacesGeometric — saturation seed for GrabCut
    satHsv: { lo: [0, 150, 60, 0], hi: [180, 255, 255, 0] },
    silhouette: { modelArea: [0.01, 0.85], grabcutArea: [0.02, 0.6], minCubeAreaFrac: 0.03 },
    approxPoly: { epsilons: [0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.08] },
    edgeSnap: { samples: 24, range: 20, minPeak: 20 },
    // solveCubePose
    pnp: { focal: [0.6, 1.0, 1.6], maxReprojFrac: 0.06 },
    // altScore
    altScoreSize: 180,
  };

  // ---- RAII for cv.Mat (which has no JS GC; .delete() releases the WASM heap) ----
  // Use withMats(cv, fn) to ensure every Mat created during fn() is .delete()d
  // in a finally block. Escape hatch: any Mat passed *into* the function is
  // owned by the caller and is NOT deleted.
  function withMats(cv, fn) {
    const tracked = new Set();
    const orig = cv.Mat.bind(cv);
    cv.Mat = function (...a) { const m = new orig(...a); tracked.add(m); return m; };
    try { return fn(); }
    finally { cv.Mat = orig; for (const m of tracked) { try { m.delete(); } catch (_) {} } }
  }

  // Convert any cv.Mat (1/3/4 channel) to {name,width,height,data:RGBA} for the
  // app's debug panel. Copies pixels out, so it's safe after the Mat is freed.
  function matToDebug(cv, mat, name) {
    const W = mat.cols, H = mat.rows, ch = mat.channels(), src = mat.data;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      if (ch === 1) { const v = src[i]; data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; }
      else if (ch === 4) { data[i * 4] = src[i * 4]; data[i * 4 + 1] = src[i * 4 + 1]; data[i * 4 + 2] = src[i * 4 + 2]; }
      else { data[i * 4] = src[i * 3]; data[i * 4 + 1] = src[i * 3 + 1]; data[i * 4 + 2] = src[i * 3 + 2]; }
      data[i * 4 + 3] = 255;
    }
    return { name, width: W, height: H, data };
  }

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

  // Detect cube stickers as bright CELLS bounded by the black grid. Uses
  // adaptive thresholding (local contrast) so it keys on the black borders, not
  // sticker color — this catches white stickers and glare-blown ones that a
  // color mask misses, and a multi-scale sweep handles perspective size change.
  // Each sticker carries its true quad corners + edge unit-vectors (from
  // approxPolyDP, NOT minAreaRect — the bounding box hides per-face shear).
  function findStickerSquares(cv, mat, imgArea) {
    return withMats(cv, () => {
      const gray = new cv.Mat(); cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      const k3 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
      const raw = [];

      const harvest = (bin) => {
        const cnts = new cv.MatVector(); const hier = new cv.Mat();
        cv.findContours(bin, cnts, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < cnts.size(); i++) {
          const c = cnts.get(i); const area = cv.contourArea(c);
          if (area < imgArea * T.sticker.areaFrac[0] || area > imgArea * T.sticker.areaFrac[1]) { c.delete(); continue; }
          const peri = cv.arcLength(c, true);
          const ap = new cv.Mat(); cv.approxPolyDP(c, ap, T.sticker.polyEpsilonK * peri, true);
          const ok4 = ap.rows === 4 && cv.isContourConvex(ap);
          const rr = cv.minAreaRect(c); const w = rr.size.width, h = rr.size.height;
          const fill = area / Math.max(1, w * h), aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
          if (ok4 && fill > T.sticker.minFill && aspect < T.sticker.maxAspect) {
            const P = []; for (let j = 0; j < 4; j++) P.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
            const cx = (P[0].x + P[1].x + P[2].x + P[3].x) / 4, cy = (P[0].y + P[1].y + P[2].y + P[3].y) / 4;
            const r = cv.boundingRect(c);
            const nrm = (v) => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m }; };
            raw.push({
              cx, cy, side: (w + h) / 2, rect: r, corners: P,
              e1: nrm({ x: P[1].x - P[0].x, y: P[1].y - P[0].y }),
              e2: nrm({ x: P[2].x - P[1].x, y: P[2].y - P[1].y }),
            });
          }
          ap.delete(); c.delete();
        }
        cnts.delete(); hier.delete();
      };

      for (const bs of T.sticker.thresholdBlocks) {              // multi-scale black-grid threshold
        const th = new cv.Mat();
        cv.adaptiveThreshold(gray, th, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, bs, 9);
        cv.morphologyEx(th, th, cv.MORPH_OPEN, k3);
        harvest(th); th.delete();
      }
      { // also vivid color blobs — recovers saturated stickers the grid threshold merges
        const rgb = new cv.Mat(); cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
        const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
        const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.vividHsv.lo);
        const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.vividHsv.hi);
        const m = new cv.Mat(); cv.inRange(hsv, lo, hi, m); cv.morphologyEx(m, m, cv.MORPH_OPEN, k3);
        harvest(m);
        rgb.delete(); hsv.delete(); lo.delete(); hi.delete(); m.delete();
      }

      // dedup overlapping detections (keep larger)
      raw.sort((a, b) => b.side - a.side);
      const st = [];
      for (const q of raw) if (!st.some((d) => Math.hypot(d.cx - q.cx, d.cy - q.cy) < d.side * T.sticker.dedupDistK)) st.push(q);
      gray.delete(); k3.delete();
      return st;
    });
  }

  // Cluster stickers by proximity; require similar sizes (real sticker
  // squares are all about the same size; bg noise is not).
  function clusterStickers(items) {
    const n = items.length;
    if (!n) return [];
    const sides = items.map((s) => s.side).sort((a, b) => a - b);
    const med = sides[n >> 1] || 20;
    const par = items.map((_, i) => i);
    const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = items[i], b = items[j], bg = Math.max(a.side, b.side);
        if (Math.min(a.side, b.side) / bg > T.cluster.minSizeRatio &&
            Math.hypot(a.cx - b.cx, a.cy - b.cy) < bg * T.cluster.proximityK) par[find(i)] = find(j);
      }
    }
    const g = {};
    items.forEach((s, i) => { const r = find(i); (g[r] = g[r] || []).push(s); });
    return Object.values(g).sort((a, b) => b.length - a.length);
  }

  // Green+blue blobs — hues absent from skin/brick/wood/paper backgrounds.
  function findColorAnchors(cv, mat, imgArea) {
    return withMats(cv, () => {
      const rgb = new cv.Mat();
      cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
      const hsv = new cv.Mat();
      cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
      const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.anchor.hsvLo);
      const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.anchor.hsvHi);
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
        if (area > imgArea * T.anchor.areaFrac[0] && area < imgArea * T.anchor.areaFrac[1] &&
            ar > T.anchor.aspect[0] && ar < T.anchor.aspect[1] && fill > T.anchor.minFill) {
          anchors.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: Math.min(r.width, r.height), rect: r });
        }
        cnt.delete();
      }
      cnts.delete(); hier.delete();
      return anchors;
    });
  }

  // Pick the largest cluster of color anchors (= the cube). Returns the
  // cluster directly, not an array of clusters.
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
        if (d < med * T.anchor.clusterDistK) par[find(i)] = find(j);
      }
    }
    const groups = {};
    anchors.forEach((a, i) => { const r = find(i); (groups[r] = groups[r] || []).push(a); });
    return Object.values(groups).sort((a, b) => b.length - a.length)[0];
  }

  function squaredBBox(cluster, W, H, pad) {
    if (pad == null) pad = T.pad.anchor;
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

  // ---- PCA-based 3×3 grid fitting ----
  //
  // Given a cluster of stickers from a single cube face, reconstruct the 3×3
  // grid using PCA to find the two grid axes, project stickers onto them,
  // cluster into 3×3 positions, and extrapolate face corners. Works with 7+
  // stickers even under perspective distortion.

  // Fit a 3×3 grid to a cluster of stickers. Returns { corners } or null.
  // Uses nearest-neighbor direction analysis (not raw-position PCA, which
  // finds the diagonal of a square grid instead of the axes).
  function fitGrid(stickers) {
    const n = stickers.length;
    if (n < 5) return null;

    // 1. Compute centroid
    let mx = 0, my = 0;
    for (const s of stickers) { mx += s.cx; my += s.cy; }
    mx /= n; my /= n;

    // 2. Find the two grid axes. We have two candidate sources:
    //    (a) PCA on nearest-neighbour direction vectors — finds the
    //        parallelogram DIAGONALS for a tilted face (not the row/col
    //        sides), which puts the (u,v) grid's corners at the diagonal
    //        extremes rather than the face corners.
    //    (b) the stickers' OWN edge vectors e1, e2 (set in
    //        findStickerSquares from each sticker's approxPolyDP corners).
    //        These are the 2D projections of the sticker's grid-aligned
    //        edges, so the AVERAGE e1/e2 across the cluster IS the
    //        face's row/column direction. For a tilted 3-face cube the
    //        9 red stickers' averaged e1 points along the red face's row
    //        direction — using it as the (u) axis puts the warped grid
    //        exactly on the face. e2 is used for the (v) axis.
    //
    //    We average e1/e2 with sign-correction against the first
    //    sticker's e1/e2: a sticker whose e1 points opposite to the
    //    first is flipped (and its e2 is flipped too — both belong to
    //    the same face coordinate frame). If the average has too small
    //    a magnitude the e1/e2 source is inconsistent for this cluster
    //    and we fall back to PCA.
    const ref = stickers[0];
    let e1xSum = 0, e1ySum = 0, e2xSum = 0, e2ySum = 0, eCount = 0;
    if (ref && ref.e1 && ref.e2) {
      for (const s of stickers) {
        if (!s.e1 || !s.e2) continue;
        let e1x = s.e1.x, e1y = s.e1.y;
        let e2x = s.e2.x, e2y = s.e2.y;
        if (e1x * ref.e1.x + e1y * ref.e1.y < 0) {
          e1x = -e1x; e1y = -e1y; e2x = -e2x; e2y = -e2y;
        }
        e1xSum += e1x; e1ySum += e1y; e2xSum += e2x; e2ySum += e2y;
        eCount++;
      }
    }
    let ax1x, ax1y, ax2x, ax2y;
    const e1Mag = eCount ? Math.hypot(e1xSum, e1ySum) / eCount : 0;
    if (eCount >= 5 && e1Mag > 0.5) {
      // Stickers' e1/e2 are consistent — use them as the (u,v) axes.
      ax1x = e1xSum / eCount; ax1y = e1ySum / eCount;
      ax2x = e2xSum / eCount; ax2y = e2ySum / eCount;
      const a1n = Math.hypot(ax1x, ax1y) || 1;
      ax1x /= a1n; ax1y /= a1n;
      const a2n = Math.hypot(ax2x, ax2y) || 1;
      ax2x /= a2n; ax2y /= a2n;
    } else {
      // Fallback: PCA on nearest-neighbour direction vectors. For a
      // 3x3 grid, nearest-neighbour directions point along the rows
      // and columns, so PCA recovers the axes (modulo the diagonal
      // issue for tilted faces — accepted as a best-effort fallback
      // when the e1/e2 source is unusable).
      const vecs = [];
      for (let i = 0; i < n; i++) {
        let bestD = Infinity, bestS = null;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const d = Math.hypot(stickers[i].cx - stickers[j].cx, stickers[i].cy - stickers[j].cy);
          if (d < bestD) { bestD = d; bestS = stickers[j]; }
        }
        if (!bestS) continue;
        const dx = bestS.cx - stickers[i].cx, dy = bestS.cy - stickers[i].cy;
        const len = Math.hypot(dx, dy);
        if (len > 0) vecs.push({ x: dx / len, y: dy / len });
      }
      if (vecs.length < 4) return null;
      let vxx = 0, vxy = 0, vyy = 0;
      for (const v of vecs) { vxx += v.x * v.x; vxy += v.x * v.y; vyy += v.y * v.y; }
      const vtrace = vxx + vyy;
      const vdet = vxx * vyy - vxy * vxy;
      const vdisc = Math.sqrt(Math.max(0, vtrace * vtrace / 4 - vdet));
      const vlam1 = vtrace / 2 + vdisc;
      if (Math.abs(vxy) > 1e-6) {
        ax1x = vxy; ax1y = vlam1 - vxx;
      } else {
        ax1x = vxx >= vyy ? 1 : 0; ax1y = vxx >= vyy ? 0 : 1;
      }
      const vnorm = Math.hypot(ax1x, ax1y);
      if (vnorm < 1e-6) return null;
      ax1x /= vnorm; ax1y /= vnorm;
      ax2x = -ax1y; ax2y = ax1x;
    }

    // 3. Project stickers onto both axes
    const proj = stickers.map((s) => ({
      sticker: s,
      u: (s.cx - mx) * ax1x + (s.cy - my) * ax1y,
      v: (s.cx - mx) * ax2x + (s.cy - my) * ax2y,
    }));

    // 4. Cluster projections into 3 groups along each axis. The previous
    //    implementation split at the 2 largest gaps, but on a tilted
    //    face's 9 stickers the 2 largest v-gaps are at the row extremes
    //    (e.g. 87/54 instead of the true 68/71) and the split gives
    //    6+2+1 instead of 3+3+3 — the grid's extrapolation then drifts
    //    off the face. 1D k-means finds the 3 evenly-spaced centres
    //    robustly for any sticker arrangement.
    function kmeans1D(values, k) {
      if (values.length < k) return null;
      const sorted = [...values].sort((a, b) => a - b);
      const span = sorted[sorted.length - 1] - sorted[0] || 1;
      let centers = [];
      for (let i = 0; i < k; i++) centers.push(sorted[0] + span * (i + 1) / (k + 1));
      const assign = new Array(sorted.length).fill(0);
      for (let it = 0; it < 20; it++) {
        let changed = false;
        for (let i = 0; i < sorted.length; i++) {
          let best = 0, bestD = Infinity;
          for (let c = 0; c < k; c++) { const d = Math.abs(sorted[i] - centers[c]); if (d < bestD) { bestD = d; best = c; } }
          if (assign[i] !== best) { assign[i] = best; changed = true; }
        }
        const sums = Array.from({ length: k }, () => ({ s: 0, n: 0 }));
        for (let i = 0; i < sorted.length; i++) { sums[assign[i]].s += sorted[i]; sums[assign[i]].n++; }
        for (let c = 0; c < k; c++) if (sums[c].n) centers[c] = sums[c].s / sums[c].n;
        if (!changed) break;
      }
      centers.sort((a, b) => a - b);
      return { centers, assign };
    }
    function cluster3(items, key) {
      const values = items.map((it) => it[key]);
      const km = kmeans1D(values, 3);
      if (!km) return null;
      // Reconstruct the 3 groups in the same order as the input items.
      // The kmeans indices are over the SORTED values; map back via the
      // original index on each item so we can return the items themselves.
      const sortedIdx = items.map((_, i) => i).sort((a, b) => items[a][key] - items[b][key]);
      const groups = Array.from({ length: 3 }, () => []);
      for (let s = 0; s < sortedIdx.length; s++) {
        groups[km.assign[s]].push(items[sortedIdx[s]]);
      }
      return groups;
    }

    // The previous 1D k-means on u and v projections separately found wrong
    // centres for a tilted face: the 9 v-projections don't form 3 evenly-
    // spaced clusters (rows overlap in v when the face is sheared by
    // perspective), so k-means converges to a local minimum that's even
    // further from the true row/col means. Replacing with a deterministic
    // sort-and-group:
    //  - rows: sort the 9 stickers by v (perpendicular to the row
    //    direction), group by 3. The 3 row means are then the v-means
    //    of each group — exact, no clustering ambiguity.
    //  - cols: for each row, sort its 3 stickers by u to assign column
    //    index; the col means are then the u-means across all 3 rows.
    const rowGroups = (() => {
      const sorted = [...proj].sort((a, b) => a.v - b.v);
      return [sorted.slice(0, 3), sorted.slice(3, 6), sorted.slice(6, 9)];
    })();
    if (!rowGroups.every((g) => g.length === 3)) return null;
    const colGroups = [[], [], []];
    for (const row of rowGroups) {
      const sortedRow = [...row].sort((a, b) => a.u - b.u);
      for (let c = 0; c < 3; c++) colGroups[c].push(sortedRow[c]);
    }
    if (!colGroups.every((g) => g.length === 3)) return null;

    // 5. Validate: every group should be non-empty (always true here, but
    // keep the guard so a refactor doesn't silently produce a null group).
    if (!colGroups.every((g) => g.length) || !rowGroups.every((g) => g.length)) return null;

    // 6. Compute group centers
    const colCenters = colGroups.map((g) => g.reduce((s, p) => s + p.u, 0) / g.length);
    const rowCenters = rowGroups.map((g) => g.reduce((s, p) => s + p.v, 0) / g.length);

    if (colCenters.some((c) => !Number.isFinite(c)) || rowCenters.some((c) => !Number.isFinite(c))) return null;

    // 7. Validate spacing uniformity
    const colGaps = [colCenters[1] - colCenters[0], colCenters[2] - colCenters[1]];
    const rowGaps = [rowCenters[1] - rowCenters[0], rowCenters[2] - rowCenters[1]];
    if (Math.min(...colGaps) / Math.max(...colGaps) < T.grid.spacingRatioMin) return null;
    if (Math.min(...rowGaps) / Math.max(...rowGaps) < T.grid.spacingRatioMin) return null;

    // 8. Compute face corners: extrapolate from outer grid positions. The
    //    border is a FRACTION OF THE FACE SPAN, not a multiple of sticker
    //    side — a tilted face's colSpan in (u,v) space is compressed by
    //    perspective (often < 2*avgSide), so the old `0.55 * avgSide`
    //    pushed the grid past the face boundary and the warped cell read
    //    across the seam. Spanning 1/4 of the face on each side puts the
    //    cell centres exactly on the outer sticker centres (the cell
    //    grid is at 1/6, 1/2, 5/6 of the quad, and 1/6 of (span+2*span/4)
    //    = 1/6*1.5*span = span/4 past the corner = the outer sticker
    //    centre).
    const colSpan = colCenters[2] - colCenters[0];
    const rowSpan = rowCenters[2] - rowCenters[0];
    const borderU = colSpan / 4;
    const borderV = rowSpan / 4;
    const cornersUV = [
      { u: colCenters[0] - borderU, v: rowCenters[0] - borderV },
      { u: colCenters[2] + borderU, v: rowCenters[0] - borderV },
      { u: colCenters[2] + borderU, v: rowCenters[2] + borderV },
      { u: colCenters[0] - borderU, v: rowCenters[2] + borderV },
    ];
    const corners = cornersUV.map((c) => ({
      x: mx + c.u * ax1x + c.v * ax2x,
      y: my + c.u * ax1y + c.v * ax2y,
    }));

    return { corners, colCenters, rowCenters, ax1x, ax1y, ax2x, ax2y, mx, my };
  }

  // Split a cluster that merges two adjacent faces. Two visible faces of an
  // angled cube sit side-by-side along the shared (seam) edge; in projection
  // their lattices are nearly parallel but spatially offset along the axis that
  // crosses the seam. So: take the dominant sticker-edge direction, project all
  // sticker centers onto the perpendicular (seam-crossing) axis, and 1D-2-means
  // that projection. The gap at the seam separates the faces.
  function splitByOrientation(stickers) {
    const n = stickers.length;
    if (n < 6) return [stickers];

    // Candidate split axes: the median of e1 angles AND the median of e1+90°.
    // Two faces sharing an edge have stickers with edges parallel AND
    // perpendicular to the shared edge — so the cluster's edge-direction
    // histogram is bimodal. Using the median of ONE edge direction gives a
    // perpendicular split axis that may or may not cross the seam; trying
    // both orientations of the median and picking the one with the larger
    // normalized gap is robust to which one happens to be the seam axis.
    const angsRaw = stickers.map((s) => {
      let a = Math.atan2((s.e1 ? s.e1.y : 0), (s.e1 ? s.e1.x : 1)) * 180 / Math.PI;
      return ((a % 180) + 180) % 180;
    }).sort((a, b) => a - b);
    const thA = (angsRaw[n >> 1] || 0) * Math.PI / 180;
    const thB = thA + Math.PI / 2;
    const tryAxis = (th) => {
      // seam-crossing axis = perpendicular to candidate edge direction
      const px = -Math.sin(th), py = Math.cos(th);
      const proj = stickers.map((s) => s.cx * px + s.cy * py);
      let c0 = Math.min(...proj), c1 = Math.max(...proj);
      if (c1 - c0 < 1e-3) return null;
      let assign = proj.map(() => 0);
      for (let it = 0; it < 25; it++) {
        assign = proj.map((p) => (Math.abs(p - c0) <= Math.abs(p - c1) ? 0 : 1));
        const g0 = proj.filter((_, i) => assign[i] === 0), g1 = proj.filter((_, i) => assign[i] === 1);
        const n0 = g0.length ? g0.reduce((a, b) => a + b) / g0.length : c0;
        const n1 = g1.length ? g1.reduce((a, b) => a + b) / g1.length : c1;
        if (Math.abs(n0 - c0) < 0.01 && Math.abs(n1 - c1) < 0.01) { c0 = n0; c1 = n1; break; }
        c0 = n0; c1 = n1;
      }
      const A = stickers.filter((_, i) => assign[i] === 0);
      const B = stickers.filter((_, i) => assign[i] === 1);
      if (A.length < 4 || B.length < 4) return null;
      // Score: gap / sticker pitch. A real seam produces a gap comparable
      // to the sticker pitch; partial occlusion / a tilted angle that
      // happened to align with the candidate axis produces a small gap.
      const side = stickers.map((s) => s.side).sort((a, b) => a - b)[n >> 1] || 30;
      const gap = Math.abs(c1 - c0);
      if (gap < side * T.split.minClusterSide) return null;
      return { A, B, score: gap / side };
    };

    const cand = [tryAxis(thA), tryAxis(thB)].filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (!cand.length) return [stickers];
    return [cand[0].A, cand[0].B];
  }

  // 2D k-means with multiple restarts. Returns an array of clusters (each
  // a sub-array of the input points). Used to split a multi-face cluster
  // into K groups in one shot, sidestepping the chained-2-means problem
  // where the first split's axis hides the second seam.
  //
  // Deterministic: uses a seeded mulberry32 PRNG instead of Math.random so
  // the same input gives the same split on every run. The detector must
  // be deterministic for the regression tests to be reliable.
  function kmeans2D(points, k, iters) {
    const n = points.length;
    if (n < k * 2) return [points];
    // mulberry32 — small, fast, good enough for kmeans seeding.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let bestLabels = null, bestSSE = Infinity;
    for (let restart = 0; restart < 4; restart++) {
      const cents = [];
      if (restart === 0) {
        // median of points — stable across images, immune to a few
        // far-out background-noise stickers.
        const sxs = points.map((p) => p.cx).sort((a, b) => a - b);
        const sys = points.map((p) => p.cy).sort((a, b) => a - b);
        cents.push({ cx: sxs[n >> 1], cy: sys[n >> 1] });
      } else {
        cents.push(points[Math.floor(rand() * n)]);
      }
      while (cents.length < k) {
        const d2 = points.map((p) => {
          let best = Infinity;
          for (const c of cents) { const dx = p.cx - c.cx, dy = p.cy - c.cy; const dd = dx * dx + dy * dy; if (dd < best) best = dd; }
          return best;
        });
        const sum = d2.reduce((a, b) => a + b, 0) || 1;
        let r = rand() * sum;
        let pick = 0;
        for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
        cents.push({ cx: points[pick].cx, cy: points[pick].cy });
      }
      // 2) Lloyd iterations
      const labels = new Array(n).fill(0);
      for (let it = 0; it < (iters || 25); it++) {
        let changed = false;
        for (let i = 0; i < n; i++) {
          let best = 0, bestD = Infinity;
          for (let c = 0; c < k; c++) { const dx = points[i].cx - cents[c].cx, dy = points[i].cy - cents[c].cy; const dd = dx * dx + dy * dy; if (dd < bestD) { bestD = dd; best = c; } }
          if (labels[i] !== best) { labels[i] = best; changed = true; }
        }
        const sums = Array.from({ length: k }, () => ({ sx: 0, sy: 0, n: 0 }));
        for (let i = 0; i < n; i++) { sums[labels[i]].sx += points[i].cx; sums[labels[i]].sy += points[i].cy; sums[labels[i]].n++; }
        for (let c = 0; c < k; c++) if (sums[c].n) { cents[c] = { cx: sums[c].sx / sums[c].n, cy: sums[c].sy / sums[c].n }; }
        if (!changed) break;
      }
      // 3) Score this restart
      let sse = 0;
      for (let i = 0; i < n; i++) { const c = cents[labels[i]]; sse += (points[i].cx - c.cx) ** 2 + (points[i].cy - c.cy) ** 2; }
      if (sse < bestSSE) { bestSSE = sse; bestLabels = labels.slice(); }
    }
    const out = Array.from({ length: k }, () => []);
    for (let i = 0; i < n; i++) out[bestLabels[i]].push(points[i]);
    return out;
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
  //
  // Detection priority:
  //  Method 1 (grid): PCA-based 3×3 grid reconstruction from stickers.
  //    Works for angled/perspective shots with 5+ stickers.
  //  Method 2 (stickers): cluster by proximity + bounding box (original Method A).
  //  Method 3 (green/blue): anchor-based localization (original Method B).
  //  Method 4 (center-crop): last resort, low confidence.
  function detectCube(cv, src) {
    const W0 = src.cols, H0 = src.rows;
    const scale = WORK_WIDTH / W0;
    const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale));
    const work = new cv.Mat();
    cv.resize(src, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const imgArea = W * H;
    const inv = 1 / scale;

    const squares = findStickerSquares(cv, work, imgArea);

    // Method 1 — PCA grid reconstruction from sticker clusters
    // Try to fit a grid from the detected stickers directly.
    //
    // IMPORTANT: a >9-sticker cluster is multiple faces merged. fitGrid's PCA
    // axes then point along the cluster's bounding-box diagonal (not a face
    // grid axis) and the 4 corner-extrapolation lands them off-screen. The
    // detectFaces path already handles this by ALWAYS splitting >9 clusters
    // first; mirror that here, plus a kmeans-3 path for big (>14) clusters
    // (catches the 3-face angled-cube case in one shot). Then for every
    // candidate cluster, FILTER by its dominant sticker color — a 3-face
    // solved cube produces 3 spatial regions each containing two colors (the
    // shared row with the neighbour face), and a grid fit on the mixed
    // cluster extrapolates past the face boundary. Filtering to the
    // dominant color gives a clean 7–9 sticker single-face cluster. Finally
    // reject any grid whose corners are outside the image — degenerate fits
    // produce corners hundreds of px past the edge and the warped sample
    // then reads across face boundaries.
    const cornersInBounds = (grid) => {
      for (const c of grid.corners) {
        if (c.x < 0 || c.x > W || c.y < 0 || c.y > H) return false;
      }
      return true;
    };
    // Sample the work image at each sticker's center and bin to a face
    // colour code. Used to split mixed-color clusters into single-face
    // subgroups (a >9 cluster from 3 visible faces contains 2 colors per
    // spatial region because each region shares an edge row with a
    // neighbour face).
    const wd = work.data;
    const codeOf = (s) => {
      const x = Math.max(0, Math.min(W - 1, Math.round(s.cx)));
      const y = Math.max(0, Math.min(H - 1, Math.round(s.cy)));
      const i = (y * W + x) * 4;
      return classifyColor(wd[i], wd[i + 1], wd[i + 2]);
    };
    // Group stickers by their center colour. For a solved 3-face cube the
    // resulting groups ARE the faces (the red face is the 9 red stickers,
    // no spatial split needed), so this is the strongest signal and
    // should run before kmeans. Returned sorted by count desc so we try
    // the best-populated group first.
    const colorGroup = (stk) => {
      const buckets = {};
      for (const s of stk) {
        const c = codeOf(s);
        (buckets[c] = buckets[c] || []).push(s);
      }
      return Object.values(buckets).filter((g) => g.length >= 5)
        .sort((a, b) => b.length - a.length);
    };
    const tryFit = (stk) => {
      const g = fitGrid(stk);
      const grid = fitGrid(stk);
      return grid && cornersInBounds(grid) ? grid : null;
    };
    const trySplit = (cluster, depth) => {
      if (cluster.length < 5) return null;
      if (depth > 3) return tryFit(cluster);
      if (cluster.length > 9) {
        // Big-enough cluster: try COLOR-GROUPING first (solved cubes).
        // This is the strongest signal when each face is a single colour
        // — the red face is the 9 red stickers with no spatial ambiguity,
        // and the fit has zero extrapolation. Run before kmeans so solved
        // cubes take the fast path.
        for (const g of colorGroup(cluster)) {
          const f = tryFit(g);
          if (f) return f;
        }
        // kmeans-3 split for scrambled cubes (each face has mixed colors,
        // so colour-grouping produces only 1-2 sticker buckets per colour
        // and fails). Each group is one face spatially.
        if (cluster.length >= 14) {
          const groups = kmeans2D(cluster, 3, 30);
          if (groups.length === 3 && groups.every((g) => g.length >= 5)) {
            for (const g of groups) {
              const f = tryFit(g);
              if (f) return f;
            }
          }
        }
        // 2-means split (chained) as a last resort.
        const parts = splitByOrientation(cluster);
        if (parts.length > 1 && parts[0] !== cluster) {
          for (const sub of parts) {
            const f = trySplit(sub, depth + 1);
            if (f) return f;
          }
          return null;
        }
        return tryFit(cluster);
      }
      return tryFit(cluster);
    };
    function tryGridFit(stk, imgScale) {
      if (stk.length < 5) return null;
      const clusters = clusterStickers(stk);
      for (const cluster of clusters) {
        if (cluster.length < 5) continue;
        const grid = trySplit(cluster, 0);
        if (grid) {
          // Scale corners back to full-res
          const iScale = 1 / imgScale;
          const fullCorners = grid.corners.map((c) => ({ x: c.x * iScale, y: c.y * iScale }));
          return { corners: fullCorners, cluster, stickerCount: cluster.length };
        }
      }
      return null;
    }

    let gridResult = tryGridFit(squares, scale);

    // If not enough stickers from the full image, try anchor-guided zoom:
    // find the cube region via green/blue anchors, crop the full-res image
    // to that region (with padding), and re-detect stickers at higher
    // effective resolution. This helps when the cube is small in the image.
    if (!gridResult && squares.length < 5) {
      const anchors = findColorAnchors(cv, work, imgArea);
      const anchorCluster = pickCubeCluster(anchors);
      if (anchorCluster && anchorCluster.length >= 2) {
        const anchorBox = squaredBBox(anchorCluster, W, H, T.pad.crop);
        // Convert to full-res coordinates
        const fx = Math.max(0, Math.round(anchorBox.x * inv));
        const fy = Math.max(0, Math.round(anchorBox.y * inv));
        const fw = Math.min(W0 - fx, Math.round(anchorBox.w * inv));
        const fh = Math.min(H0 - fy, Math.round(anchorBox.h * inv));
        if (fw > 50 && fh > 50) {
          // Wrap the leak-prone crop+resize block in withMats so the
          // intermediate Mats cannot leak on throw.
          withMats(cv, () => {
            const crop = src.roi(new cv.Rect(fx, fy, fw, fh));
            // Detect stickers in the crop at WORK_WIDTH resolution
            const cropScale = WORK_WIDTH / fw;
            const cw = Math.max(1, Math.round(fw * cropScale));
            const ch = Math.max(1, Math.round(fh * cropScale));
            const cropWork = new cv.Mat();
            cv.resize(crop, cropWork, new cv.Size(cw, ch), 0, 0, cv.INTER_AREA);
            const cropSquares = findStickerSquares(cv, cropWork, cw * ch);
            // Adjust sticker coords to full-res (crop coords + crop offset)
            const adjSquares = cropSquares.map((s) => ({
              cx: s.cx / cropScale + fx,
              cy: s.cy / cropScale + fy,
              side: s.side / cropScale,
              rect: { x: s.rect.x / cropScale + fx, y: s.rect.y / cropScale + fy, width: s.rect.width / cropScale, height: s.rect.height / cropScale },
            }));
            // Grid fit uses coords in arbitrary space — pass them as-is and
            // the corners will be in full-res space already
            if (adjSquares.length >= 5) {
              const adjClusters = clusterStickers(adjSquares);
              for (const cluster of adjClusters) {
                if (cluster.length < 5) continue;
                const grid = fitGrid(cluster);
                if (grid) {
                  gridResult = { corners: grid.corners, cluster, stickerCount: cluster.length };
                  break;
                }
              }
            }
          });
        }
      }
    }

    if (gridResult) {
      const face = sampleQuad(cv, src, gridResult.corners);
      const clusterSrc = gridResult.cluster.map((a) => ({
        rect: { x: a.rect.x, y: a.rect.y, width: a.rect.width, height: a.rect.height },
      }));
      face.region = null;
      face.stickerCount = gridResult.stickerCount;
      work.delete();
      return {
        face, region: null, confident: true, method: "grid",
        cluster: clusterSrc, stickerCount: gridResult.stickerCount,
        squareCount: squares.length, workSize: { w: W, h: H },
        corners: gridResult.corners,
      };
    }

    // Method 2 — sticker proximity clustering (original Method A)
    const sqClusters = clusterStickers(squares);
    const sqBest = sqClusters[0] || [];
    let method, regionW, confident, overlayBoxes;
    if (sqBest.length >= 5) {
      regionW = squaredBBox(sqBest, W, H, T.pad.cluster);
      confident = true; method = "stickers"; overlayBoxes = sqBest;
    } else {
      // Method 3 — green/blue anchors
      const anchors = findColorAnchors(cv, work, imgArea);
      const cluster = pickCubeCluster(anchors);
      if (cluster && cluster.length) {
        regionW = squaredBBox(cluster, W, H, 0.10);
        confident = true; method = "green/blue"; overlayBoxes = cluster;
      } else {
        // Method 4 — center crop
        regionW = { x: W * 0.2, y: H * 0.2, w: W * 0.6, h: H * 0.6 };
        confident = false; method = "center-crop"; overlayBoxes = [];
      }
    }
    const stickerCount = overlayBoxes.length;

    const face = sampleGrid(work, regionW, confident);
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

  // Multi-face detection: finds and reads all visible faces.
  function detectFaces(cv, src, opts) {
    const debug = opts && opts.debug;
    const W0 = src.cols, H0 = src.rows;
    const scale = WORK_WIDTH / W0;
    const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale));
    const work = new cv.Mat();
    cv.resize(src, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const imgArea = W * H;
    const inv = 1 / scale;

    if (debug) {
      const gray = new cv.Mat(); cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY); cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
      const th = new cv.Mat(); cv.adaptiveThreshold(gray, th, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 41, 9);
      debug.push(matToDebug(cv, work, "1. Working image"));
      debug.push(matToDebug(cv, th, "2. Sticker grid threshold"));
      gray.delete(); th.delete();
    }

    const stickers = findStickerSquares(cv, work, imgArea);
    if (stickers.length < 5) { work.delete(); return []; }

    // A real cube face shows several distinct colors. Paper grids / desk
    // reflections read as mostly-white with little variety — reject those.
    const isCubeLike = (face) => new Set(face.cells.map((c) => c.code)).size >= 3;

    const results = [];
    const emit = (grid, members) => {
      const fullCorners = grid.corners.map((c) => ({ x: c.x * inv, y: c.y * inv }));
      const face = sampleQuad(cv, src, fullCorners);
      if (!isCubeLike(face)) return false;
      face.region = null;
      face.stickerCount = members.length;
      results.push({
        face, corners: fullCorners, stickerCount: members.length, method: "grid",
        cluster: members.map((a) => ({
          rect: { x: a.rect.x * inv, y: a.rect.y * inv, width: a.rect.width * inv, height: a.rect.height * inv },
        })),
      });
      return true;
    };

    const clusters = clusterStickers(stickers);
    // Walk clusters bottom-up: a >9-sticker cluster is multiple faces merged
    // (a face has 9). Always recurse — the first fitGrid on a 14+ cluster
    // can succeed by accident (one PCA axis + the off-axis stickers line up
    // on the same projection) and "use up" the whole cluster as one face.
    // Forcing a split first means each face comes from a 5–9 sub-cluster
    // where the grid fit is actually meaningful. The depth/budget guards
    // prevent runaway recursion if a split fails to shrink the cluster.
    const tryEmit = (sub, depth) => {
      if (sub.length < 5) return;
      if (depth > 3) {
        // Hit recursion budget — give up on splitting, just try a grid fit.
        const g = fitGrid(sub);
        if (g) emit(g, sub);
        return;
      }
      if (sub.length > 9) {
        const parts = splitByOrientation(sub);
        // splitByOrientation may return the input unchanged if it can't find
        // a real seam; treat that as a leaf and grid-fit directly.
        if (parts.length === 1 || parts[0] === sub) {
          const g = fitGrid(sub);
          if (g) emit(g, sub);
        } else {
          for (const s2 of parts) tryEmit(s2, depth + 1);
        }
        return;
      }
      const grid = fitGrid(sub);
      if (grid) emit(grid, sub);
    };
    for (const cluster of clusters) {
      if (cluster.length < 5) continue;
      if (cluster.length > 9) {
        // Prefer a single 2D k-means with K=3 when the cluster is big enough
        // to plausibly contain 3 faces. The chained 2-means approach
        // (split, split the bigger half) can lock in on the wrong seam
        // first; 3-means on positions finds the 3 face centroids in one
        // pass and handles 3-face angled cubes robustly. Fall back to the
        // recursive 2-means split if 3-means produces an ill-formed split.
        const sub = tryClusterSplit(cluster);
        if (sub) {
          for (const s of sub) tryEmit(s, 1);
        } else {
          const parts = splitByOrientation(cluster);
          if (parts.length === 1 || parts[0] === cluster) {
            const g = fitGrid(cluster);
            if (g) emit(g, cluster);
          } else {
            for (const s2 of parts) tryEmit(s2, 1);
          }
        }
      } else {
        const grid = fitGrid(cluster);
        if (grid) emit(grid, cluster);
      }
    }

    // Try to split a big cluster into 3 faces via 2D k-means. Only return a
    // split if all resulting groups look like a cube face (>=5 stickers and
    // a successful grid fit, AND the split is reasonably balanced — a
    // 11+7+8 split leaks a couple of stickers across the seam, while a
    // clean 9+9+8 split has each face at its own centroid).
    function tryClusterSplit(sub) {
      if (sub.length < 14) return null; // 3 faces × ~5 each is the minimum
      const groups = kmeans2D(sub, 3, 30);
      if (groups.length !== 3) return null;
      if (!groups.every((g) => g.length >= 5 && fitGrid(g))) return null;
      const lens = groups.map((g) => g.length).sort((a, b) => a - b);
      // Reject if a group is more than 4 stickers larger than the smallest.
      // A balanced 3-face cube ≈ 9+9+8 (one sticker missing); an unbalanced
      // 11+7+8 indicates a centroid wandered across a face boundary.
      if (lens[2] - lens[0] > 4) return null;
      return groups;
    }
    work.delete();
    return results;
  }

  // ---- Top-down GEOMETRIC detector (for glossy/stickerless/borderless cubes
  // where per-piece segmentation fails). Segment the cube as one saturated
  // silhouette, approximate it: a single fronto-parallel face -> 4-corner
  // square; an angled cube showing three faces -> 6-corner hexagon, which we
  // split at the near "Y-vertex" into three face quads. Each quad is then
  // perspective-warped and sampled with glare exclusion + median hue. ----

  function lineIntersect(a, b, c, d) {
    const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
    if (Math.abs(den) < 1e-6) return null;
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  }

  // Read a face quad: perspective-warp to a square, sample a 3x3 of median
  // hue, excluding specular glare (high V, low S).
  function readFaceQuad(cv, src, quad) {
    const S = 300;
    const srcT = cv.matFromArray(4, 1, cv.CV_32FC2,
      [quad[0].x, quad[0].y, quad[1].x, quad[1].y, quad[2].x, quad[2].y, quad[3].x, quad[3].y]);
    const dstT = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, S, 0, S, S, 0, S]);
    const M = cv.getPerspectiveTransform(srcT, dstT);
    const warp = new cv.Mat();
    cv.warpPerspective(src, warp, M, new cv.Size(S, S), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    const wd = warp.data, cell = S / 3, cells = [];
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const cx = cell * (gx + 0.5), cy = cell * (gy + 0.5), rad = cell * 0.22;
        const rs = [], gs = [], bs = [];
        for (let y = Math.floor(cy - rad); y < cy + rad; y++) {
          for (let x = Math.floor(cx - rad); x < cx + rad; x++) {
            if (x < 0 || y < 0 || x >= S || y >= S) continue;
            const i = (y * S + x) * 4, r = wd[i], g = wd[i + 1], b = wd[i + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const v = mx, s = mx ? (mx - mn) / mx * 255 : 0;
            if (v > 220 && s < 50) continue; // specular glare → skip
            rs.push(r); gs.push(g); bs.push(b);
          }
        }
        const med = (a) => (a.length ? a.sort((x, y) => x - y)[a.length >> 1] : 0);
        const r = med(rs), g = med(gs), b = med(bs);
        cells.push({ code: classifyColor(r, g, b), rgb: [r, g, b], cx, cy });
      }
    }
    srcT.delete(); dstT.delete(); M.delete(); warp.delete();
    return { cells, detected: true };
  }

  function detectFacesGeometric(cv, src, opts) {
    const debug = opts && opts.debug;
    const W0 = src.cols, H0 = src.rows;
    const scale = GEO_WORK / W0;
    const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale));
    const work = new cv.Mat();
    cv.resize(src, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const inv = 1 / scale;
    const out = [];
    const cleanup = [work];
    const done = () => { cleanup.forEach((m) => m.delete()); return out; };

    const rgb = new cv.Mat(); cv.cvtColor(work, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cleanup.push(rgb, hsv);
    const mask = new cv.Mat();
    cleanup.push(mask);
    let gcOK = false, usedModel = false;

    // Best path: a precomputed cube mask from the segmentation model (cleanly
    // covers the whole cube incl. white pieces, excludes hand/background) —
    // solves the color-threshold failures. Otherwise fall back to the classical
    // saturation-seed + GrabCut silhouette.
    if (opts && opts.cubeMask) {
      cv.resize(opts.cubeMask, mask, new cv.Size(W, H), 0, 0, cv.INTER_NEAREST);
      if (mask.channels() > 1) cv.cvtColor(mask, mask, cv.COLOR_RGBA2GRAY);
      cv.threshold(mask, mask, 127, 255, cv.THRESH_BINARY);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
      const a = cv.countNonZero(mask);
      usedModel = gcOK = a > W * H * T.silhouette.modelArea[0] && a < W * H * T.silhouette.modelArea[1];
    }

    const lo = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.satHsv.lo);
    const hi = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), T.satHsv.hi);
    const sat = new cv.Mat(); cv.inRange(hsv, lo, hi, sat);
    cv.morphologyEx(sat, sat, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7)));
    cleanup.push(lo, hi, sat);
    const sureFg = new cv.Mat(), prFg = new cv.Mat(), gmask = new cv.Mat(H, W, cv.CV_8U);
    const bgM = new cv.Mat(), fgM = new cv.Mat();
    cleanup.push(sureFg, prFg, gmask, bgM, fgM);
    if (!usedModel) try {
      cv.erode(sat, sureFg, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
      cv.dilate(sat, prFg, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(25, 25)));
      gmask.setTo(new cv.Scalar(cv.GC_BGD));
      for (let i = 0; i < W * H; i++) if (prFg.data[i]) gmask.data[i] = cv.GC_PR_FGD;
      for (let i = 0; i < W * H; i++) if (sureFg.data[i]) gmask.data[i] = cv.GC_FGD;
      cv.grabCut(rgb, gmask, new cv.Rect(0, 0, 1, 1), bgM, fgM, 4, cv.GC_INIT_WITH_MASK);
      mask.create(H, W, cv.CV_8U);
      for (let i = 0; i < W * H; i++) mask.data[i] = (gmask.data[i] === cv.GC_FGD || gmask.data[i] === cv.GC_PR_FGD) ? 255 : 0;
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5)));
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9)));
      const a = cv.countNonZero(mask);
      gcOK = a > W * H * T.silhouette.grabcutArea[0] && a < W * H * T.silhouette.grabcutArea[1];
    } catch (e) { gcOK = false; }
    if (!gcOK) { // fallback: plain saturation silhouette
      sat.copyTo(mask);
      cv.morphologyEx(mask, mask, cv.MORPH_OPEN, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(13, 13)));
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(21, 21)));
    }
    if (debug) {
      debug.push(matToDebug(cv, work, "1. Working image"));
      if (!usedModel) debug.push(matToDebug(cv, sat, "2. Saturation seed (S≥150)"));
      const src3 = usedModel ? "neural segmentation" : (gcOK ? "GrabCut" : "threshold");
      debug.push(matToDebug(cv, mask, `${usedModel ? 2 : 3}. Cube silhouette (${src3})`));
    }

    const cnts = new cv.MatVector(); const hier = new cv.Mat();
    cv.findContours(mask, cnts, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    cleanup.push(cnts, hier);
    let best = -1, bestA = 0;
    for (let i = 0; i < cnts.size(); i++) { const a = cv.contourArea(cnts.get(i)); if (a > bestA) { bestA = a; best = i; } }
    if (best < 0 || bestA < W * H * T.silhouette.minCubeAreaFrac) return done();

    const hullM = new cv.Mat(); cv.convexHull(cnts.get(best), hullM, false, true);
    cleanup.push(hullM);
    const hull = []; for (let i = 0; i < hullM.rows; i++) hull.push({ x: hullM.data32S[i * 2], y: hullM.data32S[i * 2 + 1] });
    const peri = cv.arcLength(hullM, true);
    // adaptively pick an epsilon giving 4 (single face) or 6 (three faces) corners
    let corners = null;
    for (const eps of T.approxPoly.epsilons) {
      const ap = new cv.Mat(); cv.approxPolyDP(hullM, ap, eps * peri, true);
      if (ap.rows === 4 || ap.rows === 6) { corners = []; for (let i = 0; i < ap.rows; i++) corners.push({ x: ap.data32S[i * 2], y: ap.data32S[i * 2 + 1] }); ap.delete(); break; }
      ap.delete();
    }
    if (!corners) return done();
    const N = corners.length;

    // Refine corners by SNAPPING each silhouette edge to the true cube
    // boundary: the saturation-mask edge sits a few px off the real edge, so
    // for points along each rough edge we search perpendicular for the peak
    // intensity gradient (the high-contrast cube/background boundary) and fit a
    // robust line through those peaks; adjacent snapped lines intersect at the
    // refined corner (gets corners onto the actual cube corners, ~10px fix).
    const gray = new cv.Mat(); cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(3, 3), 0);
    const gx = new cv.Mat(), gy = new cv.Mat(), gm = new cv.Mat();
    cv.Scharr(gray, gx, cv.CV_32F, 1, 0); cv.Scharr(gray, gy, cv.CV_32F, 0, 1); cv.magnitude(gx, gy, gm);
    cleanup.push(gray, gx, gy, gm);
    const gmd = gm.data32F;
    const gAt = (x, y) => { x |= 0; y |= 0; if (x < 0 || y < 0 || x >= W || y >= H) return 0; return gmd[y * W + x]; };
    const snapEdge = (A, B) => {
      const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
      const nx = -dy / L, ny = dx / L; // perpendicular
      const pts = [], NS = T.edgeSnap.samples, RANGE = T.edgeSnap.range;
      for (let s = 1; s < NS; s++) {
        const t = s / NS, px = A.x + dx * t, py = A.y + dy * t;
        let bestG = -1, bo = 0;
        for (let o = -RANGE; o <= RANGE; o++) { const g = gAt(px + nx * o, py + ny * o); if (g > bestG) { bestG = g; bo = o; } }
        if (bestG > T.edgeSnap.minPeak) pts.push({ x: px + nx * bo, y: py + ny * bo });
      }
      if (pts.length < 4) return null;
      const m = cv.matFromArray(pts.length, 1, cv.CV_32FC2, pts.flatMap((p) => [p.x, p.y]));
      const ln = new cv.Mat(); cv.fitLine(m, ln, cv.DIST_HUBER, 0, 0.01, 0.01);
      const r = { d: { x: ln.data32F[0], y: ln.data32F[1] }, p: { x: ln.data32F[2], y: ln.data32F[3] } };
      m.delete(); ln.delete(); return r;
    };
    const interLine = (a, b) => { if (!a || !b) return null; const den = a.d.x * b.d.y - a.d.y * b.d.x; if (Math.abs(den) < 1e-9) return null; const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / den; return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y }; };
    const E = []; for (let i = 0; i < N; i++) E.push(snapEdge(corners[i], corners[(i + 1) % N]));
    const V = [];
    for (let i = 0; i < N; i++) { const a = E[(i + N - 1) % N], b = E[i]; const v = interLine(a, b); V.push(v || corners[i]); }

    const silhouette = usedModel ? "neural" : (gcOK ? "grabcut" : "threshold");
    const toFull = (q) => q.map((p) => ({ x: p.x * inv, y: p.y * inv }));
    const hd = hsv.data;
    const darkAlong = (a, b) => { let s = 0, n = 0; const st = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) | 0; for (let i = 0; i <= st; i++) { const t = st ? i / st : 0, x = (a.x + (b.x - a.x) * t) | 0, y = (a.y + (b.y - a.y) * t) | 0; if (x < 0 || y < 0 || x >= W || y >= H) continue; s += hd[(y * W + x) * 3 + 2]; n++; } return n ? s / n : 255; };

    if (N === 4) {
      const quad = toFull(V);
      out.push({ face: readFaceQuad(cv, src, quad), corners: quad, stickerCount: 9, method: "geometric-1face", cluster: [], silhouette });
      return done();
    }

    // 6 corners → three faces. Use the ACCURATE edge-snapped silhouette corners
    // V as the outer ring (they hug the real cube), and solve only the
    // near-corner: PnP gives the perspective-correct near-corner; if PnP fails
    // fall back to the affine diagonal intersection. Faces are [near, side,
    // outer, side] over the snapped ring — so the wireframe hugs the cube
    // instead of drifting with the full PnP reprojection.
    let nearW = null;
    const P = solveCubePose(cv, V, W, H);
    if (P) nearW = P[0];
    if (!nearW) {
      const i1 = lineIntersect(V[0], V[3], V[1], V[4]);
      const i2 = lineIntersect(V[1], V[4], V[2], V[5]);
      const i3 = lineIntersect(V[0], V[3], V[2], V[5]);
      if (!i1 || !i2 || !i3) return done();
      nearW = { x: (i1.x + i2.x + i3.x) / 3, y: (i1.y + i2.y + i3.y) / 3 };
    }
    const ringFull = toFull(V), nearFull = toFull([nearW])[0];
    // Choose the side/outer alternation by self-consistency: the CORRECT
    // decomposition warps each face to a square with axis-aligned (horizontal/
    // vertical) sticker edges; the wrong one maps a face diagonal to the square
    // edge and rotates the stickers ~45°. Score = axis-aligned vs diagonal
    // gradient energy of the warped faces; pick the higher.
    // Optimization: warp the 900-wide `work` (not full-res `src`) — the score
    // is a relative ranking so the slight noise is fine, and the warps are
    // ~6x faster on the smaller image.
    const ringWork = V, nearWork = nearW;
    const altScore = (ss2) => withMats(cv, () => {
      let tot = 0;
      for (let k = 0; k < 3; k++) {
        const a = (ss2 + 2 * k) % 6, b = (a + 1) % 6, c = (a + 2) % 6;
        const q = [nearWork, ringWork[a], ringWork[b], ringWork[c]];
        const S = T.altScoreSize;
        const sT = cv.matFromArray(4, 1, cv.CV_32FC2, [q[0].x, q[0].y, q[1].x, q[1].y, q[2].x, q[2].y, q[3].x, q[3].y]);
        const dT = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, S, 0, S, S, 0, S]);
        const M = cv.getPerspectiveTransform(sT, dT);
        const w = new cv.Mat();
        cv.warpPerspective(work, w, M, new cv.Size(S, S), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
        const g = new cv.Mat(); cv.cvtColor(w, g, cv.COLOR_RGBA2GRAY);
        const gx = new cv.Mat(), gy = new cv.Mat();
        cv.Scharr(g, gx, cv.CV_32F, 1, 0); cv.Scharr(g, gy, cv.CV_32F, 0, 1);
        let axis = 0, diag = 0;
        for (let i = 0; i < S * S; i++) { const aa = Math.abs(gx.data32F[i]), bb = Math.abs(gy.data32F[i]); axis += Math.abs(aa - bb); diag += Math.min(aa, bb); }
        tot += axis / (diag + 1);
      }
      return tot;
    });
    const sideStart = altScore(0) >= altScore(1) ? 0 : 1;
    const wireframe = { near: nearFull, ring: ringFull, sideStart };
    for (let k = 0; k < 3; k++) {
      const a = (sideStart + 2 * k) % 6, b = (a + 1) % 6, c = (a + 2) % 6;
      const quad = [nearFull, ringFull[a], ringFull[b], ringFull[c]];
      out.push({ face: readFaceQuad(cv, src, quad), corners: quad, stickerCount: 9, method: P ? "geometric-pnp" : "geometric-3face", cluster: [], wireframe, silhouette });
    }
    return done();
  }

  // Build the 3 face quads from an editable cube wireframe {near, ring[6],
  // sideStart}. Used both internally and by the app after the user drags a
  // corner handle. Returns [{corners, face?}] — pass cv+src to also sample.
  function facesFromWireframe(cv, src, wf) {
    const res = [];
    for (let k = 0; k < 3; k++) {
      const a = (wf.sideStart + 2 * k) % 6, b = (a + 1) % 6, c = (a + 2) % 6;
      const quad = [wf.near, wf.ring[a], wf.ring[b], wf.ring[c]];
      const r = { corners: quad, stickerCount: 9, method: "geometric-3face", cluster: [], wireframe: wf };
      if (cv && src) r.face = readFaceQuad(cv, src, quad);
      res.push(r);
    }
    return res;
  }

  // Solve cube camera pose from 6 ordered silhouette corners (work coords).
  // Returns the 8 cube corners projected to WORK coords, or null.
  // Order of returned points: 0=near(+++),1=(++-),2=(+--),3=(+-+),
  //   4=(-++),5=(-+-),6=far(---),7=(--+)  (units of ±0.5).
  function solveCubePose(cv, V, W, H) {
    // canonical cube silhouette ring (cyclic) ↔ the 6 image corners
    const M6 = [[.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5], [-.5, .5, .5], [-.5, -.5, .5], [.5, -.5, .5]];
    const ALL = [.5, .5, .5, .5, .5, -.5, .5, -.5, -.5, .5, -.5, .5, -.5, .5, .5, -.5, .5, -.5, -.5, -.5, -.5, -.5, -.5, .5];
    const D = cv.matFromArray(1, 5, cv.CV_64F, [0, 0, 0, 0, 0]);
    const obj = cv.matFromArray(6, 3, cv.CV_64F, M6.flat());
    let best = null, bestK = null;
    // Sweep focal length: a close phone shot has strong perspective (small f);
    // the wrong f flattens the pose and collapses the near-corner to the
    // hexagon centre. Pick the (f, correspondence) with lowest reprojection.
    for (const fr of T.pnp.focal) {
      const f = fr * W;
      const K = cv.matFromArray(3, 3, cv.CV_64F, [f, 0, W / 2, 0, f, H / 2, 0, 0, 1]);
      for (let dir = 0; dir < 2; dir++) {
        for (let rot = 0; rot < 6; rot++) {
          const order = []; for (let i = 0; i < 6; i++) order.push(dir ? (rot - i + 12) % 6 : (rot + i) % 6);
          const img = cv.matFromArray(6, 2, cv.CV_64F, order.flatMap((i) => [V[i].x, V[i].y]));
          const rv = new cv.Mat(), tv = new cv.Mat();
          let ok = false;
          try { ok = cv.solvePnP(obj, img, K, D, rv, tv, false, cv.SOLVEPNP_ITERATIVE); } catch (e) { ok = false; }
          if (ok) {
            const proj = new cv.Mat(), jac = new cv.Mat();
            cv.projectPoints(obj, rv, tv, K, D, proj, jac);
            let err = 0; for (let i = 0; i < 6; i++) { const dx = proj.data64F[i * 2] - V[order[i]].x, dy = proj.data64F[i * 2 + 1] - V[order[i]].y; err += dx * dx + dy * dy; }
            err = Math.sqrt(err / 6); proj.delete(); jac.delete();
            if (!best || err < best.err) { if (best) { best.rv.delete(); best.tv.delete(); best.K.delete(); } best = { err, rv, tv, K: K.clone() }; }
            else { rv.delete(); tv.delete(); }
          } else { rv.delete(); tv.delete(); }
          img.delete();
        }
      }
      K.delete();
    }
    let result = null;
    if (best && best.err < W * T.pnp.maxReprojFrac) { // accept only a good fit
      const allObj = cv.matFromArray(8, 3, cv.CV_64F, ALL);
      const proj = new cv.Mat(), jac = new cv.Mat();
      cv.projectPoints(allObj, best.rv, best.tv, best.K, D, proj, jac);
      result = []; for (let i = 0; i < 8; i++) result.push({ x: proj.data64F[i * 2], y: proj.data64F[i * 2 + 1] });
      allObj.delete(); proj.delete(); jac.delete();
    }
    if (best) { best.rv.delete(); best.tv.delete(); best.K.delete(); }
    D.delete(); obj.delete();
    return result;
  }

  return { detectCube, detectFaces, detectFacesGeometric, facesFromWireframe, readFaceQuad, sampleQuad, orderCorners, classifyColor, sampleGrid, cellColor, findStickerSquares, clusterStickers, findColorAnchors, pickCubeCluster, squaredBBox, fitGrid, splitByOrientation, kmeans2D, COLORS, WORK_WIDTH };
});
