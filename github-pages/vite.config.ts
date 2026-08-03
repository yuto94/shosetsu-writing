import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/shosetsu-writing/",
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../github-dist",
    emptyOutDir: true,
  },
});
