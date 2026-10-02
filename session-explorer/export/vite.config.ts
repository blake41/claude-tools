import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  root: __dirname,
  resolve: { alias: { "@": path.resolve(__dirname, "../web") } },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    outDir: path.resolve(__dirname, "viewer"),
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: { output: { assetFileNames: "viewer.css" } },
    lib: { entry: path.resolve(__dirname, "viewer.tsx"), formats: ["iife"], name: "Viewer", fileName: () => "viewer.js" },
  },
});
