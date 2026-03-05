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
    port: 5199,
    proxy: {
      "/api": "http://localhost:5198",
    },
  },
  build: {
    outDir: "../dist/web",
  },
});
