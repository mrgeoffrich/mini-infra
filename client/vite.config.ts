import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import yaml from "@modyfi/vite-plugin-yaml";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), yaml()],
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
        configure: (proxy, _options) => {
          proxy.on("proxyReq", (proxyReq, req, _res) => {
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
