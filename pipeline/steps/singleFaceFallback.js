(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.singleFaceFallback = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const MIN_GREEN_BLUE_SUPPORTING_SQUARES = 9;

  function isStrong(result) {
    if (
      !result ||
      !result.confident ||
      result.method === "center-crop" ||
      result.stickerCount < 2
    ) {
      return false;
    }
    if (result.method === "green/blue") {
      return (result.squareCount || 0) >= MIN_GREEN_BLUE_SUPPORTING_SQUARES;
    }
    return true;
  }

  return {
    id: "single-face-fallback",
    label: "Single-face sticker fallback",
    async run(ctx) {
      const result = ctx.singleResult || ctx.detector.detectCube(ctx.cv, ctx.src);
      ctx.singleResult = result;
      const strong = isStrong(result);
      ctx.record(
        this,
        strong ? "accepted" : "skipped",
        `${result.method}, ${result.stickerCount || 0} sticker(s), ${result.squareCount || 0} square(s)`,
      );
      if (!strong) return null;
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
