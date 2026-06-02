/* Rubik's Cube Detector — browser UI. All detection lives in the shared
 * detector.js module (RubikDetector), used verbatim by the Node test harness. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const overlay = $("overlay");
  const fileInput = $("file");
  const drop = $("drop");
  const detectBtn = $("detectBtn");
  const sampleBtn = $("sampleBtn");
  const pickBtn = $("pickBtn");
  const facesEl = $("faces");
  const legendEl = $("legend");
  const diag = $("diag");

  const COLORS = RubikDetector.COLORS;
  let cvReady = false;
  let srcImg = null;     // HTMLImageElement currently loaded
  let lastFace = null;   // last detected face (for copy-to-clipboard)
  let pickMode = false;  // manual corner-picking active
  let pickPts = [];      // clicked corners in full-resolution coords

  const enableActions = () => {
    const on = cvReady && srcImg;
    detectBtn.disabled = !on;
    pickBtn.disabled = !on;
  };

  // ---- OpenCV load handling ----
  function onCvReady() {
    cvReady = true;
    statusEl.textContent = "OpenCV ready";
    statusEl.classList.add("ready");
    enableActions();
  }

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
      cancelPick();
      drawBase();
      enableActions();
      statusEl.textContent = cvReady ? "OpenCV ready — image loaded" : "Loading OpenCV…";
      statusEl.classList.toggle("ready", cvReady);
    };
    img.onerror = () => { statusEl.textContent = "Failed to load image"; };
    img.src = src;
  }

  // Draw the image into the (display-sized) overlay canvas.
  function drawBase() {
    const maxW = 520;
    const scale = Math.min(1, maxW / srcImg.naturalWidth);
    overlay.width = Math.round(srcImg.naturalWidth * scale);
    overlay.height = Math.round(srcImg.naturalHeight * scale);
    overlay.getContext("2d").drawImage(srcImg, 0, 0, overlay.width, overlay.height);
  }

  // Full-resolution RGBA Mat of the original image (detection input). Drawing
  // at natural size — not the downscaled display — keeps detection independent
  // of how big the canvas happens to be shown.
  function fullResMat() {
    const off = document.createElement("canvas");
    off.width = srcImg.naturalWidth;
    off.height = srcImg.naturalHeight;
    off.getContext("2d").drawImage(srcImg, 0, 0);
    return cv.imread(off);
  }

  fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadImageFromSrc(URL.createObjectURL(f));
  });

  // Test hook: load an arbitrary same-origin image (used by the headless harness)
  window.__loadForTest = (src) => loadImageFromSrc(src);

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) loadImageFromSrc(URL.createObjectURL(f));
  });

  sampleBtn.addEventListener("click", () => loadImageFromSrc("sample.jpg"));

  detectBtn.addEventListener("click", () => {
    if (!cvReady || !srcImg) return;
    detectBtn.disabled = true;
    statusEl.innerHTML = '<span class="spinner"></span> Detecting…';
    setTimeout(() => {
      try {
        runDetection();
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

  // ---- Manual corner picking (for angled / multi-face photos) ----
  pickBtn.addEventListener("click", () => {
    if (!cvReady || !srcImg) return;
    if (pickMode) { cancelPick(); return; }
    pickMode = true;
    pickPts = [];
    pickBtn.textContent = "Cancel";
    statusEl.textContent = "Click corner 1 of 4 (any face, in order around it)";
    statusEl.classList.remove("ready");
    drawBase();
  });

  function cancelPick() {
    pickMode = false;
    pickPts = [];
    if (pickBtn) pickBtn.textContent = "Pick corners";
  }

  overlay.addEventListener("click", (e) => {
    if (!pickMode || !srcImg) return;
    const rect = overlay.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (overlay.width / rect.width);
    const cy = (e.clientY - rect.top) * (overlay.height / rect.height);
    const ds = overlay.width / srcImg.naturalWidth;         // display → full-res
    pickPts.push({ x: cx / ds, y: cy / ds });
    drawPickProgress(ds);
    if (pickPts.length < 4) {
      statusEl.textContent = `Click corner ${pickPts.length + 1} of 4`;
    } else {
      finishPick();
    }
  });

  function drawPickProgress(ds) {
    drawBase();
    const ctx = overlay.getContext("2d");
    ctx.fillStyle = "#ff3df0";
    ctx.strokeStyle = "rgba(255,61,240,0.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    pickPts.forEach((p, i) => {
      const x = p.x * ds, y = p.y * ds;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (pickPts.length > 1) ctx.stroke();
    for (const p of pickPts) {
      ctx.beginPath();
      ctx.arc(p.x * ds, p.y * ds, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function finishPick() {
    const corners = pickPts.slice(); // snapshot before cancelPick() clears it
    cancelPick();
    statusEl.innerHTML = '<span class="spinner"></span> Warping & reading face…';
    setTimeout(() => {
      try {
        const full = fullResMat();
        const face = RubikDetector.sampleQuad(cv, full, corners);
        full.delete();
        lastFace = face;
        const ds = overlay.width / srcImg.naturalWidth;
        drawQuadOverlay(face, ds);
        renderFaces(face);
        renderLegend();
        diag.textContent =
          `source: ${srcImg.naturalWidth}x${srcImg.naturalHeight}` +
          `\nmethod: manual corners (perspective warp)`;
        statusEl.textContent = "Detection complete (manual)";
        statusEl.classList.add("ready");
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Manual detect error: " + err.message;
      }
    }, 30);
  }

  function drawQuadOverlay(face, ds) {
    drawBase();
    const ctx = overlay.getContext("2d");
    const c = face.corners.map((p) => ({ x: p.x * ds, y: p.y * ds }));
    // outer quad
    ctx.strokeStyle = "rgba(95,217,127,0.95)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath(); ctx.stroke();
    // perspective 3x3 grid via edge interpolation (TL,TR,BR,BL)
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    ctx.strokeStyle = "rgba(95,217,127,0.55)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const t = i / 3;
      const top = lerp(c[0], c[1], t), bot = lerp(c[3], c[2], t);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
      const left = lerp(c[0], c[3], t), right = lerp(c[1], c[2], t);
      ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.stroke();
    }
  }

  // ---- Run shared detector, then render ----
  function runDetection() {
    cancelPick();
    const full = fullResMat();
    const result = RubikDetector.detectCube(cv, full);
    full.delete();

    lastFace = result.face;
    const ds = overlay.width / srcImg.naturalWidth; // display scale (full → canvas)
    drawOverlay(result.cluster, result.face, ds);
    renderFaces(result.face);
    renderLegend();

    diag.textContent =
      `source: ${srcImg.naturalWidth}x${srcImg.naturalHeight}` +
      `\nwork: ${result.workSize.w}x${result.workSize.h} (fixed)` +
      `\nmethod: ${result.method}` +
      `\nvivid squares: ${result.squareCount}` +
      `\nface stickers: ${result.stickerCount}` +
      `\nface region: ${Math.round(result.region.w)}x${Math.round(result.region.h)} @(${Math.round(result.region.x)},${Math.round(result.region.y)})` +
      (result.confident ? "" : "\n(low confidence — center crop)");
  }

  // ---- Overlay drawing (coords are full-res; scale to the display canvas) ----
  function drawOverlay(cluster, face, ds) {
    drawBase();
    const ctx = overlay.getContext("2d");
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(79,140,255,0.9)";
    for (const s of cluster) {
      ctx.strokeRect(s.rect.x * ds, s.rect.y * ds, s.rect.width * ds, s.rect.height * ds);
    }
    if (face.region) {
      const x = face.region.x * ds, y = face.region.y * ds, w = face.region.w * ds, h = face.region.h * ds;
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
  function faceToText(face) {
    let out = "";
    for (let i = 0; i < 9; i += 3) {
      out += face.cells.slice(i, i + 3).map((c) => c.code).join(" ") + "\n";
    }
    return out.trimEnd();
  }

  function renderFaces(face) {
    facesEl.innerHTML = "";
    if (!face) { facesEl.innerHTML = '<div class="empty">No cube face detected.</div>'; return; }

    const card = document.createElement("div");
    card.className = "face-card";

    const head = document.createElement("div");
    head.className = "face-head";
    const h = document.createElement("h3");
    h.textContent = face.detected
      ? `Detected face — located via ${face.stickerCount ?? 0} sticker(s)`
      : `Face (center crop — low confidence)`;
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn secondary copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => copyFace(copyBtn));
    head.appendChild(h);
    head.appendChild(copyBtn);

    const grid = document.createElement("div");
    grid.className = "grid3";
    face.cells.forEach((c) => {
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

    card.appendChild(head);
    card.appendChild(grid);
    facesEl.appendChild(card);
  }

  function copyFace(btn) {
    if (!lastFace) return;
    const text = faceToText(lastFace);
    const done = () => { btn.textContent = "Copied ✓"; setTimeout(() => (btn.textContent = "Copy"), 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
    done();
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
