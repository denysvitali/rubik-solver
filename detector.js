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

    // 2. Find the two grid axes from nearest-neighbor directions.
    //    For each sticker, compute the direction to its nearest neighbor.
    //    Collect these as unit vectors. PCA on the vectors (not positions)
    //    finds the two dominant directions, which are the grid axes.
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

    // PCA on the direction vectors to find the two dominant perpendicular directions
    let vxx = 0, vxy = 0, vyy = 0;
    for (const v of vecs) { vxx += v.x * v.x; vxy += v.x * v.y; vyy += v.y * v.y; }
    const vtrace = vxx + vyy;
    const vdet = vxx * vyy - vxy * vxy;
    const vdisc = Math.sqrt(Math.max(0, vtrace * vtrace / 4 - vdet));
    const vlam1 = vtrace / 2 + vdisc;
    let ax1x, ax1y;
    if (Math.abs(vxy) > 1e-6) {
      ax1x = vxy; ax1y = vlam1 - vxx;
    } else {
      ax1x = vxx >= vyy ? 1 : 0; ax1y = vxx >= vyy ? 0 : 1;
    }
    const vnorm = Math.hypot(ax1x, ax1y);
    if (vnorm < 1e-6) return null;
    ax1x /= vnorm; ax1y /= vnorm;
    const ax2x = -ax1y, ax2y = ax1x;

    // 3. Project stickers onto both axes
    const proj = stickers.map((s) => ({
      sticker: s,
      u: (s.cx - mx) * ax1x + (s.cy - my) * ax1y,
      v: (s.cx - mx) * ax2x + (s.cy - my) * ax2y,
    }));

    // 4. Cluster projections into 3 groups along each axis
    function cluster3(items, key) {
      const sorted = [...items].sort((a, b) => a[key] - b[key]);
      if (sorted.length < 3) return null;
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        gaps.push({ gap: sorted[i][key] - sorted[i - 1][key], at: i });
      }
      gaps.sort((a, b) => b.gap - a.gap);
      const split1 = Math.min(gaps[0].at, gaps[1].at);
      const split2 = Math.max(gaps[0].at, gaps[1].at);
      return [sorted.slice(0, split1), sorted.slice(split1, split2), sorted.slice(split2)];
    }

    const colGroups = cluster3(proj, "u");
    const rowGroups = cluster3(proj, "v");
    if (!colGroups || !rowGroups) return null;

    // 5. Validate: at least 2 groups per axis should be non-empty
    const colSizes = colGroups.map((g) => g.length);
    const rowSizes = rowGroups.map((g) => g.length);
    if (colSizes.filter((s) => s > 0).length < 2 || rowSizes.filter((s) => s > 0).length < 2) return null;

    // 6. Compute group centers
    const colCenters = colGroups.map((g) => g.length ? g.reduce((s, p) => s + p.u, 0) / g.length : null);
    const rowCenters = rowGroups.map((g) => g.length ? g.reduce((s, p) => s + p.v, 0) / g.length : null);

    // Fill missing centers by interpolation
    for (let i = 0; i < 3; i++) {
      if (colCenters[i] === null) {
        if (i === 0 && colCenters[1] !== null && colCenters[2] !== null) colCenters[0] = 2 * colCenters[1] - colCenters[2];
        else if (i === 1 && colCenters[0] !== null && colCenters[2] !== null) colCenters[1] = (colCenters[0] + colCenters[2]) / 2;
        else if (i === 2 && colCenters[0] !== null && colCenters[1] !== null) colCenters[2] = 2 * colCenters[1] - colCenters[0];
      }
      if (rowCenters[i] === null) {
        if (i === 0 && rowCenters[1] !== null && rowCenters[2] !== null) rowCenters[0] = 2 * rowCenters[1] - rowCenters[2];
        else if (i === 1 && rowCenters[0] !== null && rowCenters[2] !== null) rowCenters[1] = (rowCenters[0] + rowCenters[2]) / 2;
        else if (i === 2 && rowCenters[0] !== null && rowCenters[1] !== null) rowCenters[2] = 2 * rowCenters[1] - rowCenters[0];
      }
    }
    if (colCenters.some((c) => c === null) || rowCenters.some((c) => c === null)) return null;

    // 7. Validate spacing uniformity
    const colGaps = [colCenters[1] - colCenters[0], colCenters[2] - colCenters[1]];
    const rowGaps = [rowCenters[1] - rowCenters[0], rowCenters[2] - rowCenters[1]];
    if (Math.min(...colGaps) / Math.max(...colGaps) < 0.2) return null;
    if (Math.min(...rowGaps) / Math.max(...rowGaps) < 0.2) return null;

    // 8. Compute face corners: extrapolate from outer grid positions
    const avgSide = stickers.reduce((s, st) => s + st.side, 0) / n;
    const borderU = avgSide * 0.55;
    const borderV = avgSide * 0.55;
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

  // Split stickers from two faces that might be merged in one cluster.
  // Uses orientation: stickers from the same face have similar nearest-neighbor
  // directions. Returns sub-clusters, each hopefully from one face.
  function splitByOrientation(stickers) {
    const n = stickers.length;
    if (n < 6) return [stickers]; // too few to split

    // For each sticker, find its nearest neighbor and compute the direction
    const dirs = [];
    for (let i = 0; i < n; i++) {
      let bestD = Infinity, bestJ = -1;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const d = Math.hypot(stickers[i].cx - stickers[j].cx, stickers[i].cy - stickers[j].cy);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ < 0) { dirs.push(0); continue; }
      const dx = stickers[bestJ].cx - stickers[i].cx;
      const dy = stickers[bestJ].cy - stickers[i].cy;
      let a = Math.atan2(dy, dx) * 180 / Math.PI;
      if (a < 0) a += 180; // normalize to [0, 180)
      dirs.push(a);
    }

    // Cluster directions into 2 groups. Simple: find the dominant direction,
    // then split by whether a sticker's direction is close or ~90° away.
    // Use the median direction as reference.
    const sorted = [...dirs].sort((a, b) => a - b);
    const median = sorted[n >> 1];
    const groupA = [], groupB = [];
    for (let i = 0; i < n; i++) {
      const diff = Math.abs(dirs[i] - median);
      const angDiff = Math.min(diff, 180 - diff);
      if (angDiff < 45) groupA.push(stickers[i]);
      else groupB.push(stickers[i]);
    }
    // If one group is too small, don't split
    if (groupA.length < 4 || groupB.length < 4) return [stickers];
    return [groupA, groupB];
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
    function tryGridFit(stk, imgScale) {
      if (stk.length < 5) return null;
      const clusters = clusterStickers(stk, true);
      for (const cluster of clusters) {
        if (cluster.length < 5) continue;
        let grid = fitGrid(cluster);
        if (!grid && cluster.length >= 8) {
          for (const sub of splitByOrientation(cluster)) {
            grid = fitGrid(sub);
            if (grid) break;
          }
        }
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
        const anchorBox = squaredBBox(anchorCluster, W, H, 0.20);
        // Convert to full-res coordinates
        const fx = Math.max(0, Math.round(anchorBox.x * inv));
        const fy = Math.max(0, Math.round(anchorBox.y * inv));
        const fw = Math.min(W0 - fx, Math.round(anchorBox.w * inv));
        const fh = Math.min(H0 - fy, Math.round(anchorBox.h * inv));
        if (fw > 50 && fh > 50) {
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
            const adjClusters = clusterStickers(adjSquares, true);
            for (const cluster of adjClusters) {
              if (cluster.length < 5) continue;
              const grid = fitGrid(cluster);
              if (grid) {
                gridResult = { corners: grid.corners, cluster, stickerCount: cluster.length };
                break;
              }
            }
          }
          crop.delete(); cropWork.delete();
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
    const sqClusters = clusterStickers(squares, true);
    const sqBest = sqClusters[0] || [];
    let method, regionW, confident, overlayBoxes;
    if (sqBest.length >= 5) {
      regionW = squaredBBox(sqBest, W, H, 0.04);
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
  function detectFaces(cv, src) {
    const W0 = src.cols, H0 = src.rows;
    const scale = WORK_WIDTH / W0;
    const W = Math.max(1, Math.round(W0 * scale)), H = Math.max(1, Math.round(H0 * scale));
    const work = new cv.Mat();
    cv.resize(src, work, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    const imgArea = W * H;
    const inv = 1 / scale;

    const stickers = findStickerSquares(cv, work, imgArea);
    if (stickers.length < 5) { work.delete(); return []; }

    const results = [];
    const clusters = clusterStickers(stickers, true);
    for (const cluster of clusters) {
      if (cluster.length < 5) continue;
      let grid = fitGrid(cluster);
      if (!grid && cluster.length >= 8) {
        for (const sub of splitByOrientation(cluster)) {
          grid = fitGrid(sub);
          if (grid) break;
        }
      }
      if (grid) {
        const fullCorners = grid.corners.map((c) => ({ x: c.x * inv, y: c.y * inv }));
        const face = sampleQuad(cv, src, fullCorners);
        face.region = null;
        face.stickerCount = cluster.length;
        results.push({
          face, corners: fullCorners, stickerCount: cluster.length, method: "grid",
          cluster: cluster.map((a) => ({
            rect: { x: a.rect.x * inv, y: a.rect.y * inv, width: a.rect.width * inv, height: a.rect.height * inv },
          })),
        });
      }
    }
    work.delete();
    return results;
  }

  return { detectCube, detectFaces, sampleQuad, orderCorners, classifyColor, sampleGrid, cellColor, findStickerSquares, clusterStickers, findColorAnchors, pickCubeCluster, squaredBBox, fitGrid, splitByOrientation, COLORS, WORK_WIDTH };
});
