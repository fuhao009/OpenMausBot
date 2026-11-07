import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateProductOrigin } from "./product-service.mjs";

export function productVerificationEntry(argv = process.argv, environment = process.env) {
  const args = argv.filter(arg => arg.startsWith("--omb-product-fixture-root="));
  const enabled = environment.OMB_PRODUCT_FIXTURE === "1";
  if (!enabled && args.length === 0) return null;
  if (!enabled || args.length !== 1) throw new Error("product_fixture_mismatch");
  const root = args[0].slice("--omb-product-fixture-root=".length);
  const temporary = fs.realpathSync(os.tmpdir());
  if (!path.isAbsolute(root) || !fs.statSync(root).isDirectory() || fs.realpathSync(root) !== root ||
      !root.startsWith(temporary + path.sep) || !path.basename(root).startsWith("omb-product-verify-")) {
    throw new Error("product_fixture_root_invalid");
  }
  const origin = validateProductOrigin(environment.OMB_PRODUCT_FIXTURE_ORIGIN, { allowLoopback: true });
  const url = new URL(origin);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("product_fixture_origin_invalid");
  const userData = path.join(root, "user-data");
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(userData) !== userData) throw new Error("product_fixture_root_invalid");
  return { root, userData, origin };
}
