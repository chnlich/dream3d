// genParams.mjs — central, single-source generation parameters for the Meshy
// text-to-3D pipeline.
//
// These literals are the ONLY place the preview/refine submit-body params live.
// Both the best-of-N CLI (scripts/meshy-generate.mjs) and the pipeline asset
// provider (src/pipeline/meshyAssetProvider.ts) import them, so the two paths
// submit byte-identical jobs and derive identical cache keys for the same prompt.
//
// Plain ESM (NO TypeScript syntax) so the CLI keeps running with no build step;
// the matching hand-written type declarations live alongside in genParams.d.ts.
//
// The disk cache key folds in paramSignature(mode) (see src/meshy/cache.mjs
// deriveKey), so changing ANY param below yields a NEW key and never silently
// serves stale bytes that were generated under different params.

// Preview submit params — tune the base mesh: remesh to a poly-bounded triangle
// mesh of at most target_polycount polygons.
export const PREVIEW_PARAMS = {
  should_remesh: true,
  target_polycount: 300000,
  topology: "triangle",
  ai_model: "meshy-6",
};

// Refine submit params — bake PBR texture onto the completed preview mesh so the
// pipeline returns a TEXTURED (not gray) GLB.
export const REFINE_PARAMS = {
  enable_pbr: true,
  remove_lighting: true,
  hd_texture: false,
  ai_model: "meshy-6",
};

// Canonical, key-sorted JSON of a value: recursively sorts object keys so the
// output is stable regardless of declaration order. This is what makes a param
// signature reproducible across processes and across the CLI / provider.
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

// The output-affecting param signature for a mode, folded into the cache key by
// deriveKey. A refined asset is built ON TOP of a preview mesh, so the refine
// signature MUST include the preview params it was built on — otherwise changing
// a preview param (e.g. target_polycount) would not invalidate cached refined
// bytes that depend on it.
export function paramSignature(mode) {
  if (mode === "preview") {
    return canonicalJson(PREVIEW_PARAMS);
  }
  if (mode === "refine") {
    return canonicalJson({ preview: PREVIEW_PARAMS, refine: REFINE_PARAMS });
  }
  throw new Error(`paramSignature: unknown mode "${mode}" (expected "preview" or "refine")`);
}
