import { defineConfig } from "vite";
import { ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [],
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
    // In dev mode, forward API and asset requests to the Python backend on
    // :8000. If the backend is not running, return the same 501 the TS-only
    // stub used to produce so the page still loads and the failure is obvious.
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.error("[vite:proxy] /api proxy error:", err.message);
            if (res instanceof ServerResponse && !res.headersSent) {
              res.statusCode = 501;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "not implemented" }));
            }
          });
        },
      },
      "/assets": {
        target: "http://localhost:8000",
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            console.error("[vite:proxy] /assets proxy error:", err.message);
            if (res instanceof ServerResponse && !res.headersSent) {
              res.statusCode = 501;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "not implemented" }));
            }
          });
        },
      },
    },
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
