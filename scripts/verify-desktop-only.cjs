const { app } = require("electron");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const flag = "--hezuo-desktop-only-fixture";
const index = process.argv.indexOf(flag);
const report = (stage) => console.log(`[desktop-only] ${stage}`);
const fail = (error) => {
  console.error("[desktop-only] bootstrap failed", error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
try {
  if (index < 0) throw new Error("Missing desktop-only fixture arguments");
  const home = process.argv[index + 2];
  app.setPath("home", home);
  app.setPath("userData", join(home, "profile"));
  app.setPath("sessionData", join(home, "profile"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.on("window-all-closed", () => {});
  process.once("SIGTERM", () => app.exit(1));
  process.once("SIGINT", () => app.exit(1));
  app.once("ready", () => report("Electron ready event"));
  report("CommonJS bootstrap entered; importing fixture");
  import(pathToFileURL(join(__dirname, "verify-desktop-only.mjs")).href)
    .then(() => report("Fixture module completed"), fail);
} catch (error) {
  fail(error);
}
