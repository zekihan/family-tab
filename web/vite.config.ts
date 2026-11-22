import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function stampServiceWorker(): Plugin {
  return {
    name: "family-tab-service-worker",
    apply: "build",
    async writeBundle(output, bundle) {
      const dir = output.dir ?? "dist";
      const path = resolve(dir, "sw.js");
      const index = resolve(dir, "index.html");
      const buildId = randomUUID();
      const assets = Object.keys(bundle).filter(file => file.startsWith("assets/")).sort();
      const template = await readFile(path, "utf8");
      const html = await readFile(index, "utf8");
      await Promise.all([
        writeFile(path, template
          .replace("__FAMILY_TAB_BUILD_ID__", buildId)
          .replace("/* __FAMILY_TAB_ASSETS__ */ []", JSON.stringify(assets.map(file => "/" + file)))),
        writeFile(index, html.replace("</head>", `  <meta name="family-tab-build" content="${buildId}">\n  </head>`)),
      ]);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/auth": "http://localhost:8080",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
