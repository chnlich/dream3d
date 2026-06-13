// Hand-written type declarations for genParams.mjs (the runtime is plain ESM so
// the CLI needs no build step; these types let the TypeScript pipeline consume
// it). Single source of truth for the types; genParams.d.mts just re-exports them.

/** Preview-pass submit params: tune the base mesh. */
export interface PreviewParams {
  should_remesh: boolean;
  target_polycount: number;
  topology: string;
  ai_model: string;
}

/** Refine-pass submit params: bake PBR texture onto the preview mesh. */
export interface RefineParams {
  enable_pbr: boolean;
  remove_lighting: boolean;
  hd_texture: boolean;
  ai_model: string;
}

export const PREVIEW_PARAMS: PreviewParams;
export const REFINE_PARAMS: RefineParams;

export function canonicalJson(value: unknown): string;
export function paramSignature(mode: "preview" | "refine"): string;
