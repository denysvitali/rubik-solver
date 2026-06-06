(function (root, factory) {
  const step = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = step;
  root.RubikPipelineSteps = root.RubikPipelineSteps || {};
  root.RubikPipelineSteps.geometricSilhouette = step;
})(typeof self !== "undefined" ? self : globalThis, function () {
  return {
    id: "geometric-silhouette",
    label: "Geometric silhouette",
    async run(ctx) {
      const debug = [];
      const faces = ctx.detector.detectFacesGeometric(ctx.cv, ctx.src, { debug });
      ctx.addDebug(debug);
      ctx.record(this, faces.length ? "accepted" : "skipped", `${faces.length} face(s)`);
      if (!faces.length) return null;
      return {
        kind: "multi",
        source: "geometric silhouette",
        method: "geometric silhouette",
        faces,
        geometric: true,
      };
    },
  };
});
