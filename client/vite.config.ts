import path from "path";
import fs from "fs";
import { createRequire } from "module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type PluginOption } from "vite";

const _require = createRequire(import.meta.url);
const { load: loadYaml } = _require("js-yaml") as {
  load: (str: string) => unknown;
};

function yamlPlugin(): Plugin {
  return {
    name: "yaml",
    transform(_, id) {
      if (!id.endsWith(".yaml") && !id.endsWith(".yml")) return null;
      const data = loadYaml(fs.readFileSync(id, "utf-8"));
      return { code: `export default ${JSON.stringify(data)}`, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), yamlPlugin()] as PluginOption[],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@mini-infra/types": path.resolve(__dirname, "../lib/types"),
    },
  },
  optimizeDeps: {
    exclude: ["@mini-infra/types"],
  },
  server: {
    port: 3005,
    allowedHosts: ["localhost", "mini.dev.blinglabs.tech"],
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: "http://localhost:5005",
        changeOrigin: true,
        ws: true, // Enable WebSocket proxying (also helps with SSE)
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            // For SSE endpoints, ensure proper headers
            if (req.url?.includes("/logs/stream")) {
              proxyReq.setHeader("Connection", "keep-alive");
              proxyReq.setHeader("Cache-Control", "no-cache");
            }
          });
        },
      },
      "/auth": {
        target: "http://localhost:5005",
        changeOrigin: true,
      },
      "/socket.io": {
        target: "http://localhost:5005",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "../server/public", // Build directly to server's static folder
    emptyOutDir: true, // Clean stale assets from previous builds
    chunkSizeWarningLimit: 1500, // Suppress warning for chunks up to 1.5 MB
  },
});
