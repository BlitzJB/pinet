import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by the coordinator under /app, so assets are rooted there.
export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // The shared client lazily falls back to the Node crypto provider; the
      // browser always injects webCryptoProvider, so swap the Node module out.
      {
        find: "../crypto/provider.mjs",
        replacement: fileURLToPath(new URL("./src/lib/node-provider-stub.ts", import.meta.url)),
      },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:8787",
      "/me": "http://127.0.0.1:8787",
      "/devices": "http://127.0.0.1:8787",
      "/hosts": "http://127.0.0.1:8787",
      "/ws": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
});
