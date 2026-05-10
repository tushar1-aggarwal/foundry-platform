import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("../../package.json", "utf-8"));

export default defineConfig({
  root: "src",
  plugins: [react(), tailwindcss()],
  define: {
    __ARK_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api/terminal": {
        target: "ws://localhost:8420",
        ws: true,
      },
      "/api": "http://localhost:8420",
      // Phase 1 Google OIDC routes live on the conductor (:19400),
      // not on the dev API gateway (:8420). The dev API gateway does
      // NOT forward /auth/* today, so we proxy directly. In production
      // the conductor serves both /api and /auth, so this dev-only
      // split is invisible to the deployed bundle.
      //
      // Match the EXACT route paths -- not the `/auth` prefix -- so we
      // don't accidentally intercept Vite's own dev requests for
      // source files under `src/auth/` (e.g. `/auth/AuthContext.tsx`).
      "/auth/google": {
        target: "http://localhost:19400",
        changeOrigin: false,
      },
      "/auth/logout": {
        target: "http://localhost:19400",
        changeOrigin: false,
      },
    },
  },
});
