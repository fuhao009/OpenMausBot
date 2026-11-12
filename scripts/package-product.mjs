#!/usr/bin/env node
// The only packaging entry point for the managed product build.
//
//   OMB_PRODUCT_SERVICE_URL=https://ai.<your-domain> \
//     node scripts/package-product.mjs --platform mac --arch arm64 --dir
//   OMB_PRODUCT_SERVICE_URL=https://ai.<your-domain> \
//     node scripts/package-product.mjs --platform mac --arch arm64
//   OMB_PRODUCT_SERVICE_URL=https://127.0.0.1:18487 \
//     node scripts/package-product.mjs --local-origin --gateway-ca gateway-cert.pem
//
// The wrapper reads the checked-in electron-builder.yml as the base — server,
// UI, browser, CUA, DuckDB and license resources stay exactly as verified —
// then replaces the release identity as whole values instead of extending it.
// electron-builder's `extends` concatenates arrays, which would keep the
// upstream GitHub publisher, protocol, and artifact names. The generated
// config and the bundled product-service.json land in
// `.omb-scratch/product-release/`; nothing from OMB_PRODUCT_SERVICE_URL is
// committed and no upstream-owned domain is ever a default.
//
// Exit codes: 0 success, 1 invalid usage/configuration or a failed build.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  PRODUCT_ARTIFACT_PREFIX,
  PRODUCT_APP_ID,
  PRODUCT_NAME,
  PRODUCT_PROTOCOL,
  operatorOrigin,
  productServiceDocument,
  verifyProductApp,
} from "./product-release.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_CONFIG = path.join(root, "electron-builder.yml");
const SCRATCH = path.join(root, ".omb-scratch", "product-release");
const RELEASE_DIR = path.join(root, "release", "product");
const PLATFORM_NAMES = { mac: "mac", win: "win", linux: "linux" };
const PRODUCT_DESKTOP_NAME = "com.hezuo.product.desktop";
const PRODUCT_INSTALL_ROOT = "/opt/Hezuo Product";

const USAGE = `usage: OMB_PRODUCT_SERVICE_URL=https://… node scripts/package-product.mjs [options]

options:
  --platform mac|win|linux   target platform (default: this host)
  --arch arm64|x64           target CPU (default: the platform's configured targets)
  --dir                      build an unpacked app directory for an isolated smoke test
  --unsigned                 skip macOS signing when no certificate is available
  --dry-run                  validate the origin and write the generated config, build nothing
  --local-origin             allow a loopback origin (the local gateway deployment)
  --gateway-ca <pem-file>    bundle the deployment's public certificate; required with --local-origin
  --help                     this text

The origin must be an exact HTTPS origin owned by the operator (no path,
credentials, query, or fragment). Loopback, upstream-owned domains, and
reserved documentation/fixture names (.example, example.com, .invalid, .test,
.local) are refused: a product package never silently points at a service the
operator does not control. Reserved names are accepted only with --dry-run.

--local-origin is the one exception, for the local gateway this repository also
ships: OMB_PRODUCT_SERVICE_URL may then be https://127.0.0.1:<port>,
https://localhost:<port>, or https://[::1]:<port>. Such an origin can never
carry a publicly trusted certificate, so --local-origin also requires
--gateway-ca: the app then verifies the gateway with that one public
certificate, bundled for exactly this origin, and nobody has to import
anything into the operating system's trust store.

--gateway-ca is a PEM file holding one public certificate (never a private
key) that the origin's TLS server presents or chains to. It is written into the
bundled resource as version 2 and applies to that exact origin only: hostname
and chain checks stay on, and a certificate for another host is refused at
build time and again when the app starts.`;

class UsageError extends Error {}

function parseArgs(argv) {
  // `pnpm run <script> -- args` forwards the separator itself in pnpm 10.
  const options = { platform: null, arch: null, dir: false, unsigned: false, dryRun: false, localOrigin: false, gatewayCa: null, help: false };
  for (let index = argv[0] === "--" ? 1 : 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--dir") options.dir = true;
    else if (arg === "--unsigned") options.unsigned = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--local-origin") options.localOrigin = true;
    else if (arg === "--gateway-ca" && argv[index + 1]) options.gatewayCa = argv[++index];
    else if (arg === "--platform" && argv[index + 1]) {
      const value = argv[++index];
      if (!Object.hasOwn(PLATFORM_NAMES, value)) fail(`--platform must be mac, win, or linux; got ${JSON.stringify(value)}`);
      options.platform = value;
    } else if (arg === "--arch" && argv[index + 1]) {
      const value = argv[++index];
      if (!["arm64", "x64"].includes(value)) fail(`--arch must be arm64 or x64; got ${JSON.stringify(value)}`);
      options.arch = value;
    } else fail(`unknown argument: ${arg}`);
  }
  if (options.help) return options;
  if (!options.platform) {
    options.platform = { darwin: "mac", win32: "win", linux: "linux" }[process.platform] ?? null;
    if (!options.platform) fail(`unsupported host platform: ${process.platform}`);
  }
  if (options.platform === "win" && options.arch === "arm64") fail("the Windows target configured here is x64 only");
  // A loopback origin can never present a certificate any system trusts, so
  // the local deployment must bundle its own; any other origin may bundle one
  // too, and both paths verify exactly that origin.
  if (options.localOrigin && !options.gatewayCa) {
    fail("--local-origin needs --gateway-ca: a loopback gateway's certificate can never be publicly trusted, so the app must carry it");
  }
  return options;
}

function fail(message) {
  throw new UsageError(message);
}

/** The exact origin the desktop pins in its bundled resource. */
function productOrigin(environment = process.env, { dryRun = false, localOrigin = false } = {}) {
  const raw = environment.OMB_PRODUCT_SERVICE_URL;
  if (typeof raw !== "string" || raw.trim() === "") {
    fail("OMB_PRODUCT_SERVICE_URL is required: an exact HTTPS origin the operator owns");
  }
  try {
    // A dry run validates the whole config path before the operator's DNS
    // exists; a real build must name a routable host they own, unless the
    // operator explicitly asked for the local gateway's loopback origin.
    return operatorOrigin(raw, { allowReserved: dryRun, allowLoopback: localOrigin });
  } catch (error) {
    const reason = error?.message;
    if (reason === "product_origin_author_domain") {
      fail("OMB_PRODUCT_SERVICE_URL must be a domain the operator owns; the upstream open-source project's domains are refused");
    }
    if (reason === "product_origin_reserved_host") {
      fail("OMB_PRODUCT_SERVICE_URL must be a routable host the operator owns; documentation and fixture names (.example, example.com, .invalid, .test, .local) are only accepted with --dry-run");
    }
    if (reason === "product_origin_loopback") {
      fail("OMB_PRODUCT_SERVICE_URL is a loopback origin; pass --local-origin for the local gateway deployment, or name the public host you own");
    }
    if (reason === "product_origin_public_host") fail("OMB_PRODUCT_SERVICE_URL must name a public DNS host, not an IP address or loopback host");
    if (reason === "product_origin_port") fail("OMB_PRODUCT_SERVICE_URL must use the default HTTPS port");
    fail("OMB_PRODUCT_SERVICE_URL must be one exact HTTPS origin (no path, credentials, query, or fragment)");
  }
}

function substitute(text, pairs) {
  let result = text;
  for (const [from, to] of pairs) result = result.split(from).join(to);
  return result;
}

/**
 * The DEB hooks and AppArmor profile are generated from the verified base
 * files. Packaging under the product identity must never repair or remove the
 * original app's install root, profile, or alternatives link, so every path
 * and profile name is replaced before electron-builder embeds the scripts.
 */
async function linuxProductResources(scratch) {
  const ROOT_SENTINEL = "\u0000PRODUCT_ROOT\u0000";
  // The install root has a space, so a plain find/replace would re-substitute
  // the root inside its own replacement. Shield it first, then rename the
  // product's own executable, launcher, profile, and desktop identity.
  const pairs = [
    ["/opt/Hezuo", ROOT_SENTINEL],
    [`${ROOT_SENTINEL}/hezuo`, `${ROOT_SENTINEL}/hezuo-product`],
    ["update-alternatives --remove hezuo ", "update-alternatives --remove hezuo-product "],
    ["/usr/bin/hezuo", "/usr/bin/hezuo-product"],
    ["hezuo-browser", "hezuo-product-browser"],
    [ROOT_SENTINEL, PRODUCT_INSTALL_ROOT],
  ];
  const afterInstall = substitute(await readFile(path.join(root, "desktop", "build", "linux-after-install.sh"), "utf8"), pairs)
    // The install root contains a space, so its shell assignment must be quoted.
    .replace(`APP_ROOT=${PRODUCT_INSTALL_ROOT}\n`, `APP_ROOT="${PRODUCT_INSTALL_ROOT}"\n`);
  if (!afterInstall.includes(`APP_ROOT="${PRODUCT_INSTALL_ROOT}"`)) {
    throw new Error("desktop/build/linux-after-install.sh no longer assigns APP_ROOT in the form this wrapper must rewrite");
  }
  const afterRemove = substitute(await readFile(path.join(root, "desktop", "build", "linux-after-remove.sh"), "utf8"), pairs)
    // Both places pass the installed executable as a bare word; the product
    // install root contains a space, so each must be quoted.
    .split(`${PRODUCT_INSTALL_ROOT}/hezuo-product`).join(`"${PRODUCT_INSTALL_ROOT}/hezuo-product"`);
  if (!afterRemove.includes(`"${PRODUCT_INSTALL_ROOT}/hezuo-product"`)) {
    throw new Error("desktop/build/linux-after-remove.sh no longer names the installed executable in the form this wrapper must rewrite");
  }
  const profileSource = await readFile(path.join(root, "desktop", "build", "linux-hezuo-browser.apparmor"), "utf8");
  // The policy line must name the product's executable with the install root
  // quoted: AppArmor takes an unquoted path up to the first space.
  const profile = profileSource.replace(
    /^profile\s+hezuo-browser\s+\S+\s+flags=/m,
    `profile hezuo-product-browser "${PRODUCT_INSTALL_ROOT}/resources/browser-engine/chrome/chrome-headless-shell-linux64/chrome-headless-shell" flags=`,
  );
  if (!profile.includes(`profile hezuo-product-browser "${PRODUCT_INSTALL_ROOT}/`)) {
    throw new Error("desktop/build/linux-hezuo-browser.apparmor no longer has the browser policy line this wrapper must rewrite");
  }
  const afterInstallPath = path.join(scratch, "linux-after-install.sh");
  const afterRemovePath = path.join(scratch, "linux-after-remove.sh");
  const profilePath = path.join(scratch, "hezuo-product-browser.apparmor");
  await writeFile(afterInstallPath, afterInstall, { mode: 0o755 });
  await writeFile(afterRemovePath, afterRemove, { mode: 0o755 });
  await writeFile(profilePath, profile, { mode: 0o644 });
  await chmod(afterInstallPath, 0o755);
  await chmod(afterRemovePath, 0o755);
  return { afterInstallPath, afterRemovePath, profilePath };
}

/** Build the complete product configuration from the checked-in base. */
export async function productBuildConfig({ scratch, platform, unsigned }) {
  const base = parseYaml(await readFile(BASE_CONFIG, "utf8"));
  if (!base || typeof base !== "object" || Array.isArray(base)) throw new Error("electron-builder.yml did not parse as a mapping");
  const config = structuredClone(base);

  config.appId = PRODUCT_APP_ID;
  config.productName = PRODUCT_NAME;
  config.artifactName = `${PRODUCT_ARTIFACT_PREFIX}-\${version}-\${arch}.\${ext}`;
  config.protocols = [{ name: "Hezuo Product package install", schemes: [PRODUCT_PROTOCOL] }];
  // A product build publishes nowhere and bakes no update feed.
  // `--publish never` alone is not enough: with an empty list, or none at all,
  // electron-builder falls back to the `repository` field and writes a GitHub
  // app-update.yml. `null` at the platform and target level makes
  // getPublishConfigs return null before that fallback, so no target (dmg,
  // zip, nsis, deb, AppImage) writes a feed at all.
  config.publish = null;
  config.extraMetadata = {
    ...(typeof base.extraMetadata === "object" ? base.extraMetadata : null),
    productName: PRODUCT_NAME,
    desktopName: PRODUCT_DESKTOP_NAME,
    ombProductManaged: true,
  };
  config.directories = { ...base.directories, output: path.relative(root, RELEASE_DIR).split(path.sep).join("/") };

  const productServicePath = path.join(scratch, "product-service.json");
  const extraResources = Array.isArray(base.extraResources) ? structuredClone(base.extraResources) : [];
  extraResources.push({ from: productServicePath, to: "product-service.json" });
  config.extraResources = extraResources;

  const mac = { ...base.mac, publish: null };
  const dmg = { ...base.dmg, publish: null, artifactName: `${PRODUCT_ARTIFACT_PREFIX}-\${version}-\${arch}.dmg` };
  if (unsigned) {
    mac.identity = null;
    dmg.sign = false;
  }
  const win = { ...base.win, publish: null };
  const nsis = {
    ...base.nsis,
    publish: null,
    shortcutName: PRODUCT_NAME,
    artifactName: `${PRODUCT_ARTIFACT_PREFIX}-\${version}-\${arch}-setup.\${ext}`,
  };
  const linux = { ...base.linux, publish: null };
  linux.executableName = "hezuo-product";
  linux.desktop = {
    ...linux.desktop,
    entry: { ...linux.desktop?.entry, Name: PRODUCT_NAME },
  };
  const linuxResources = Array.isArray(linux.extraResources) ? structuredClone(linux.extraResources) : [];
  const deb = {
    ...base.deb,
    publish: null,
    packageName: "hezuo-product",
    // Fpm targets default to `${name}-${version}-${arch}.${ext}` with the
    // package name; keep the product's artifact naming there too.
    artifactName: `${PRODUCT_ARTIFACT_PREFIX}-\${version}-\${arch}.\${ext}`,
  };

  if (platform === "linux") {
    const productLinux = await linuxProductResources(scratch);
    const profileTarget = "hezuo-product-browser.apparmor";
    const profileIndex = linuxResources.findIndex((entry) => entry && typeof entry === "object" && entry.to === "hezuo-browser.apparmor");
    if (profileIndex < 0) throw new Error("electron-builder.yml no longer ships the browser AppArmor profile this wrapper must replace");
    // The generated hook installs the profile under the product's own name,
    // so the bundled resource must carry that exact filename too.
    linuxResources[profileIndex] = { from: productLinux.profilePath, to: profileTarget };
    deb.afterInstall = productLinux.afterInstallPath;
    deb.afterRemove = productLinux.afterRemovePath;
  }
  linux.extraResources = linuxResources;

  config.mac = mac;
  config.dmg = dmg;
  config.win = win;
  config.nsis = nsis;
  config.linux = linux;
  config.deb = deb;
  return { config, productServicePath };
}

function run(command, args, { env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
}

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function builderCommand() {
  return process.platform === "win32" ? "electron-builder.cmd" : "electron-builder";
}

function buildSteps(platform) {
  if (platform === "mac") return ["package:prepare", "build:speech", "build:cua"];
  if (platform === "win") return ["package:prepare", "build:cua:win"];
  return ["package:prepare", "build:cua:linux"];
}

function builderArgs(options) {
  const args = [`--${options.platform}`];
  if (options.arch) args.push(`--${options.arch}`);
  if (options.dir) args.push("--dir");
  args.push("--publish", "never");
  return args;
}

/** electron-builder's unpacked output directory for one target. */
const UNPACKED_DIRS = {
  mac: { x64: "mac", arm64: "mac-arm64", universal: "mac-universal" },
  win: { x64: "win-unpacked", arm64: "win-arm64-unpacked", ia32: "win-ia32-unpacked" },
  linux: { x64: "linux-unpacked", arm64: "linux-arm64-unpacked" },
};

/** Unpacked app directories *this* build produced. A directory left from an
 * earlier build for another architecture is not this build's output, so it is
 * never verified or reported: with an explicit --arch only that directory is
 * read, and without one every configured target is (the build made them). */
async function unpackedApps(platform, arch) {
  const names = arch
    ? [UNPACKED_DIRS[platform]?.[arch] ?? null]
    : [...new Set(Object.values(UNPACKED_DIRS[platform] ?? {}))];
  const apps = [];
  for (const name of names) {
    if (!name) continue;
    const directory = path.join(RELEASE_DIR, name);
    if (!(await stat(directory).then(() => true, () => false))) continue;
    if (platform !== "mac") {
      apps.push({ appDir: directory, resourcesDir: path.join(directory, "resources") });
      continue;
    }
    for (const entry of await readdir(directory)) {
      if (!entry.endsWith(".app")) continue;
      apps.push({ appDir: path.join(directory, entry), resourcesDir: path.join(directory, entry, "Contents", "Resources") });
    }
  }
  return apps;
}

export async function packageProduct(options, environment = process.env) {
  const origin = productOrigin(environment, { dryRun: options.dryRun, localOrigin: options.localOrigin });
  // The public certificate, read from the operator's PEM file. It never goes
  // through the environment, a command line is the only input, and only the
  // certificate block is ever written into the bundle.
  const gatewayCa = options.gatewayCa
    ? await readFile(path.resolve(options.gatewayCa), "utf8").catch(() => fail(`--gateway-ca could not read ${options.gatewayCa}`))
    : null;
  const scratch = path.join(SCRATCH, `${options.platform}-${options.arch ?? "configured"}`);
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const { config, productServicePath } = await productBuildConfig({
    scratch, platform: options.platform, unsigned: options.unsigned,
  });
  if (options.arch && Array.isArray(config[options.platform]?.target)) {
    config[options.platform].target = config[options.platform].target.map((target) => ({
      ...(typeof target === "string" ? { target } : target),
      arch: [options.arch],
    }));
  }
  // The resource file is the only thing the packaged app trusts: a format
  // version, the pinned origin and — when the deployment bundled one — that
  // origin's public certificate, so no OS trust-store import is needed.
  await writeFile(productServicePath, `${JSON.stringify(productServiceDocument(origin, gatewayCa), null, 2)}\n`, { mode: 0o644 });
  const configPath = path.join(scratch, "electron-builder.product.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const steps = buildSteps(options.platform);
  const args = builderArgs(options);
  if (options.dryRun) {
    return {
      dryRun: true,
      origin,
      configPath,
      productServicePath,
      outputDir: path.relative(root, RELEASE_DIR),
      steps: steps.map((script) => `pnpm ${script}`),
      builder: ["electron-builder", ...args, "--config", configPath],
      localOrigin: options.localOrigin,
      pinnedCertificate: gatewayCa !== null,
      identity: { appId: PRODUCT_APP_ID, productName: PRODUCT_NAME, protocol: PRODUCT_PROTOCOL, publish: null },
      notes: [
        "Dry run wrote the generated config and bundled resource only; no build, signing, or artifact was produced.",
        "A real product build must be run with an origin on a domain the operator owns, unless --local-origin names the gateway this machine runs.",
      ],
    };
  }

  const env = { ...environment };
  if (options.platform === "mac") {
    if (options.arch) {
      // package:prepare stages both CUA trees for both macOS arches unless
      // told exactly which one this build packages.
      env.HEZUO_CUA_ARCHES = options.arch;
      env.HEZUO_CUA_ARCHES_PARTIAL = "1";
    } else {
      delete env.HEZUO_CUA_ARCHES;
      delete env.HEZUO_CUA_ARCHES_PARTIAL;
    }
  }
  for (const script of steps) run(pnpmCommand(), [script], { env });
  run(builderCommand(), [...args, "--config", configPath], { env });

  const apps = await unpackedApps(options.platform, options.arch);
  if (apps.length === 0) throw new Error(`no unpacked product app found under ${RELEASE_DIR}`);
  const verified = [];
  for (const app of apps) {
    // A finished build keeps no update feed: afterPack removed it before
    // signing, and this second pass proves the shipped bundle has none and
    // pins exactly the origin this build was asked for.
    verified.push(await verifyProductApp({ ...app, expectOrigin: origin }));
  }
  return {
    dryRun: false,
    origin,
    platform: options.platform,
    arch: options.arch ?? "configured targets",
    dir: options.dir,
    unsigned: options.unsigned,
    localOrigin: options.localOrigin,
    /** True when the bundle carries the origin's public certificate (resource v2). */
    pinnedCertificate: gatewayCa !== null,
    configPath,
    productServicePath,
    outputDir: path.relative(root, RELEASE_DIR),
    apps: verified,
    caveat: options.unsigned
      ? "Unsigned verification artifacts: not notarized, and they do not pass system distribution checks."
      : "Signing and notarization depend on the operator's certificate; this wrapper asserts neither.",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const receipt = await packageProduct(options);
  console.log(JSON.stringify({ ok: true, ...receipt }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : `[package-product] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
