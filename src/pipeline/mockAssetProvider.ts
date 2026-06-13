import type { AssetProvider } from "./types";
import type { PlannedObject } from "../scene/schema";

// Deterministic stand-in for the Meshy-backed asset provider. Filled by a later chunk.
export const mockAssetProvider: AssetProvider = {
  async generate(_obj: PlannedObject): Promise<{ glbUrl: string }> {
    throw new Error("not implemented — filled by a later chunk");
  },
};
