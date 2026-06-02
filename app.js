/* Rubik's Cube Detector — browser-side using OpenCV.js */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const overlay = $("overlay");
  const fileInput = $("file");
  const drop = $("drop");
  const detectBtn = $("detectBtn");
  const sampleBtn = $("sampleBtn");
  const facesEl = $("faces");
  const legendEl = $("legend");
  const diag = $("diag");

  let cvReady = false;
  let srcImg = null; // HTMLImageElement currently loaded

  // ---- Standard cube colors (display swatch + HSV classification) ----
  const COLORS = {
    W: { name: "White",  css: "#f5f5f5" },
    Y: { name: "Yellow", css: "#ffd500" },
    R: { name: "Red",    css: "#d11a1a" },
    O: { name: "Orange", css: "#ff7a1a" },
    G: { name: "Green",  css: "#1faa46" },
    B: { name: "Blue",   css: "#175fd6" },
  };

  function classifyColor(r, g, b) {
    // Convert RGB -> HSV (H in [0,360), S,V in [0,1])
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;

    // White: low saturation, decent brightness
    if (s < 0.22 && v > 0.5) return "W";
    if (v < 0.15) return "W"; // near-black: default, avoids misclassifying

    if (h < 16 || h >= 330) return "R";
    if (h < 40) return "O";   // orange (cube orange sits near 15-30°)
    if (h < 70) return "Y";   // yellow (~45-60°)
    if (h < 175) return "G";  // green
    if (h < 265) return "B";  // blue
    return "R";               // magenta wraps back to red
  }

  // Average color (RGB) + HSV saturation of a rectangle's inner patch.
  function sampleRectColor(srcMat, r) {
    const px = Math.max(2, Math.floor(r.width * 0.25));
    const py = Math.max(2, Math.floor(r.height * 0.25));
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    let rr = 0, gg = 0, bb = 0, n = 0;
    for (let yy = Math.floor(cy - py); yy < cy + py; yy++) {
      for (let xx = Math.floor(cx - px); xx < cx + px; xx++) {
        if (xx < 0 || yy < 0 || xx >= srcMat.cols || yy >= srcMat.rows) continue;
        const idx = (yy * srcMat.cols + xx) * 4;
        rr += srcMat.data[idx]; gg += srcMat.data[idx + 1]; bb += srcMat.data[idx + 2]; n++;
      }
    }
    if (n) { rr /= n; gg /= n; bb /= n; }
    const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    return { rgb: [rr, gg, bb], sat };
  }

  // ---- OpenCV load handling ----
  function onCvReady() {
    cvReady = true;
    statusEl.textContent = "OpenCV ready";
    statusEl.classList.add("ready");
    if (srcImg) detectBtn.disabled = false;
  }

  // opencv.js may expose `cv` already-initialized, as a module needing
  // onRuntimeInitialized, or (newer builds) as a Promise resolving to the API.
  function waitForCv() {
    if (window.cv && typeof cv.then === "function") {
      cv.then((real) => { window.cv = real; onCvReady(); });
      return;
    }
    if (window.cv && cv.Mat) { onCvReady(); return; }
    if (window.cv) cv["onRuntimeInitialized"] = onCvReady;
    const t = setInterval(() => {
      if (window.cv && typeof cv.then === "function") {
        clearInterval(t); cv.then((real) => { window.cv = real; onCvReady(); }); return;
      }
      if (window.cv && cv.Mat) { clearInterval(t); onCvReady(); }
    }, 100);
  }
  waitForCv();

  // ---- Image loading ----
  function loadImageFromSrc(src) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      srcImg = img;
      drawBase();
      if (cvReady) detectBtn.disabled = false;
      statusEl.textContent = cvReady ? "OpenCV ready — image loaded" : "Loading OpenCV…";
      statusEl.classList.toggle("ready", cvReady);
    };
    img.onerror = () => {
      statusEl.textContent = "Failed to load image";
    };
    img.src = src;
  }

  function drawBase() {
    const maxW = 520;
    const scale = Math.min(1, maxW / srcImg.naturalWidth);
    overlay.width = Math.round(srcImg.naturalWidth * scale);
    overlay.height = Math.round(srcImg.naturalHeight * scale);
    const ctx = overlay.getContext("2d");
    ctx.drawImage(srcImg, 0, 0, overlay.width, overlay.height);
  }

  fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const url = URL.createObjectURL(f);
    loadImageFromSrc(url);
  });

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) loadImageFromSrc(URL.createObjectURL(f));
  });

  sampleBtn.addEventListener("click", () => {
    // Served locally to avoid CORS taint when reading pixels.
    loadImageFromSrc("sample.jpg");
  });

  detectBtn.addEventListener("click", () => {
    if (!cvReady || !srcImg) return;
    detectBtn.disabled = true;
    statusEl.innerHTML = '<span class="spinner"></span> Detecting…';
    // let UI paint
    setTimeout(() => {
      try {
        detect();
        statusEl.textContent = "Detection complete";
        statusEl.classList.add("ready");
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Detection error: " + err.message;
        diag.textContent = String(err.stack || err);
      } finally {
        detectBtn.disabled = false;
      }
    }, 30);
  });

  // ---- Core detection ----
  //
  // Strategy (validated against the reference photo, which also contains
  // printed 3x3 grids on paper + a busy brick wall): brick, skin, hands and
  // paper are all warm/neutral, so they share hue with the cube's red/orange/
  // yellow stickers. The decisive discriminator is GREEN and BLUE — hues that
  // simply don't occur in the background. We mask green+blue, find blob
  // "anchors", cluster them by proximity (the cube's anchors sit together;
  // stray teal arrows on paper are isolated), take the densest cluster, and
  // use its squared bounding box as the face region. Then sample a 3x3 grid.
  function detect() {
    const src = cv.imread(overlay); // RGBA Mat of displayed image
    const W = src.cols, H = src.rows, imgArea = W * H;

    const anchors = findColorAnchors(src, imgArea);
    const cluster = pickCubeCluster(anchors);

    let region, confident;
    if (cluster && cluster.length) {
      region = squaredBBox(cluster, W, H);
      confident = true;
    } else {
      region = { x: W * 0.2, y: H * 0.2, w: W * 0.6, h: H * 0.6 };
      confident = false;
    }

    const face = sampleGrid(src, region, confident);
    face.region = region;
    face.stickerCount = cluster ? cluster.length : 0;

    diag.textContent =
      `image: ${W}x${H}\ngreen/blue anchors: ${anchors.length}` +
      `\ncube cluster: ${cluster ? cluster.length : 0} anchors` +
      `\nface region: ${Math.round(region.w)}x${Math.round(region.h)} @(${Math.round(region.x)},${Math.round(region.y)})` +
      (confident ? "" : "\n(no green/blue found — using center crop)");

    drawOverlay(cluster || [], [face]);
    renderFaces([face]);
    renderLegend();

    src.delete();
  }

  // Detect green+blue blobs that look like cube stickers. Returns
  // [{cx, cy, side, rect}]. These hues are absent from brick/skin/paper.
  function findColorAnchors(src, imgArea) {
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    // H 40..135 spans green→blue (OpenCV hue is 0..180). These hues never
    // appear in brick/skin/paper, so a moderate saturation bar safely isolates
    // the cube's green & blue stickers — reliable anchors for the face.
    const gbLow = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 70, 45, 0]);
    const gbHigh = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [135, 255, 255, 0]);
    const mask = new cv.Mat();
    cv.inRange(hsv, gbLow, gbHigh, mask);
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
      // sticker-sized, roughly square-ish (allow tall/wide merges of 2 stickers)
      if (area > imgArea * 0.0004 && area < imgArea * 0.05 &&
          ar > 0.3 && ar < 3.2 && fill > 0.45) {
        anchors.push({ cx: r.x + r.width / 2, cy: r.y + r.height / 2, side: Math.min(r.width, r.height), rect: r });
      }
      cnt.delete();
    }
    rgb.delete(); hsv.delete(); gbLow.delete(); gbHigh.delete();
    mask.delete(); cnts.delete(); hier.delete();
    return anchors;
  }

  // Cluster anchors by proximity (union-find), return the largest cluster.
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

  // Squared, slightly padded bounding box of a set of anchors, clamped to image.
  function squaredBBox(cluster, W, H) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const a of cluster) {
      minX = Math.min(minX, a.rect.x); minY = Math.min(minY, a.rect.y);
      maxX = Math.max(maxX, a.rect.x + a.rect.width); maxY = Math.max(maxY, a.rect.y + a.rect.height);
    }
    const pad = 0.10;
    const rw = (maxX - minX) * (1 + 2 * pad), rh = (maxY - minY) * (1 + 2 * pad);
    const cX = (minX + maxX) / 2, cY = (minY + maxY) / 2;
    const sz = Math.max(rw, rh); // cube face is square
    let x = cX - sz / 2, y = cY - sz / 2;
    x = Math.max(0, Math.min(x, W - sz));
    y = Math.max(0, Math.min(y, H - sz));
    return { x, y, w: sz, h: sz };
  }

  // Sample a 3x3 grid of sticker colors from a rectangular region.
  function sampleGrid(srcMat, region, detected) {
    const cells = [];
    const cw = region.w / 3, ch = region.h / 3;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const cx = region.x + cw * (gx + 0.5);
        const cy = region.y + ch * (gy + 0.5);
        const [r, g, b] = cellColor(srcMat, cx, cy, Math.max(4, cw * 0.28), Math.max(4, ch * 0.28));
        const code = classifyColor(r, g, b);
        cells.push({ code, rgb: [Math.round(r), Math.round(g), Math.round(b)], cx, cy });
      }
    }
    return { cells, detected };
  }

  // Representative color of one cell. Stickers are vivid; fingers covering a
  // sticker, shadows and gridlines are duller. We keep only vivid pixels
  // (high saturation), bin them by hue (plus a white bin for bright-but-pale
  // pixels), and average the dominant bin — so a sticker shows through even
  // when a finger covers part of it. Falls back to a plain average for a
  // genuinely pale/white cell that has few vivid pixels.
  function cellColor(srcMat, cx, cy, hx, hy) {
    const px = [];
    for (let y = Math.floor(cy - hy); y < cy + hy; y++) {
      for (let x = Math.floor(cx - hx); x < cx + hx; x++) {
        if (x < 0 || y < 0 || x >= srcMat.cols || y >= srcMat.rows) continue;
        const i = (y * srcMat.cols + x) * 4;
        const r = srcMat.data[i], g = srcMat.data[i + 1], b = srcMat.data[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
        let h = 0;
        if (d) {
          if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
          h = h * 60; if (h < 0) h += 360;
        }
        px.push({ r, g, b, h, s: mx === 0 ? 0 : d / mx, v: mx / 255 });
      }
    }
    if (!px.length) return [0, 0, 0];
    // vivid sticker pixels (s>=0.7); skin (~0.57) and shadow fall below
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

  // ---- Overlay drawing ----
  function drawOverlay(stickers, faces) {
    drawBase();
    const ctx = overlay.getContext("2d");
    // detected sticker contours
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(79,140,255,0.9)";
    for (const s of stickers) {
      ctx.strokeRect(s.rect.x, s.rect.y, s.rect.width, s.rect.height);
    }
    // face grid
    for (const f of faces) {
      if (!f.region) continue;
      const { x, y, w, h } = f.region;
      ctx.strokeStyle = "rgba(95,217,127,0.95)";
      ctx.lineWidth = 2.5;
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = "rgba(95,217,127,0.55)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(x + (w / 3) * i, y); ctx.lineTo(x + (w / 3) * i, y + h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x, y + (h / 3) * i); ctx.lineTo(x + w, y + (h / 3) * i); ctx.stroke();
      }
    }
  }

  // ---- Faces panel ----
  function renderFaces(faces) {
    facesEl.innerHTML = "";
    if (!faces.length) {
      facesEl.innerHTML = '<div class="empty">No cube face detected.</div>';
      return;
    }
    faces.forEach((f, i) => {
      const card = document.createElement("div");
      card.className = "face-card";
      const title = f.detected
        ? `Detected face — located via ${f.stickerCount ?? 0} green/blue anchor(s)`
        : `Face (center crop — no green/blue found, low confidence)`;
      const grid = document.createElement("div");
      grid.className = "grid3";
      f.cells.forEach((c) => {
        const cell = document.createElement("div");
        cell.className = "cell";
        cell.style.background = COLORS[c.code].css;
        cell.title = `${COLORS[c.code].name} · rgb(${c.rgb.join(",")})`;
        const lbl = document.createElement("span");
        lbl.className = "lbl";
        lbl.textContent = c.code;
        cell.appendChild(lbl);
        grid.appendChild(cell);
      });
      const h = document.createElement("h3");
      h.textContent = title;
      card.appendChild(h);
      card.appendChild(grid);
      facesEl.appendChild(card);
    });
  }

  function renderLegend() {
    legendEl.innerHTML = "";
    Object.entries(COLORS).forEach(([k, v]) => {
      const span = document.createElement("span");
      span.innerHTML = `<i style="background:${v.css}"></i>${v.name} (${k})`;
      legendEl.appendChild(span);
    });
  }
})();
