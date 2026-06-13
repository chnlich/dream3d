import type { AssetProvider } from "./types";
import type { PlannedObject } from "../scene/schema";

// Offline, deterministic stand-in for the Meshy-backed asset provider. Returns a
// placeholder GLB URL per object — served (when a file is present) by the dev
// server's /assets route under dataDir/assets. No network, resolves instantly.
export const mockAssetProvider: AssetProvider = {
  async generate(obj: PlannedObject): Promise<{ glbUrl: string }> {
    return { glbUrl: `/assets/${obj.id}.glb` };
  },
};
