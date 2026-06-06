(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory({
      stickerFaces: require("./steps/stickerFaces.js"),
      singleFaceFallback: require("./steps/singleFaceFallback.js"),
      learnedFaceLocalization: require("./steps/learnedFaceLocalization.js"),
      geometricSilhouette: require("./steps/geometricSilhouette.js"),
      lowConfidenceSingleFace: require("./steps/lowConfidenceSingleFace.js"),
    });
  } else {
    root.RubikPipeline = factory(root.RubikPipelineSteps);
  }
})(typeof self !== "undefined" ? self : globalThis, function (steps) {
  const PIPELINE_STEPS = [
    steps.stickerFaces,
    steps.geometricSilhouette,
    steps.singleFaceFallback,
    steps.learnedFaceLocalization,
    steps.lowConfidenceSingleFace,
  ];

  async function runPipeline(cv, src, opts) {
    opts = opts || {};
    const artifacts = [];
    const debug = [];
    const ctx = {
      cv,
      src,
      detector: opts.detector,
      segmentCube: opts.segmentCube,
      singleResult: null,
      artifacts,
      debug,
      record(step, status, summary) {
        artifacts.push({
          type: "step",
          id: step.id,
          name: step.label,
          status,
          summary,
        });
      },
      addDebug(items) {
        if (items && items.length) debug.push(...items);
      },
    };

    for (const step of PIPELINE_STEPS) {
      const result = await step.run(ctx);
      if (result) {
        result.pipeline = artifacts;
        result.debug = debug;
        return result;
      }
    }

    return {
      kind: "none",
      source: "none",
      method: "none",
      faces: [],
      pipeline: artifacts,
      debug,
    };
  }

  return { PIPELINE_STEPS, runPipeline };
});
