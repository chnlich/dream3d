// Dev/test-only ESM resolve hook: let plain `node` run the project's TypeScript
// modules unbundled.
//
// Several source modules (e.g. src/pipeline/*) use EXTENSIONLESS relative imports
// (`import { layout } from "./layout"`). Vite resolves those at runtime, and tsc
// resolves them under "moduleResolution: bundler", but Node's ESM resolver requires
// an explicit extension. This hook appends the missing `.ts` / `.js` (and `/index.*`)
// so the same sources run under `node --import ./scripts/<register>.mjs ...`. Node
// strips the TypeScript types itself on load — this hook only fixes resolution.
//
// Register it from a smoke script:
//   import { register } from "node:module";
//   register("./ts-resolve-hook.mjs", import.meta.url);

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const CANDIDATE_SUFFIXES = [".ts", ".js", ".mjs", "/index.ts", "/index.js"];

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const hasExtension = /\.[mc]?[jt]s$/.test(specifier);
  if (isRelative && !hasExtension && context.parentURL) {
    const base = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = base + suffix;
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
