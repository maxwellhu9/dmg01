import { defineConfig } from "vite";

// Relative base so the built site works when hosted under a subpath
// (e.g. GitHub Pages at /dmg01/).
export default defineConfig({
  base: "./",
});
