import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/events": { target: "http://127.0.0.1:7878", changeOrigin: true, ws: false },
      "/actions": { target: "http://127.0.0.1:7878", changeOrigin: true },
      "/sessions": { target: "http://127.0.0.1:7878", changeOrigin: true },
      "/snapshot": { target: "http://127.0.0.1:7878", changeOrigin: true },
      "/export": { target: "http://127.0.0.1:7878", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
