import type { AssetProvider } from "./types";
import type { PlannedObject } from "../scene/schema";

// Real asset provider backed by the Meshy text-to-3D API (see src/meshy/client.ts).
// Implemented by a later chunk.
export const meshyAssetProvider: AssetProvider = {
  async generate(_obj: PlannedObject): Promise<{ glbUrl: string }> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
