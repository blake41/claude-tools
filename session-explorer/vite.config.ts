import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: "web",
  resolve: {
    alias: { "@": path.resolve(__dirname, "web") },
  },
  server: {
    // Override via `VITE_PORT`/`API_PORT` so a worktree's dev server can run
    // alongside the main checkout's without a port clash (U7 browser QA).
    port: Number(process.env.VITE_PORT) || 5199,
    proxy: {
      "/api": `http://localhost:${Number(process.env.API_PORT) || 5198}`,
    },
  },
  build: {
    outDir: "../dist/web",
  },
});
