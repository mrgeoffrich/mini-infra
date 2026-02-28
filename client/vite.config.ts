import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@mini-infra/types": path.resolve(__dirname, "../lib/dist"),
    },
  },
  optimizeDeps: {
    include: ["@mini-infra/types"],
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
    },
  },
  build: {
    outDir: "../server/public", // Build directly to server's static folder
    chunkSizeWarningLimit: 1500, // Suppress warning for chunks up to 1.5 MB
  },
});
