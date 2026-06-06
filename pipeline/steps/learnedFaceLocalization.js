(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.learnedFaceLocalization = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  return {
    id: "learned-face-localization",
    label: "Learned face localization",
    async run(ctx) {
      if (!ctx.segmentCube) {
        ctx.record(this, "skipped", "model unavailable");
        return null;
      }

      let cubeMask = null;
      try {
        cubeMask = await ctx.segmentCube(ctx.src);
      } catch (err) {
        ctx.record(this, "skipped", `model error: ${err && err.message || err}`);
        return null;
      }

      const debug = [];
      let faces = [];
      try {
        faces = ctx.detector.detectFacesGeometric(ctx.cv, ctx.src, { debug, cubeMask });
      } finally {
        if (cubeMask) cubeMask.delete();
      }
      ctx.addDebug(debug);
      ctx.record(this, faces.length ? "accepted" : "skipped", `${faces.length} face(s)`);
      if (!faces.length) return null;
      return {
        kind: "multi",
        source: "learned face localization",
        method: "learned face localization",
        faces,
        geometric: true,
      };
    },
  };
});
