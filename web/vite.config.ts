import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// The build is one self-contained HTML file that the Rust binary embeds and
// serves with the review's state inlined, so pages work offline.
export default defineConfig({
  plugins: [solid(), tailwindcss(), viteSingleFile()],
  build: { target: "es2022", assetsInlineLimit: Number.POSITIVE_INFINITY },
  server: {
    // `npm run dev` talks to a running `diffd` for data.
    proxy: {
      "/api": { target: "http://localhost:3433", ws: true },
    },
  },
  test: { environment: "jsdom" },
});
