(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.lowConfidenceSingleFace = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  return {
    id: "low-confidence-single-face",
    label: "Low-confidence single face",
    async run(ctx) {
      const result = ctx.singleResult || ctx.detector.detectCube(ctx.cv, ctx.src);
      ctx.singleResult = result;
      ctx.record(this, "accepted", `${result.method}, ${result.stickerCount || 0} sticker(s)`);
      return {
        kind: "single",
        source: result.method,
        method: result.method,
        result,
        geometric: false,
      };
    },
  };
});
