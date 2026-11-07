import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ExecutionConnectorHost, type ExecutionConnectorOptions } from "./execution-connectors.ts";
import { createExecutionConnectorRoutes } from "./routes/execution-connectors.ts";
import { json, readBody } from "./harness/http.ts";
import { PASS } from "./routes/table.ts";

/** One service process per dedicated OS account/container. Never multiplex account credentials in one HOME. */
export function createExecutionService(options: ExecutionConnectorOptions & { token: string; account: string }) {
  if (options.token.length < 32 || !options.account) throw new Error("A private account id and strong token are required.");
  const host = new ExecutionConnectorHost({ ...options, localAvailable: true });
  const routes = createExecutionConnectorRoutes({ host, owner: () => options.account });
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected) || req.headers.origin) return json(res, 401, { error: "unauthorized" });
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // A service cannot chain through another service or accept arbitrary execution configuration.
      const body = async () => {
        const value = await readBody(req);
        if (value?.location && value.location !== "local") throw new Error("This account service executes locally only.");
        return value;
      };
      const result = await routes({ req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody: body });
      if (result === PASS) json(res, 404, { error: "not found" });
    } catch { json(res, 400, { error: "Invalid execution request." }); }
  });
  return { server, host };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.env.OMB_EXECUTION_SERVICE_CONFIG;
  if (!file) throw new Error("Set OMB_EXECUTION_SERVICE_CONFIG to an account-owned mode-0600 JSON file.");
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Execution config must be owned by this OS user and private (0600).");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (config.isolatedAccount !== true || typeof config.home !== "string" || !isAbsolute(config.home) || config.home !== process.env.HOME || typeof config.root !== "string" || !isAbsolute(config.root)) throw new Error("Use one dedicated OS user/container and HOME per account; set isolatedAccount:true, home and root explicitly.");
  const { server, host } = createExecutionService({ root: join(config.root, "tasks"), localAvailable: true, ownsBot: (_owner, botId) => typeof botId === "string" && /^[\w-]{1,128}$/.test(botId), token: config.token, account: config.account, cli: config.cli });
  server.listen(config.port ?? 47831, "127.0.0.1", () => console.log("Execution service listening on loopback; terminate HTTPS at an authenticated private reverse proxy."));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { server.close(); void host.dispose().finally(() => process.exit(0)); });
}
