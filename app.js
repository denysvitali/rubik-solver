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
  const progressWrap = $("progressWrap");
  const progressFill = $("progressFill");
  const progressLabel = $("progressLabel");
  const canvasWrap = $("canvasWrap");
  const appLogEl = $("appLog");
  const logLines = [];
  let cvReady = false;
  let srcImg = null;     // HTMLImageElement currently loaded
  let lastFace = null;   // last detected face (for copy-to-clipboard)
  let lastFaces = [];    // all detected faces (multi-face)
  let pickMode = false;  // manual corner-picking active
  let pickPts = [];      // clicked corners in full-resolution coords
  let wireframe = null;  // editable cube wireframe {near, ring[6], sideStart} (full-res)
  let dragIdx = null;    // which handle is being dragged: "near" | 0..5
  let ortSession = null, ortLoading = null, modelStatus = "idle";

  function appLog(msg) {
    const ts = new Date().toLocaleTimeString();
    const line = `[${ts}] ${msg}`;
    logLines.push(line);
    if (appLogEl) appLogEl.textContent = logLines.slice(-80).join("\n");
  }

  // Capture all console output + uncaught errors into the visible log
  const _log = console.log.bind(console);
  const _warn = console.warn.bind(console);
  const _error = console.error.bind(console);
  console.log = (...a) => { _log(...a); appLog(a.map(String).join(" ")); };
  console.warn = (...a) => { _warn(...a); appLog("WARN: " + a.map(String).join(" ")); };
  console.error = (...a) => { _error(...a); appLog("ERROR: " + a.map(String).join(" ")); };
  window.addEventListener("error", (e) => appLog("UNCAUGHT: " + e.message + " @ " + e.filename + ":" + e.lineno));
  window.addEventListener("unhandledrejection", (e) => appLog("UNHANDLED REJECTION: " + (e.reason?.message || e.reason)));

  // Copy log button
  $("copyLogBtn")?.addEventListener("click", () => {
    const text = logLines.join("\n");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        $("copyLogBtn").textContent = "Copied ✓";
        setTimeout(() => ($("copyLogBtn").textContent = "Copy"), 1500);
      });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      $("copyLogBtn").textContent = "Copied ✓";
      setTimeout(() => ($("copyLogBtn").textContent = "Copy"), 1500);
    }
  });

  const COLORS = RubikDetector.COLORS;

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
    ensureModel(); // preload the segmentation model so it's ready at detect time
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
    console.log("[load] loadImageFromSrc called, src type:", src.substring(0, 40));
    // Immediate feedback: show loading state so the user knows something is happening.
    statusEl.innerHTML = '<span class="spinner"></span> Loading image…';
    statusEl.classList.remove("ready");
    detectBtn.disabled = true;
    pickBtn.disabled = true;
    canvasWrap.classList.add("loading");

    // For file blobs, read via FileReader → data URL (most compatible across browsers).
    // For remote/same-origin URLs, load directly with Image().
    const finish = (dataUrl) => {
      console.log("[load] finish() called, dataUrl length:", dataUrl?.length);
      const img = new Image();
      img.onload = () => {
        console.log("[load] img.onload fired, size:", img.naturalWidth, "x", img.naturalHeight);
        srcImg = img;
        cancelPick();
        wireframe = null; dragIdx = null;
        canvasWrap.classList.remove("loading");
        drawBase();
        enableActions();
        statusEl.textContent = cvReady ? "OpenCV ready — image loaded" : "Loading OpenCV…";
        statusEl.classList.toggle("ready", cvReady);
      };
      img.onerror = (e) => {
        console.error("[load] img.onerror fired:", e);
        canvasWrap.classList.remove("loading");
        statusEl.textContent = "Failed to load image";
        enableActions();
      };
      img.src = dataUrl;
    };

    if (src.startsWith("blob:")) {
      console.log("[load] blob URL detected, using FileReader path");
      fetch(src).then(r => {
        console.log("[load] fetch ok, status:", r.status);
        return r.blob();
      }).then(blob => {
        console.log("[load] blob ok, size:", blob.size, "type:", blob.type);
        const reader = new FileReader();
        reader.onload = () => {
          console.log("[load] FileReader ok, result length:", reader.result?.length);
          finish(reader.result);
        };
        reader.onerror = (e) => {
          console.error("[load] FileReader error:", e);
          canvasWrap.classList.remove("loading");
          statusEl.textContent = "Failed to read image";
          enableActions();
        };
        reader.readAsDataURL(blob);
      }).catch((e) => {
        console.error("[load] fetch/Reader error:", e);
        canvasWrap.classList.remove("loading");
        statusEl.textContent = "Failed to load image";
        enableActions();
      });
    } else {
      console.log("[load] non-blob URL, loading directly");
      finish(src);
    }
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
    console.log("[file] change event, files:", e.target.files.length, "name:", f?.name, "size:", f?.size);
    if (f) loadImageFromSrc(URL.createObjectURL(f));
    else console.warn("[file] change event but no file!");
  });

  // Test hook: load an arbitrary same-origin image (used by the headless harness)
  window.__loadForTest = (src) => loadImageFromSrc(src);

  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    console.log("[drop] drop event, files:", e.dataTransfer.files.length, "name:", f?.name, "size:", f?.size);
    if (f) loadImageFromSrc(URL.createObjectURL(f));
    else console.warn("[drop] drop event but no file!");
  });

  sampleBtn.addEventListener("click", () => loadImageFromSrc("sample.jpg"));

  detectBtn.addEventListener("click", () => {
    if (!cvReady || !srcImg) return;
    detectBtn.disabled = true;
    statusEl.innerHTML = '<span class="spinner"></span> Detecting…';
    setTimeout(async () => {
      try {
        await runDetection();
        statusEl.textContent = "Detection complete";
        statusEl.classList.add("ready");
      } catch (err) {
        console.error(err);
        statusEl.textContent = "Detection error: " + err.message;
        diag.textContent = String(err.stack || err);
        hideProgress();
      } finally {
        detectBtn.disabled = false;
      }
    }, 30);
  });

  // ---- Neural cube segmentation (onnxruntime-web; u2netp salient model) ----
  // Cleanly isolates the whole cube (incl. white pieces) from hand/background —
  // a far better silhouette seed than colour thresholds. Loaded lazily.
  function ensureModel() {
    if (ortSession) return Promise.resolve(ortSession);
    if (!window.ort) { modelStatus = "onnxruntime-web not loaded (ort missing)"; return Promise.resolve(null); }
    if (!ortLoading) {
      modelStatus = "loading…";
      try { ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/"; } catch (_) {}
      const MODEL_URL = "https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx";
      ortLoading = ort.InferenceSession.create(MODEL_URL)
        .then((s) => { ortSession = s; modelStatus = "ready"; return s; })
        .catch((e) => { console.error("cube model load failed", e); modelStatus = "load failed: " + (e && e.message || e); return null; });
    }
    return ortLoading;
  }
  async function segmentCube(full) {
    const sess = await ensureModel();
    if (!sess) return null;
    const N = 320, rs = new cv.Mat(), rgb = new cv.Mat();
    cv.resize(full, rs, new cv.Size(N, N), 0, 0, cv.INTER_AREA);
    cv.cvtColor(rs, rgb, cv.COLOR_RGBA2RGB);
    const d = rgb.data, mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    const inp = new Float32Array(3 * N * N);
    for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) inp[c * N * N + i] = ((d[i * 3 + c] / 255) - mean[c]) / std[c];
    const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor("float32", inp, [1, 3, N, N]) });
    const sal = out[sess.outputNames[0]].data;
    let mn = Infinity, mx = -Infinity;
    for (const v of sal) { if (v < mn) mn = v; if (v > mx) mx = v; }
    const m = new cv.Mat(N, N, cv.CV_8U);
    const rng = (mx - mn) || 1;
    for (let i = 0; i < N * N; i++) m.data[i] = ((sal[i] - mn) / rng) > 0.5 ? 255 : 0;
    rs.delete(); rgb.delete();
    return m;
  }

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

  const FACE_COLORS = ["#5fd97f", "#4f8cff", "#ffb43d", "#ff6fd0"];

  // ---- Progress bar helpers ----
  function showProgress(pct, label) {
    progressWrap.classList.add("active");
    progressFill.style.width = pct + "%";
    progressLabel.textContent = label;
  }
  function hideProgress() {
    progressWrap.classList.remove("active");
    progressFill.style.width = "0%";
  }

  // ---- Run shared detector, then render ----
  async function runDetection() {
    cancelPick();
    wireframe = null; dragIdx = null;
    const full = fullResMat();
    const ds = overlay.width / srcImg.naturalWidth;

    showProgress(10, "Preparing image…");
    await new Promise((r) => requestAnimationFrame(r)); // let the UI paint

    // Primary: sticker-based multi-face (flat-sticker cubes, 1-2 faces).
    // Fallback: top-down geometric (glossy/stickerless/borderless cubes, where
    // per-piece segmentation fails — segments the cube silhouette and splits it
    // into 1 or 3 face quads).
    showProgress(30, "Searching for sticker grid…");
    const debug = [];
    let faces = RubikDetector.detectFaces(cv, full, { debug });
    let geometric = false;
    if (faces.length === 0) {
      // Neural segmentation for the silhouette (handles glossy/stickerless/
      // white pieces + cluttered background). Falls back internally if absent.
      showProgress(50, "Segmenting cube (neural model)…");
      let cubeMask = null;
      statusEl.innerHTML = '<span class="spinner"></span> Segmenting cube (model)…';
      try { cubeMask = await segmentCube(full); } catch (e) { console.error("segmentation failed", e); }
      showProgress(70, "Fitting geometric silhouette…");
      debug.length = 0;
      faces = RubikDetector.detectFacesGeometric(cv, full, { debug, cubeMask });
      if (cubeMask) cubeMask.delete();
      geometric = faces.length > 0;
    }
    showProgress(90, "Reading face colors…");
    renderDebug(debug);
    if (faces.length > 0) {
      full.delete();
      lastFaces = faces.map((f) => f.face);
      lastFace = lastFaces[0];
      wireframe = (geometric && faces[0] && faces[0].wireframe) ? faces[0].wireframe : null;
      dragIdx = null;
      drawMultiOverlay(faces, ds);
      if (wireframe) drawHandles(ds);
      renderMultiFaces(faces);
      renderLegend();
      diag.textContent =
        `source: ${srcImg.naturalWidth}x${srcImg.naturalHeight}` +
        `\nmethod: ${geometric ? "auto multi-face (geometric silhouette)" : "auto multi-face (sticker grid)"}` +
        (geometric ? `\nsilhouette: ${faces[0].silhouette || "?"}  |  model: ${modelStatus}` : "") +
        `\nfaces detected: ${faces.length}` +
        faces.map((f, i) => `\n  face ${i + 1}: ${f.method || "grid"}`).join("") +
        (wireframe ? "\n→ drag the 7 dots to refine the fit" : "");
      hideProgress();
      return;
    }

    // Fallback: single fronto-parallel face.
    showProgress(70, "Trying single-face fallback…");
    const result = RubikDetector.detectCube(cv, full);
    full.delete();
    lastFace = result.face;
    lastFaces = [result.face];
    showProgress(95, "Rendering result…");

    if (result.method === "grid" && result.corners) {
      drawPerspectiveOverlay(result.corners, result.cluster, ds);
    } else {
      drawOverlay(result.cluster, result.face, ds);
    }
    renderFaces(result.face);
    renderLegend();

    const regionInfo = result.region
      ? `\nface region: ${Math.round(result.region.w)}x${Math.round(result.region.h)} @(${Math.round(result.region.x)},${Math.round(result.region.y)})`
      : `\nface: perspective-correct corners`;
    diag.textContent =
      `source: ${srcImg.naturalWidth}x${srcImg.naturalHeight}` +
      `\nwork: ${result.workSize.w}x${result.workSize.h} (fixed)` +
      `\nmethod: ${result.method} (single-face fallback)` +
      `\nvivid squares: ${result.squareCount}` +
      `\nface stickers: ${result.stickerCount}` +
      regionInfo +
      (result.confident ? "" : "\n(low confidence — center crop)");
    hideProgress();
  }

  // Draw every detected face's quad + perspective 3x3 grid, each a distinct color.
  function drawMultiOverlay(faces, ds) {
    drawBase();
    const ctx = overlay.getContext("2d");
    const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    faces.forEach((f, fi) => {
      const col = FACE_COLORS[fi % FACE_COLORS.length];
      // use the corners in their native order — it matches the perspective warp
      // used to sample the 3x3 (re-ordering would misdraw geometric face quads)
      const c = f.corners.map((p) => ({ x: p.x * ds, y: p.y * ds }));
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.beginPath();
      c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath(); ctx.stroke();
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.6;
      for (let i = 1; i < 3; i++) {
        const t = i / 3;
        const top = lerp(c[0], c[1], t), bot = lerp(c[3], c[2], t);
        ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke();
        const left = lerp(c[0], c[3], t), right = lerp(c[1], c[2], t);
        ctx.beginPath(); ctx.moveTo(left.x, left.y); ctx.lineTo(right.x, right.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
  }

  function renderMultiFaces(faces) {
    facesEl.innerHTML = "";
    faces.forEach((f, i) => {
      facesEl.appendChild(buildFaceCard(f.face, `Face ${i + 1} — ${f.stickerCount} stickers`, FACE_COLORS[i % FACE_COLORS.length]));
    });
  }

  // ---- Editable wireframe: drag the 7 handles (near-corner + 6 outer) ----
  function wfHandles() {
    return wireframe ? [{ id: "near", p: wireframe.near }, ...wireframe.ring.map((p, i) => ({ id: i, p }))] : [];
  }
  function drawHandles(ds) {
    if (!wireframe) return;
    const ctx = overlay.getContext("2d");
    for (const h of wfHandles()) {
      const x = h.p.x * ds, y = h.p.y * ds;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = h.id === "near" ? "#ff3b3b" : "#ffffff";
      ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
    }
  }
  function fullPt(e) {
    const rect = overlay.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (overlay.width / rect.width);
    const cy = (e.clientY - rect.top) * (overlay.height / rect.height);
    const ds = overlay.width / srcImg.naturalWidth;
    return { x: cx / ds, y: cy / ds, ds };
  }
  function setHandle(id, p) { if (id === "near") wireframe.near = p; else wireframe.ring[id] = p; }
  // live redraw during drag (geometry only, no re-sampling)
  function redrawWireframe(ds) {
    const faces = RubikDetector.facesFromWireframe(null, null, wireframe);
    drawMultiOverlay(faces, ds);
    drawHandles(ds);
  }
  function resampleWireframe() {
    const full = fullResMat();
    const faces = RubikDetector.facesFromWireframe(cv, full, wireframe);
    full.delete();
    lastFaces = faces.map((f) => f.face);
    lastFace = lastFaces[0];
    const ds = overlay.width / srcImg.naturalWidth;
    drawMultiOverlay(faces, ds);
    drawHandles(ds);
    renderMultiFaces(faces);
  }
  overlay.addEventListener("mousedown", (e) => {
    if (pickMode || !wireframe) return;
    const { x, y, ds } = fullPt(e);
    const thresh = 14 / ds; // ~14 display px
    let bestId = null, bestD = thresh;
    for (const h of wfHandles()) { const d = Math.hypot(h.p.x - x, h.p.y - y); if (d < bestD) { bestD = d; bestId = h.id; } }
    if (bestId !== null) { dragIdx = bestId; e.preventDefault(); }
  });
  overlay.addEventListener("mousemove", (e) => {
    if (dragIdx === null || !wireframe) return;
    const { x, y, ds } = fullPt(e);
    setHandle(dragIdx, { x, y });
    redrawWireframe(ds);
  });
  window.addEventListener("mouseup", () => {
    if (dragIdx === null) return;
    dragIdx = null;
    try { resampleWireframe(); } catch (err) { console.error(err); }
  });

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

  // Perspective-correct overlay: draw the detected stickers and the face quad.
  function drawPerspectiveOverlay(corners, cluster, ds) {
    drawBase();
    const ctx = overlay.getContext("2d");
    // Draw detected sticker boxes
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(79,140,255,0.9)";
    for (const s of cluster) {
      ctx.strokeRect(s.rect.x * ds, s.rect.y * ds, s.rect.width * ds, s.rect.height * ds);
    }
    // Draw the face quadrilateral
    const c = corners.map((p) => ({ x: p.x * ds, y: p.y * ds }));
    ctx.strokeStyle = "rgba(95,217,127,0.95)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath(); ctx.stroke();
    // Perspective 3x3 grid via edge interpolation
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

  // ---- Faces panel ----
  function faceToText(face) {
    let out = "";
    for (let i = 0; i < 9; i += 3) {
      out += face.cells.slice(i, i + 3).map((c) => c.code).join(" ") + "\n";
    }
    return out.trimEnd();
  }

  // Build one face card (grid + per-face copy button). accent optionally
  // tints the title to match the overlay color for that face.
  function buildFaceCard(face, title, accent) {
    const card = document.createElement("div");
    card.className = "face-card";

    const head = document.createElement("div");
    head.className = "face-head";
    const h = document.createElement("h3");
    h.textContent = title;
    if (accent) h.style.color = accent;
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn secondary copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => copyFace(face, copyBtn));
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
    return card;
  }

  function renderFaces(face) {
    facesEl.innerHTML = "";
    if (!face) { facesEl.innerHTML = '<div class="empty">No cube face detected.</div>'; return; }
    const title = face.detected
      ? `Detected face — located via ${face.stickerCount ?? 0} sticker(s)`
      : `Face (center crop — low confidence)`;
    facesEl.appendChild(buildFaceCard(face, title));
  }

  function copyFace(face, btn) {
    if (!face) return;
    const text = faceToText(face);
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

  // Render intermediate detection steps into the collapsed debug section.
  function renderDebug(imgs) {
    const box = $("debugSteps"), details = $("debugDetails");
    if (!box || !details) return;
    box.innerHTML = "";
    if (!imgs || !imgs.length) { details.setAttribute("hidden", ""); return; }
    details.removeAttribute("hidden");
    for (const im of imgs) {
      const fig = document.createElement("figure");
      const tmp = document.createElement("canvas");
      tmp.width = im.width; tmp.height = im.height;
      tmp.getContext("2d").putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
      const c = document.createElement("canvas");
      const s = Math.min(1, 240 / im.width);
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      c.getContext("2d").drawImage(tmp, 0, 0, c.width, c.height);
      const cap = document.createElement("figcaption");
      cap.textContent = im.name;
      fig.appendChild(c); fig.appendChild(cap); box.appendChild(fig);
    }
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
