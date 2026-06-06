(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.learnedFaceQuads = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  function normalizeFaces(raw) {
    const items = raw && raw.faces ? raw.faces : raw;
    if (!Array.isArray(items)) return [];
    return items
      .map((item) => {
        if (Array.isArray(item)) return { corners: item };
        if (item && Array.isArray(item.corners)) return item;
        if (item && Array.isArray(item.quad)) return { ...item, corners: item.quad };
        return null;
      })
      .filter((item) => item && item.corners.length === 4);
  }

  return {
    id: "learned-face-quads",
    label: "Learned face quads",
    async run(ctx) {
      if (!ctx.locateFaces) {
        ctx.record(this, "skipped", "model unavailable");
        return null;
      }

      let located = [];
      try {
        located = normalizeFaces(await ctx.locateFaces(ctx.src));
      } catch (err) {
        ctx.record(this, "skipped", `model error: ${err && err.message || err}`);
        return null;
      }

      if (!located.length) {
        ctx.record(this, "skipped", "0 face(s)");
        return null;
      }

      const faces = located.map((item) => {
        const face = item.face || ctx.detector.readFaceQuad(ctx.cv, ctx.src, item.corners);
        return {
          face,
          corners: item.corners,
          stickerCount: 9,
          method: item.method || "learned-face-quad",
          confidence: item.confidence,
          label: item.label,
        };
      });
      ctx.record(this, "accepted", `${faces.length} face(s)`);
      return {
        kind: "multi",
        source: "learned face quads",
        method: "learned face quads",
        faces,
        geometric: true,
      };
    },
  };
});
