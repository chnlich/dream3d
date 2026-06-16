import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiPlugin } from "./src/server/apiPlugin";

const rootDir = dirname(fileURLToPath(import.meta.url));

// Placeholder /api middleware. Real request handlers are added by a later chunk;
// for now every /api request returns 501 Not Implemented so the dev server boots
// and the contract surface is observable without any business logic.
function apiStubPlugin(): Plugin {
  return {
    name: "dream3d-api-stub",
    configureServer(server) {
      server.middlewares.use("/api", (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 501;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "not implemented" }));
      });
    },
  };
}

export default defineConfig({
  plugins: [apiPlugin(), apiStubPlugin()],
  // The dev server is exposed publicly via Tailscale (Funnel on the original
  // dev box, direct Tailscale on the headless SLURM login host). Vite 5 rejects
  // unknown Host headers, so each hostname must be allow-listed; strictPort
  // keeps Vite pinned to 5173 instead of drifting to 5174 if 5173 is busy.
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: [
      "chaoasus-1.tailb4091b.ts.net",
      "aws-ohio-slurm-login.onca-snapper.ts.net",
    ],
  },
  build: {
    // Match tsconfig target (ES2022) so viewerMain.ts's top-level await transpiles cleanly.
    target: "es2022",
    rollupOptions: {
      input: {
        main: resolve(rootDir, "index.html"),
        viewer: resolve(rootDir, "viewer.html"),
        studio: resolve(rootDir, "studio.html"),
      },
    },
  },
});
