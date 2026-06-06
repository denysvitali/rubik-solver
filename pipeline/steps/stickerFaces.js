(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.stickerFaces = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  return {
    id: "sticker-faces",
    label: "Sticker face grid",
    async run(ctx) {
      const debug = [];
      const faces = ctx.detector.detectFaces(ctx.cv, ctx.src, { debug });
      ctx.addDebug(debug);
      ctx.record(this, faces.length ? "accepted" : "skipped", `${faces.length} face(s)`);
      if (!faces.length) return null;
      return {
        kind: "multi",
        source: "sticker grid",
        method: "sticker grid",
        faces,
        geometric: false,
      };
    },
  };
});
