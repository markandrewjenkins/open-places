import { defineConfig } from "vite";
import { resolve } from "node:path";

// Multi-page static site: one HTML entry per project, shared design system in src/shared.
const pages = ["index", "places/index", "projects/index", "blossom/index", "darksky/index", "hazards/index", "water/index", "salish/index", "toronto/index", "grid/index", "foliage/index", "sunday/index", "langford/index", "blink/index", "golf/index", "air/index", "ships/index",
  // earlier console-layout mockups, for review only (not exported to the project repos)
  "mockups/index", "mockups/blossom", "mockups/salish", "mockups/grid"];

export default defineConfig({
  base: "./",
  // ES2022 for top-level await (satellite.js); every current browser supports it
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  esbuild: { target: "es2022" },
  build: {
    target: "es2022",
    outDir: "dist",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: Object.fromEntries(pages.map((p) => [p.replace("/index", ""), resolve(__dirname, `${p}.html`)])),
      // shared vendor chunks so every project page reuses the cached map and chart libraries
      output: { manualChunks: { maplibre: ["maplibre-gl"], d3: ["d3"] } },
    },
  },
  server: { port: 5173 },
});
