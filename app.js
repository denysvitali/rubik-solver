/* Rubik's Cube Detector — browser UI. All detection lives in the shared
 * detector.js module (RubikDetector), used verbatim by the Node test harness. */
(() => {
  "use strict";

  // ---- URL-flag dev shortcuts: bookmark
  //   ?debug=1&autorun=1&img=sample.jpg
  // to skip the 4-click ritual per iteration.
  const $ = (id) => document.getElementById(id);
  const Q = new URLSearchParams(location.search);
  const URL_DEBUG = Q.has("debug");
  const URL_AUTORUN = Q.has("autorun");
  const URL_IMG = Q.get("img");
  if (URL_DEBUG) {
    $("debugDetails") && ($("debugDetails").hidden = false);
    $("logDetails") && ($("logDetails").open = true);
  }

  const statusEl = $("status");
  const statusTextEl = $("statusText");
  const overlay = $("overlay");
  const fileInput = $("file");
  const drop = $("drop");
  const detectBtn = $("detectBtn");
  const pickBtn = $("pickBtn");
  const exportAnnoBtn = $("exportAnnoBtn");
  const newImageBtn = $("newImageBtn");
  const facesEl = $("faces");
  const legendEl = $("legend");
  const diag = $("diag");
  const progressWrap = $("progressWrap");
  const progressFill = $("progressFill");
  const progressLabel = $("progressLabel");
  const progressPct = $("progressPct");
  const canvasWrap = $("canvasWrap");
  const appLogEl = $("appLog");
  const logLines = [];
  const dropCard = $("dropCard");
  const canvasCard = $("canvasCard");
  const imgDimsEl = $("imgDims");
  const imgSizeEl = $("imgSize");
  const summaryEl = $("summary");
  const resultsMetaEl = $("resultsMeta");
  const dropOverlay = $("dropOverlay");

  const state = {
    cvReady: false,
    srcImg: null,       // HTMLImageElement currently loaded
    srcFile: null,      // File (if user picked one, for size display)
    lastFace: null,     // last detected face (for copy-to-clipboard)
    lastFaces: [],      // all detected faces (multi-face)
    lastFaceDetections: [], // detected face records with corners/method for annotation export
    pickMode: false,    // manual corner-picking active
    pickPts: [],        // clicked corners in full-resolution coords
    wireframe: null,    // editable cube wireframe {near, ring[6], sideStart} (full-res)
    dragIdx: null,      // which handle is being dragged: "near" | 0..5
    ortSession: null,
    ortLoading: null,
    modelStatus: "idle",
  };

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
  exportAnnoBtn?.addEventListener("click", copyAnnotation);

  const COLORS = RubikDetector.COLORS;

  // ---- Status pill (color-coded, with optional spinner) ----
  // state: undefined | "ready" | "busy" | "err"
  function setStatus(state, html) {
    statusEl.className = "status" + (state ? " " + state : "");
    statusTextEl.innerHTML = html || "";
  }
  function setStatusText(text) { statusTextEl.textContent = text; }
  function setStatusSpinner(label) {
    statusTextEl.innerHTML = '<span class="spinner"></span> ' + label;
  }

  const enableActions = () => {
    const on = state.cvReady && state.srcImg;
    detectBtn.disabled = !on;
    pickBtn.disabled = !on;
    if (exportAnnoBtn) exportAnnoBtn.disabled = !on || state.lastFaceDetections.length === 0;
  };

  // ---- OpenCV load handling ----
  function onCvReady() {
    state.cvReady = true;
    setStatus("ready", "OpenCV ready");
    enableActions();
    ensureModel(); // preload the segmentation model so it's ready at detect time
  }

  function waitForCv() {
    let attempts = 0;
    const failCv = (err) => {
      setStatus("err", "Failed to load OpenCV");
      console.error("OpenCV did not initialize", err || "");
    };
    const resolveCv = (loader) => {
      loader.then((real) => { window.cv = real; onCvReady(); }, failCv);
    };
    if (window.cv && typeof cv.then === "function") {
      resolveCv(cv);
      return;
    }
    if (window.cv && cv.Mat) { onCvReady(); return; }
    if (window.cv) cv["onRuntimeInitialized"] = onCvReady;
    const t = setInterval(() => {
      if (window.cv && typeof cv.then === "function") {
        clearInterval(t); resolveCv(cv); return;
      }
      if (window.cv && cv.Mat) { clearInterval(t); onCvReady(); }
      if (++attempts >= 150) {
        clearInterval(t);
        failCv();
      }
    }, 100);
  }
  waitForCv();

  // ---- View switching (drop zone ↔ canvas) ----
  function showDropZone() {
    dropCard.hidden = false;
    canvasCard.hidden = true;
    // reset UI
    state.srcImg = null;
    state.srcFile = null;
    state.lastFace = null;
    state.lastFaces = [];
    state.lastFaceDetections = [];
    state.wireframe = null;
    state.dragIdx = null;
    facesEl.innerHTML = `
      <div class="empty-state">
        <svg class="empty-illus" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="8" y="8" width="48" height="48" rx="8" fill="#f3f4f6" stroke="#d6d1c4" stroke-width="1.5" stroke-dasharray="3 3"/>
          <path d="M22 32h20M32 22v20" stroke="#9aa0ac" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <h3>No faces detected yet</h3>
        <p>Load a cube photo, then press <b>Detect cube</b>.</p>
      </div>`;
    legendEl.innerHTML = "";
    summaryEl.hidden = true;
    summaryEl.innerHTML = "";
    resultsMetaEl.textContent = "No image yet";
    setStatus(state.cvReady ? "ready" : null, state.cvReady ? "OpenCV ready" : "Loading OpenCV…");
  }
  function showCanvas() {
    dropCard.hidden = true;
    canvasCard.hidden = false;
  }

  // ---- Image loading ----
  function loadImageFromSrc(src, file) {
    setStatus("busy", '<span class="spinner"></span> Loading image…');
    detectBtn.disabled = true;
    pickBtn.disabled = true;
    canvasWrap.classList.add("loading");
    if (URL_DEBUG) appLog(`[load] ${src.substring(0, 60)}`);

    state.srcFile = file || null;

    const finish = (dataUrl) => {
      const img = new Image();
      img.onload = () => {
        if (URL_DEBUG) appLog(`[load] ${img.naturalWidth}x${img.naturalHeight}`);
        state.srcImg = img;
        cancelPick();
        state.wireframe = null; state.dragIdx = null;
        state.lastFace = null;
        state.lastFaces = [];
        state.lastFaceDetections = [];
        canvasWrap.classList.remove("loading");
        // Reset results panel for the new image
        facesEl.innerHTML = `
          <div class="empty-state">
            <h3>Ready to detect</h3>
            <p>Press <b>Detect cube</b> below the image.</p>
          </div>`;
        legendEl.innerHTML = "";
        summaryEl.hidden = true;
        summaryEl.innerHTML = "";
        resultsMetaEl.textContent = "Image loaded — awaiting detection";
        // Meta
        imgDimsEl.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
        if (state.srcFile) {
          const kb = state.srcFile.size / 1024;
          imgSizeEl.textContent = kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
        } else {
          imgSizeEl.textContent = "";
        }
        showCanvas();
        drawBase();
        enableActions();
        if (state.cvReady) setStatus("ready", "Image loaded — ready to detect");
        else setStatus(null, "Loading OpenCV…");
      };
      img.onerror = (e) => {
        console.error("img.onerror", e);
        canvasWrap.classList.remove("loading");
        setStatus("err", "Failed to load image");
        enableActions();
      };
      img.src = dataUrl;
    };

    if (src.startsWith("blob:")) {
      fetch(src).then(r => r.blob()).then(blob => {
        const reader = new FileReader();
        reader.onload = () => finish(reader.result);
        reader.onerror = (e) => {
          console.error("FileReader error", e);
          canvasWrap.classList.remove("loading");
          setStatus("err", "Failed to read image");
          enableActions();
        };
        reader.readAsDataURL(blob);
      }).catch((e) => {
        console.error("fetch/Reader error", e);
        canvasWrap.classList.remove("loading");
        setStatus("err", "Failed to load image");
        enableActions();
      });
    } else {
      finish(src);
    }
  }

  // Apply ?autorun=1&img=foo.jpg URL flag (combined with ?debug=1 at the top)
  if (URL_AUTORUN || URL_IMG) {
    setTimeout(() => loadImageFromSrc(URL_IMG || "sample.jpg"), 50);
  }

  // Draw the image into the (display-sized) overlay canvas.
  function drawBase() {
    const maxW = 720;
    const scale = Math.min(1, maxW / state.srcImg.naturalWidth);
    overlay.width = Math.round(state.srcImg.naturalWidth * scale);
    overlay.height = Math.round(state.srcImg.naturalHeight * scale);
    overlay.getContext("2d").drawImage(state.srcImg, 0, 0, overlay.width, overlay.height);
  }

  // Full-resolution RGBA Mat of the original image (detection input). Drawing
  // at natural size — not the downscaled display — keeps detection independent
  // of how big the canvas happens to be shown.
  function fullResMat() {
    const off = document.createElement("canvas");
    off.width = state.srcImg.naturalWidth;
    off.height = state.srcImg.naturalHeight;
    off.getContext("2d").drawImage(state.srcImg, 0, 0);
    return cv.imread(off);
  }

  fileInput.addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadImageFromSrc(URL.createObjectURL(f), f);
    // reset so picking the same file again still triggers change
    e.target.value = "";
  });

  // Test hook: load an arbitrary same-origin image (used by the headless harness)
  window.__loadForTest = (src) => loadImageFromSrc(src);

  // Drop zone interactions (on the label)
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("drag");
    const f = e.dataTransfer.files[0];
    if (f) loadImageFromSrc(URL.createObjectURL(f), f);
  });

  // Sample chips (on the drop card)
  document.querySelectorAll(".sample-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      const src = chip.getAttribute("data-sample");
      if (src) loadImageFromSrc(src);
    });
  });

  // "New image" button → back to drop zone
  newImageBtn?.addEventListener("click", () => {
    cancelPick();
    hideProgress();
    showDropZone();
  });

  // ---- Full-window drop overlay (drag from outside the drop zone too) ----
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !e.dataTransfer.types.includes("Files")) return;
    dragDepth++;
    dropOverlay.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.hidden = true;
  });
  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && e.dataTransfer.types.includes("Files")) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    dragDepth = 0;
    dropOverlay.hidden = true;
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      e.preventDefault();
      loadImageFromSrc(URL.createObjectURL(f), f);
    }
  });

  // ---- Keyboard shortcuts ----
  window.addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "d" && !detectBtn.disabled) { e.preventDefault(); detectBtn.click(); }
    else if (k === "p" && !pickBtn.disabled) { e.preventDefault(); pickBtn.click(); }
    else if (k === "n") { e.preventDefault(); newImageBtn?.click(); }
  });

  detectBtn.addEventListener("click", () => {
    if (!state.cvReady || !state.srcImg) return;
    detectBtn.disabled = true;
    setStatus("busy", '<span class="spinner"></span> Detecting…');
    setTimeout(async () => {
      try {
        await runDetection();
        setStatus("ready", "Detection complete");
      } catch (err) {
        console.error(err);
        setStatus("err", "Detection error: " + err.message);
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
    if (state.ortSession) return Promise.resolve(state.ortSession);
    if (!window.ort) { state.modelStatus = "onnxruntime-web not loaded (ort missing)"; return Promise.resolve(null); }
    if (!state.ortLoading) {
      state.modelStatus = "loading…";
      try { ort.env.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/"; } catch (_) {}
      const MODEL_URL = "https://huggingface.co/tomjackson2023/rembg/resolve/main/u2netp.onnx";
      state.ortLoading = ort.InferenceSession.create(MODEL_URL)
        .then((s) => { state.ortSession = s; state.modelStatus = "ready"; return s; })
        .catch((e) => { console.error("cube model load failed", e); state.modelStatus = "load failed: " + (e && e.message || e); return null; });
    }
    return state.ortLoading;
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
    if (!state.cvReady || !state.srcImg) return;
    if (state.pickMode) { cancelPick(); return; }
    state.pickMode = true;
    state.pickPts = [];
    pickBtn.textContent = "Cancel";
    setStatus("busy", "Click corner 1 of 4 (in order around the face)");
    drawBase();
  });

  function cancelPick() {
    state.pickMode = false;
    state.pickPts = [];
    if (pickBtn) pickBtn.textContent = "Pick corners";
  }

  overlay.addEventListener("click", (e) => {
    if (!state.pickMode || !state.srcImg) return;
    const rect = overlay.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (overlay.width / rect.width);
    const cy = (e.clientY - rect.top) * (overlay.height / rect.height);
    const ds = overlay.width / state.srcImg.naturalWidth;         // display → full-res
    state.pickPts.push({ x: cx / ds, y: cy / ds });
    drawPickProgress(ds);
    if (state.pickPts.length < 4) {
      setStatus("busy", `Click corner ${state.pickPts.length + 1} of 4`);
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
    state.pickPts.forEach((p, i) => {
      const x = p.x * ds, y = p.y * ds;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    if (state.pickPts.length > 1) ctx.stroke();
    for (const p of state.pickPts) {
      ctx.beginPath();
      ctx.arc(p.x * ds, p.y * ds, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function finishPick() {
    const corners = state.pickPts.slice(); // snapshot before cancelPick() clears it
    cancelPick();
    setStatus("busy", '<span class="spinner"></span> Warping & reading face…');
    setTimeout(() => {
      try {
        const full = fullResMat();
        const face = RubikDetector.sampleQuad(cv, full, corners);
        full.delete();
        state.lastFace = face;
        const ds = overlay.width / state.srcImg.naturalWidth;
        drawQuadOverlay(face, ds);
        renderFaces(face);
        renderLegend();
        renderSummary([{ face, method: "manual corners", stickerCount: 9 }], "manual corners");
        diag.textContent =
          `source: ${state.srcImg.naturalWidth}x${state.srcImg.naturalHeight}` +
          `\nmethod: manual corners (perspective warp)`;
        setStatus("ready", "Detection complete (manual)");
      } catch (err) {
        console.error(err);
        setStatus("err", "Manual detect error: " + err.message);
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

  const FACE_COLORS = ["#10b981", "#3b82f6", "#fbbf24", "#ec4899"];

  // ---- Progress bar helpers ----
  function showProgress(pct, label) {
    progressWrap.classList.add("active");
    progressFill.style.width = pct + "%";
    progressLabel.textContent = label;
    if (progressPct) progressPct.textContent = Math.round(pct) + "%";
  }
  function hideProgress() {
    progressWrap.classList.remove("active");
    progressFill.style.width = "0%";
    if (progressPct) progressPct.textContent = "0%";
  }

  // ---- Run shared detector, then render ----
  async function runDetection() {
    cancelPick();
    state.wireframe = null; state.dragIdx = null;
    const full = fullResMat();
    const ds = overlay.width / state.srcImg.naturalWidth;

    showProgress(10, "Preparing image…");
    await new Promise((r) => requestAnimationFrame(r)); // let the UI paint

    showProgress(30, "Running detection pipeline…");
    const pipelineResult = await RubikPipeline.runPipeline(cv, full, {
      detector: RubikDetector,
      locateFaces: null,
      segmentCube: async (mat) => {
        showProgress(60, "Segmenting cube (neural model)…");
        setStatus("busy", '<span class="spinner"></span> Segmenting cube (model)…');
        return await segmentCube(mat);
      },
    });
    showProgress(90, "Reading face colors…");
    renderDebug([...(pipelineResult.pipeline || []), ...(pipelineResult.debug || [])]);

    if (pipelineResult.kind === "multi" && pipelineResult.faces.length > 0) {
      const faces = pipelineResult.faces;
      const geometric = !!pipelineResult.geometric;
      full.delete();
      state.lastFaces = faces.map((f) => f.face);
      state.lastFace = state.lastFaces[0];
      state.lastFaceDetections = faces;
      state.wireframe = (geometric && faces[0] && faces[0].wireframe) ? faces[0].wireframe : null;
      state.dragIdx = null;
      drawMultiOverlay(faces, ds);
      if (state.wireframe) drawHandles(ds);
      renderMultiFaces(faces);
      renderLegend();
      const method = pipelineResult.method;
      renderSummary(faces, method);
      enableActions();
      diag.textContent =
        `source: ${state.srcImg.naturalWidth}x${state.srcImg.naturalHeight}` +
        `\nmethod: ${method}` +
        `\npipeline: ${pipelineResult.pipeline.map((s) => `${s.id}:${s.status}`).join(" → ")}` +
        (geometric ? `\nsilhouette: ${faces[0].silhouette || "?"}  |  model: ${state.modelStatus}` : "") +
        `\nfaces detected: ${faces.length}` +
        faces.map((f, i) => `\n  face ${i + 1}: ${f.method || "grid"}`).join("") +
        (wfHandles().length ? "\n→ drag the dots to refine the fit" : "");
      hideProgress();
      return;
    }

    // Fallback: single fronto-parallel face.
    const result = pipelineResult.result || RubikDetector.detectCube(cv, full);
    full.delete();
    state.lastFace = result.face;
    state.lastFaces = [result.face];
    state.lastFaceDetections = [{
      face: result.face,
      corners: result.corners || null,
      stickerCount: result.stickerCount,
      method: result.method,
    }];
    showProgress(95, "Rendering result…");

    if (result.method === "grid" && result.corners) {
      drawPerspectiveOverlay(result.corners, result.cluster, ds);
    } else {
      drawOverlay(result.cluster, result.face, ds);
    }
    renderFaces(result.face);
    renderLegend();
    renderSummary([{ face: result.face, method: result.method, stickerCount: result.stickerCount }], result.method);
    enableActions();

    const regionInfo = result.region
      ? `\nface region: ${Math.round(result.region.w)}x${Math.round(result.region.h)} @(${Math.round(result.region.x)},${Math.round(result.region.y)})`
      : `\nface: perspective-correct corners`;
    diag.textContent =
      `source: ${state.srcImg.naturalWidth}x${state.srcImg.naturalHeight}` +
      `\nwork: ${result.workSize.w}x${result.workSize.h} (fixed)` +
      `\nmethod: ${pipelineResult.method || result.method}` +
      `\npipeline: ${pipelineResult.pipeline.map((s) => `${s.id}:${s.status}`).join(" → ")}` +
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
      const swatch = FACE_COLORS[i % FACE_COLORS.length];
      const title = `Face ${i + 1}`;
      facesEl.appendChild(buildFaceCard(f.face, title, swatch, f.stickerCount));
    });
  }

  // ---- Editable face corners / wireframe handles ----
  function wfHandles() {
    if (state.lastFaceDetections.some((face) => Array.isArray(face.corners))) {
      return state.lastFaceDetections.flatMap((face, faceIndex) =>
        face.corners.map((p, cornerIndex) => ({
          id: { faceIndex, cornerIndex },
          p,
          color: FACE_COLORS[faceIndex % FACE_COLORS.length],
        })),
      );
    }
    return state.wireframe ? [{ id: "near", p: state.wireframe.near }, ...state.wireframe.ring.map((p, i) => ({ id: i, p }))] : [];
  }
  function drawHandles(ds) {
    const handles = wfHandles();
    if (!handles.length) return;
    const ctx = overlay.getContext("2d");
    for (const h of handles) {
      const x = h.p.x * ds, y = h.p.y * ds;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = h.color || (h.id === "near" ? "#ff3b3b" : "#ffffff");
      ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#000"; ctx.stroke();
    }
  }
  function fullPt(e) {
    const rect = overlay.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (overlay.width / rect.width);
    const cy = (e.clientY - rect.top) * (overlay.height / rect.height);
    const ds = overlay.width / state.srcImg.naturalWidth;
    return { x: cx / ds, y: cy / ds, ds };
  }
  function setHandle(id, p) {
    if (id && typeof id === "object") {
      state.lastFaceDetections[id.faceIndex].corners[id.cornerIndex] = p;
      return;
    }
    if (id === "near") state.wireframe.near = p;
    else state.wireframe.ring[id] = p;
  }
  // live redraw during drag (geometry only, no re-sampling)
  function redrawWireframe(ds) {
    const faces = state.lastFaceDetections.some((face) => Array.isArray(face.corners))
      ? state.lastFaceDetections
      : RubikDetector.facesFromWireframe(null, null, state.wireframe);
    drawMultiOverlay(faces, ds);
    drawHandles(ds);
  }
  function resampleWireframe() {
    const full = fullResMat();
    const faces = state.lastFaceDetections.some((face) => Array.isArray(face.corners))
      ? state.lastFaceDetections.map((face) => ({
          ...face,
          face: RubikDetector.readFaceQuad(cv, full, face.corners),
          stickerCount: 9,
          method: face.method || "manual-quad",
        }))
      : RubikDetector.facesFromWireframe(cv, full, state.wireframe);
    full.delete();
    state.lastFaces = faces.map((f) => f.face);
    state.lastFace = state.lastFaces[0];
    state.lastFaceDetections = faces;
    const ds = overlay.width / state.srcImg.naturalWidth;
    drawMultiOverlay(faces, ds);
    drawHandles(ds);
    renderMultiFaces(faces);
    enableActions();
  }
  overlay.addEventListener("mousedown", (e) => {
    if (state.pickMode || !wfHandles().length) return;
    const { x, y, ds } = fullPt(e);
    const thresh = 14 / ds; // ~14 display px
    let bestId = null, bestD = thresh;
    for (const h of wfHandles()) { const d = Math.hypot(h.p.x - x, h.p.y - y); if (d < bestD) { bestD = d; bestId = h.id; } }
    if (bestId !== null) { state.dragIdx = bestId; e.preventDefault(); }
  });
  overlay.addEventListener("mousemove", (e) => {
    if (state.dragIdx === null) return;
    const { x, y, ds } = fullPt(e);
    setHandle(state.dragIdx, { x, y });
    redrawWireframe(ds);
  });
  window.addEventListener("mouseup", () => {
    if (state.dragIdx === null) return;
    state.dragIdx = null;
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

  function faceGrid(face) {
    return face.cells.map((cell) => cell.code).join("");
  }

  function annotationForCurrentImage() {
    if (!state.srcImg || !state.lastFaceDetections.length) return null;
    return {
      image: {
        width: state.srcImg.naturalWidth,
        height: state.srcImg.naturalHeight,
        name: state.srcFile ? state.srcFile.name : null,
        size: state.srcFile ? state.srcFile.size : null,
      },
      wireframe: state.wireframe || null,
      faces: state.lastFaceDetections.map((item, index) => ({
        index,
        method: item.method || null,
        stickerCount: item.stickerCount || null,
        corners: item.corners || null,
        grid: faceGrid(item.face),
        rows: [
          faceGrid(item.face).slice(0, 3),
          faceGrid(item.face).slice(3, 6),
          faceGrid(item.face).slice(6, 9),
        ],
        cells: item.face.cells.map((cell) => ({
          code: cell.code,
          rgb: cell.rgb,
          cx: cell.cx,
          cy: cell.cy,
        })),
      })),
    };
  }

  function copyAnnotation() {
    const annotation = annotationForCurrentImage();
    if (!annotation || !exportAnnoBtn) return;
    const text = JSON.stringify(annotation, null, 2);
    const done = () => {
      exportAnnoBtn.textContent = "Copied ✓";
      setTimeout(() => (exportAnnoBtn.textContent = "Export annotation"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  // Decide whether a cell's text label should be light or dark for contrast.
  function labelClass(c) {
    const css = (COLORS[c.code] && COLORS[c.code].css) || "#999";
    // crude luminance
    const m = css.match(/^#?([0-9a-f]{6})$/i);
    if (!m) return "";
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.6 ? "light" : "dark";
  }

  // Build one face card (grid + per-face copy button).
  // accent tints the swatch + title to match the overlay color for that face.
  function buildFaceCard(face, title, accent, stickerCount) {
    const card = document.createElement("div");
    card.className = "face-card";

    const head = document.createElement("div");
    head.className = "face-head";
    if (accent) {
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = accent;
      head.appendChild(sw);
    }
    const h = document.createElement("h3");
    h.textContent = title;
    head.appendChild(h);
    if (typeof stickerCount === "number") {
      const stats = document.createElement("div");
      stats.className = "stats";
      stats.innerHTML = `<span class="num">${stickerCount}</span> stickers`;
      head.appendChild(stats);
    }
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn secondary copy-btn";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => copyFace(face, copyBtn));
    head.appendChild(copyBtn);

    const grid = document.createElement("div");
    grid.className = "grid3";
    face.cells.forEach((c) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.style.background = COLORS[c.code].css;
      cell.title = `${COLORS[c.code].name} · rgb(${c.rgb.join(",")})`;
      const lbl = document.createElement("span");
      const cls = labelClass(c);
      lbl.className = "lbl" + (cls ? " " + cls : "");
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
      ? `Detected face — ${face.stickerCount ?? 0} sticker(s)`
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

  // Render the top-of-panel summary card (X faces via <method>).
  function renderSummary(faces, method) {
    if (!summaryEl) return;
    if (!faces || faces.length === 0) {
      summaryEl.hidden = true;
      summaryEl.innerHTML = "";
      resultsMetaEl.textContent = "No faces detected";
      return;
    }
    summaryEl.hidden = false;
    const n = faces.length;
    const label = `${n} face${n === 1 ? "" : "s"} detected`;
    summaryEl.innerHTML = `
      <svg class="ico" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6 9 17l-5-5"/>
      </svg>
      <div class="body">
        <b>${label}</b>
        <p>via <code>${method}</code>${wfHandles().length ? " · drag the dots to refine" : ""}</p>
      </div>`;
    resultsMetaEl.textContent = label;
  }

  // Render intermediate detection steps into the collapsed debug section.
  function renderDebug(items) {
    const box = $("debugSteps"), details = $("debugDetails");
    if (!box || !details) return;
    box.innerHTML = "";
    if (!items || !items.length) { details.setAttribute("hidden", ""); return; }
    details.removeAttribute("hidden");
    for (const item of items) {
      if (item.type === "step") {
        const div = document.createElement("div");
        div.className = `dbg-step ${item.status}`;
        const title = document.createElement("b");
        title.textContent = item.name;
        const meta = document.createElement("span");
        meta.textContent = item.status;
        const summary = document.createTextNode(item.summary || "");
        div.appendChild(title);
        div.appendChild(meta);
        div.appendChild(summary);
        box.appendChild(div);
        continue;
      }
      const im = item;
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
