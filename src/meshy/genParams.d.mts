// Module-resolution shim. TypeScript resolves the types for an
// `import ... from "./genParams.mjs"` from a sibling `.d.mts` (the `.mjs`
// extension maps to `.d.mts`, never `.d.ts`), while the CLI must keep importing
// the explicit `.mjs` so it runs with no build step. The hand-written
// declarations live in genParams.d.ts (the single source of truth); this file
// just re-exports them so both importers share one set of types.
export * from "./genParams.js";
