// Bundle ws into one self-contained file the packaged app can require: it
// ships no node_modules. bufferutil and utf-8-validate are optional native
// accelerators ws loads inside try/catch, so they stay external.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "desktop/electron/vendor/ws.cjs");
const entryPoint = require.resolve("ws");

await build({
  entryPoints: [entryPoint],
  absWorkingDir: entryPoint.split(`${sep}node_modules${sep}`)[0],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["bufferutil", "utf-8-validate"],
  outfile,
  logLevel: "info",
});
