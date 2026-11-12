import type { ExecutionConnectorHost } from "../execution-connectors.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";
export function createExecutionConnectorRoutes(deps: { host: ExecutionConnectorHost; owner(auth: RequestAuth): string | null }): RouteHandler {
  return async ctx => {
    if (!ctx.path.startsWith("/api/execution-connectors")) return PASS;
    const owner = deps.owner(ctx.auth);
    if (!owner) return void ctx.json(ctx.res, 403, { error: "Only this account's owner can manage execution connectors." });
    ctx.res.setHeader("cache-control", "no-store");
    const path = ctx.path.slice("/api/execution-connectors".length);
    try {
      const body = async () => {
        if (!/^application\/json(?:;|$)/i.test(ctx.req.headers["content-type"] ?? "")) throw new Error("Use application/json.");
        const input = await ctx.readBody(ctx.req);
        if (deps.owner(ctx.auth) !== owner) throw new Error("The owner session expired.");
        return input;
      };
      let result: unknown;
      if (!path && ctx.method === "GET") result = await deps.host.list(owner);
      else if (!path && ctx.method === "POST") result = await deps.host.create(owner, await body());
      else {
        const task = /^\/tasks\/([^/]+)(?:\/(approve|cancel))?$/.exec(path);
        const connector = /^\/([^/]+)(?:\/(tasks))?$/.exec(path);
        if (task && !task[2] && ctx.method === "GET") result = await deps.host.task(owner, task[1]);
        else if (task?.[2] === "approve" && ctx.method === "POST") result = await deps.host.approve(owner, task[1], await body());
        else if (task?.[2] === "cancel" && ctx.method === "POST") result = await deps.host.cancel(owner, task[1]);
        else if (connector?.[2] === "tasks" && ctx.method === "POST") result = await deps.host.start(owner, connector[1], await body());
        else if (connector && !connector[2] && ctx.method === "PATCH") result = await deps.host.grants(owner, connector[1], (await body()).botIds);
        else if (connector && !connector[2] && ctx.method === "DELETE") result = await deps.host.disconnect(owner, connector[1]);
        else return void ctx.json(ctx.res, 404, { error: "Execution route not found." });
      }
      ctx.json(ctx.res, 200, result);
    } catch (error) { ctx.json(ctx.res, 400, { error: error instanceof Error ? error.message : "Execution request failed." }); }
  };
}

export function createInternalExecutionConnectorRoutes(deps: {
  host: ExecutionConnectorHost;
  botId: string;
  readBody(): Promise<Record<string, any>>;
  owner(): string | null;
}): RouteHandler {
  return async ctx => {
    if (ctx.path !== "/api/internal/execution-connectors" || ctx.method !== "POST") return PASS;
    const body = await deps.readBody();
    const owner = deps.owner();
    if (!owner) return void ctx.json(ctx.res, 403, { error: "Execution needs an attributable owner request." });
    try {
      if (body.action === "list") {
        const list = await deps.host.list(owner);
        return void ctx.json(ctx.res, 200, { connectors: list.connectors.filter(c => c.botIds.includes(deps.botId)) });
      }
      if (body.action === "start") return void ctx.json(ctx.res, 200, await deps.host.start(owner, body.connectorId, { botId: deps.botId, prompt: body.prompt }));
      const task = await deps.host.task(owner, body.taskId);
      if (task.botId !== deps.botId) return void ctx.json(ctx.res, 403, { error: "Task belongs to another bot." });
      if (body.action === "status") return void ctx.json(ctx.res, 200, task);
      if (body.action === "cancel") return void ctx.json(ctx.res, 200, await deps.host.cancel(owner, task.id));
      ctx.json(ctx.res, 400, { error: "Use list, start, status or cancel. Only the owner can answer approvals." });
    } catch (error) { ctx.json(ctx.res, 400, { error: error instanceof Error ? error.message : "Execution request failed." }); }
  };
}
