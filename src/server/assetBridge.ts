import { existsSync, mkdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GenerateResponse } from "../api/contract";

// Bridge ready GLBs into the browser-fetchable /assets directory.
//
// In real mode each generated object's `glbUrl` is a local filesystem path
// (~/.cache/dream3d/meshy/<key>.glb) that the browser cannot fetch, so the
// SceneViewer 404s. For every READY object we materialize its GLB as a symlink
// under the directory the /assets route already serves and rewrite `glbUrl` to
// the matching root-relative /assets/<id>.glb URL the browser can load.
//
// assetsDir MUST equal the directory apiPlugin's /assets route serves
// (join(homedir(), ".cache", "dream3d", "assets")); keep these identical.
const assetsDir = join(homedir(), ".cache", "dream3d", "assets");

export function publishSceneAssets(response: GenerateResponse): GenerateResponse {
  for (const pass of response.passes) {
    for (const obj of pass.sceneState.objects) {
      const glbUrl = obj.glbUrl;
      // Only rewrite ready objects that point at a real local file. Mock
      // placeholders, missing files, and already-served URLs are left as-is.
      if (obj.status !== "ready" || typeof glbUrl !== "string" || glbUrl.length === 0) continue;
      if (glbUrl.startsWith("http://") || glbUrl.startsWith("https://") || glbUrl.startsWith("/assets/")) continue;
      if (!existsSync(glbUrl) || !statSync(glbUrl).isFile()) continue;

      let safeName = obj.id.replace(/[^A-Za-z0-9._-]/g, "-");
      if (!safeName.endsWith(".glb")) safeName += ".glb";

      // Symlink (never copy) — GLBs are 16-20 MB. Filesystem errors propagate so
      // handleGenerate turns them into a 500; we never swallow them.
      mkdirSync(assetsDir, { recursive: true });
      const target = realpathSync(glbUrl);
      const linkPath = join(assetsDir, safeName);
      rmSync(linkPath, { force: true });
      symlinkSync(target, linkPath);
      obj.glbUrl = "/assets/" + safeName;
    }
  }
  return response;
}
