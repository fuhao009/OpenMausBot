import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DurationSequencer } from "../scripts/testing/duration-sequencer.ts";
import { hostE2eOnly, portableE2eFiles } from "../scripts/testing/host-e2e.ts";
import { hostTimeout } from "./server/testing/host-timeout.ts";

// The About dialog's version, inlined at build time: the preload bridge is
// absent in dev.
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

const root = fileURLToPath(new URL("..", import.meta.url));
const page = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** The window's rail of places loads /rail: rail.html, its own small page, in development as from the server. */
function railPage(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url === "/rail" || req.url?.startsWith("/rail?")) req.url = `/rail.html${req.url.slice("/rail".length)}`;
    next();
  };
  return {
    name: "rail-page",
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

const include = [
  "evals/**/*.test.ts",
  "desktop/server/**/*.test.ts",
  "desktop/electron/**/*.test.mjs",
  "desktop/src/**/*.test.ts",
  "packages/shared/**/*.test.ts",
  "desktop/companion/**/*.test.ts",
  "enterprise/**/*.test.ts",
  "connector/**/*.test.ts",
  "scripts/**/*.test.mjs",
  "scripts/**/*.test.ts",
  "gateway/local/**/*.test.mjs",
  "gateway/scripts/**/*.test.mjs",
];

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), railPage()],
  build: {
    outDir: fileURLToPath(new URL("../dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: { input: { index: page("./index.html"), rail: page("./rail.html"), productAccount: page("./product-account.html") } },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  test: {
    environment: "node",
    include,
    // OMB_VITEST_E2E=host (CI's Windows and macOS shards) leaves the e2e files that run on Linux only.
    exclude: [...configDefaults.exclude, "gateway/local/local-gateway/companion-relay.test.mjs", ...(hostE2eOnly() ? portableE2eFiles(root, include) : [])],
    setupFiles: ["desktop/server/testing/setup.ts", "desktop/src/testing/all-locales.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    // --shard splits the files by recorded CI seconds, not count
    sequence: { sequencer: DurationSequencer },
    // Known flakes in scripts/testing/ci-retry-list.json get two retries in
    // CI only, each reported.
    runner: "./scripts/testing/ci-retry-runner.ts",
    // Doubled on Windows, whose runners are about 1.45x slower.
    testTimeout: hostTimeout(20_000),
    hookTimeout: hostTimeout(30_000),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(process.env.OMB_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      "/api": {
        ws: true,
        target: `http://127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}`,
      },
      "/.well-known/hezuo/environment": {
        target: `http://127.0.0.1:${process.env.OMB_PORT || process.env.OGB_PORT || 8799}`,
      },
    },
  },
});
