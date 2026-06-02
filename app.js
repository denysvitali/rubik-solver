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
    if (h < 45) return "O";   // orange
    if (h < 70) return "Y";   // yellow
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
  function detect() {
    const src = cv.imread(overlay); // RGBA Mat of displayed image
    const W = src.cols, H = src.rows;

    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = new cv.Mat();
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const edges = new cv.Mat();
    cv.Canny(blur, edges, 30, 90);
    // close gaps so sticker borders form closed quads
    const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    const dil = new cv.Mat();
    cv.dilate(edges, dil, kernel);

    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(dil, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const stickers = []; // {cx, cy, area, side, pts}
    const imgArea = W * H;
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * 0.0008 || area > imgArea * 0.15) { cnt.delete(); continue; }
      const peri = cv.arcLength(cnt, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        const r = cv.boundingRect(approx);
        const ar = r.width / r.height;
        if (ar > 0.6 && ar < 1.6) {
          const sq = Math.abs(area - r.width * r.height) / (r.width * r.height);
          if (sq < 0.45) {
            const col = sampleRectColor(src, r);
            stickers.push({
              cx: r.x + r.width / 2,
              cy: r.y + r.height / 2,
              area,
              side: (r.width + r.height) / 2,
              rect: r,
              sat: col.sat,
              rgb: col.rgb,
            });
          }
        }
      }
      approx.delete();
      cnt.delete();
    }

    const edgeCount = stickers.length;

    // ---- Color-filter pass ----
    // Cube stickers are vivid, solid colors. Threshold the HSV saturation/value
    // to isolate colored regions (paper & white background drop out), then find
    // square blobs the same way. This anchors directly on neighboring colored
    // squares rather than relying on clean edges.
    const rgb = new cv.Mat();
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    const hsv = new cv.Mat();
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    // S >= 70, V >= 60  (H spans full range — any saturated hue)
    const low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [0, 70, 60, 0]);
    const high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [180, 255, 255, 0]);
    const mask = new cv.Mat();
    cv.inRange(hsv, low, high, mask);
    // close holes (glare/specular) then open to drop thin noise
    const ck = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, ck);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, ck);

    const cContours = new cv.MatVector();
    const cHier = new cv.Mat();
    cv.findContours(mask, cContours, cHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    for (let i = 0; i < cContours.size(); i++) {
      const cnt = cContours.get(i);
      const area = cv.contourArea(cnt);
      if (area < imgArea * 0.0008 || area > imgArea * 0.15) { cnt.delete(); continue; }
      const r = cv.boundingRect(cnt);
      const ar = r.width / r.height;
      const fill = area / (r.width * r.height); // how square/solid the blob is
      if (ar > 0.6 && ar < 1.6 && fill > 0.6) {
        const col = sampleRectColor(src, r);
        stickers.push({
          cx: r.x + r.width / 2,
          cy: r.y + r.height / 2,
          area,
          side: (r.width + r.height) / 2,
          rect: r,
          sat: col.sat,
          rgb: col.rgb,
          src: "color",
        });
      }
      cnt.delete();
    }
    const colorCount = stickers.length - edgeCount;
    rgb.delete(); hsv.delete(); low.delete(); high.delete();
    mask.delete(); ck.delete(); cContours.delete(); cHier.delete();

    // Deduplicate overlapping detections (nested contours of same sticker)
    const dedup = [];
    stickers.sort((a, b) => b.area - a.area);
    for (const s of stickers) {
      let dup = false;
      for (const d of dedup) {
        const dist = Math.hypot(s.cx - d.cx, s.cy - d.cy);
        if (dist < d.side * 0.6) { dup = true; break; }
      }
      if (!dup) dedup.push(s);
    }

    diag.textContent =
      `image: ${W}x${H}\nedge quads: ${edgeCount}\ncolor blobs: ${colorCount}` +
      `\nunique stickers: ${dedup.length}`;

    const faces = buildFaces(dedup, src);

    drawOverlay(dedup, faces);
    renderFaces(faces);
    renderLegend();

    src.delete(); gray.delete(); blur.delete(); edges.delete();
    dil.delete(); kernel.delete(); contours.delete(); hier.delete();
  }

  // Group stickers into 3x3 face(s).
  //
  // A cube face is a tight cluster of ~9 similar-sized quads. The reference
  // photo also contains *drawn* 3x3 grids on paper — same shape, but white &
  // unsaturated. So we cluster quads spatially (connected components by
  // proximity + similar size), then score each cluster, rewarding both a
  // count near 9 and high color saturation. The vivid cube wins over paper.
  function buildFaces(stickers, srcMat) {
    if (stickers.length < 4) {
      return [sampleGrid(srcMat, {
        x: srcMat.cols * 0.2, y: srcMat.rows * 0.2,
        w: srcMat.cols * 0.6, h: srcMat.rows * 0.6,
      }, false)];
    }

    const clusters = clusterStickers(stickers);
    if (!clusters.length) {
      return [sampleGrid(srcMat, {
        x: srcMat.cols * 0.2, y: srcMat.rows * 0.2,
        w: srcMat.cols * 0.6, h: srcMat.rows * 0.6,
      }, false)];
    }

    const scored = clusters.map((c) => {
      const meanSat = c.reduce((a, s) => a + s.sat, 0) / c.length;
      // count score peaks at 9 stickers
      const countScore = 1 - Math.min(1, Math.abs(c.length - 9) / 9);
      const score = meanSat * 0.7 + countScore * 0.3;
      return { c, meanSat, score };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0].c;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of best) {
      minX = Math.min(minX, s.rect.x);
      minY = Math.min(minY, s.rect.y);
      maxX = Math.max(maxX, s.rect.x + s.rect.width);
      maxY = Math.max(maxY, s.rect.y + s.rect.height);
    }
    // Pad to nearest sticker so the bbox snaps to a full 3x3 even if a corner
    // sticker was missed by contour detection.
    const region = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    const face = sampleGrid(srcMat, region, true);
    face.region = region;
    face.stickerCount = best.length;
    diag.textContent += `\nclusters: ${clusters.length}` +
      `\nbest cluster: ${best.length} stickers, sat=${scored[0].meanSat.toFixed(2)}`;
    return [face];
  }

  // Connected-component clustering: two stickers are linked if their centers
  // are within ~1.7× the larger sticker's side AND sizes are comparable.
  function clusterStickers(stickers) {
    const n = stickers.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = stickers[i], b = stickers[j];
        const big = Math.max(a.side, b.side);
        const sizeRatio = Math.min(a.side, b.side) / big;
        const dist = Math.hypot(a.cx - b.cx, a.cy - b.cy);
        if (sizeRatio > 0.55 && dist < big * 1.7) union(i, j);
      }
    }
    const groups = {};
    for (let i = 0; i < n; i++) {
      const root = find(i);
      (groups[root] = groups[root] || []).push(stickers[i]);
    }
    return Object.values(groups).filter((g) => g.length >= 3);
  }

  // Sample a 3x3 grid of average colors from a rectangular region.
  function sampleGrid(srcMat, region, detected) {
    const cells = [];
    const cw = region.w / 3, ch = region.h / 3;
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const cx = region.x + cw * (gx + 0.5);
        const cy = region.y + ch * (gy + 0.5);
        // sample a small patch (40% of cell) and average
        const px = Math.max(3, Math.floor(cw * 0.2));
        const py = Math.max(3, Math.floor(ch * 0.2));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = Math.floor(cy - py); yy < cy + py; yy++) {
          for (let xx = Math.floor(cx - px); xx < cx + px; xx++) {
            if (xx < 0 || yy < 0 || xx >= srcMat.cols || yy >= srcMat.rows) continue;
            const idx = (yy * srcMat.cols + xx) * 4;
            r += srcMat.data[idx];
            g += srcMat.data[idx + 1];
            b += srcMat.data[idx + 2];
            n++;
          }
        }
        if (n > 0) { r /= n; g /= n; b /= n; }
        const code = classifyColor(r, g, b);
        cells.push({ code, rgb: [Math.round(r), Math.round(g), Math.round(b)], cx, cy });
      }
    }
    return { cells, detected };
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
        ? `Face ${i + 1} — ${f.stickerCount ?? ""} stickers found`
        : `Face ${i + 1} (center crop — low confidence)`;
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
