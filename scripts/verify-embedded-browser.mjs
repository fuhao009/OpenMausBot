import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const dir = await mkdtemp(join(tmpdir(), "embedded-browser-check-"));
try {
  const entry = join(dir, "fixture.mjs");
  const bootstrap = join(dir, "bootstrap.cjs");
  await build({ entryPoints: [new URL("./verify-embedded-browser.cjs", import.meta.url).pathname], outfile: entry,
    bundle: true, platform: "node", format: "esm", external: ["electron"], logLevel: "warning",
    banner: { js: 'import { createRequire as __fixtureRequire } from "node:module"; const require = __fixtureRequire(import.meta.url);' },
    plugins: [{ name: "source-proxy-resource-root", setup(builder) {
      builder.onLoad({ filter: /[/\\]proxy-paths\.ts$/ }, async ({ path }) => ({
        contents: (await readFile(path, "utf8")).replace("import.meta.url", JSON.stringify(pathToFileURL(path).href)), loader: "ts",
      }));
    } }],
  });
  await writeFile(bootstrap, `const {app}=require('electron');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'embedded-bootstrap-'));app.setPath('userData',isolated);app.setPath('home',isolated);
const fail=e=>{console.error(e);app.exit(1)};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
setTimeout(()=>fail(new Error('Embedded fixture bootstrap timed out')),110000).unref();
import(${JSON.stringify(pathToFileURL(entry).href)}).catch(fail);`);
  const executable = require("electron");
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(executable, [bootstrap, process.argv[2] ?? join(process.cwd(), ".omb-scratch", "embedded-browser-evidence")], { env, stdio: "inherit" });
    child.once("error", reject); child.once("exit", resolve);
  });
  if (code !== 0) process.exitCode = 1;
} finally { await rm(dir, { recursive: true, force: true }); }
