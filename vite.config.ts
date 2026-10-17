import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // pdf.js starts its worker as a module worker.
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Lower modern CSS (nesting) for older system webviews.
    cssTarget: ["chrome105", "safari15", "edge105"],
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
});
