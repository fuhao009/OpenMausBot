import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { WebhookTrigger } from "../../shared/webhooks.ts";
import { onConfigSaved } from "../config.ts";
import { adminAuditPlan, type AuditPlan } from "../admin-audit-plan.ts";
import { appendAdminAction, BOT_AUDIT_FIELDS, botAuditSnapshot, botChangeRows, TEAM_BOT_AUDIT_FIELDS, configChangeRows, sharedSignIn, signInListsOf, type AdminActionRow, type AdminActor } from "../admin-activity.ts";
import { onJsonBody, parsedBodyOf } from "../harness/http.ts";

interface AdminAuditHost {
  desktopManaged: boolean;
  hostedWorkspace: boolean;
  cloudTeam: boolean;
  dataDir: string;
  store(): Pick<Store, "bot" | "group">;
  webhooks(): WebhookTrigger[];
  sessions: SessionRegistry;
  signInAllowList(): Parameters<typeof sharedSignIn>[0];
  decisionActorFor(auth: RequestAuth): AdminActor;
  lendingEnabled(): boolean;
}

/** Records request-scoped changes without attributing concurrent admin writes to this request. */
export function createAdminAudit(host: AdminAuditHost) {
  const { sessions } = host;
  function adminActivityRecording(): boolean {
    if (host.desktopManaged) return false;
    if (host.hostedWorkspace || host.cloudTeam) return true;
    const chatOnly = (scopes: readonly string[]) => !scopes.includes("admin");
    return sharedSignIn(host.signInAllowList()) || sessions.list().some((session) => chatOnly(session.scopes)) ||
      sessions.openPairings().some((pairing) => chatOnly(pairing.scopes));
  }
  
  function adminActorFor(auth: RequestAuth, req: IncomingMessage): AdminActor {
    if (auth.kind === "loopback" && auth.trust !== "service" &&
      (req.headers["x-hezuo-cli"] === "1" || req.headers["x-hezuo-cli-owner"] !== undefined)) return { kind: "cli" };
    return host.decisionActorFor(auth);
  }
  
  const adminActorScope = new AsyncLocalStorage<{ actor: AdminActor; sharedAtStart: boolean } | null>();
  onConfigSaved((before, after) => {
    const scope = adminActorScope.getStore();
    if (!scope || host.desktopManaged) return;
    if (!scope.sharedAtStart && !adminActivityRecording() && !sharedSignIn(signInListsOf(before)) && !sharedSignIn(signInListsOf(after))) return;
    for (const row of configChangeRows(before, after)) appendAdminAction(host.dataDir, { ...row, actor: scope.actor });
  });
  
  const WEBHOOK_AUDIT_FIELDS = ["name", "prompt", "botId", "runOn", "enabled", "eventTypes"] as const;
  const BOT_AUDITED = host.cloudTeam ? TEAM_BOT_AUDIT_FIELDS : BOT_AUDIT_FIELDS;
  const auditBot = (id: string | undefined) => (id ? botAuditSnapshot(host.store().bot(id) as unknown as Record<string, unknown> | null, BOT_AUDITED) : null);
  const auditHook = (id: string | undefined) => (id ? host.webhooks().find((hook) => hook.id === id) : undefined);
  const hookFields = (hook: WebhookTrigger, fields: readonly string[] = WEBHOOK_AUDIT_FIELDS) =>
    Object.fromEntries(fields.map((field) => [field, (hook as unknown as Record<string, unknown>)[field] ?? null]));
  
  function requestedBotFields(req: IncomingMessage, path: string): string[] {
    if (path.endsWith("/always-allow")) return ["alwaysAllow"];
    if (path.endsWith("/model")) return ["modelSelection"];
    const body = parsedBodyOf(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return [];
    const fields = new Set(Object.keys(body));
    if (fields.has("autoApprove") || fields.has("approvalMode")) fields.add("autoApprove").add("approvalMode");
    if (fields.has("chiefOfStaff")) fields.add("managedSections");
    return [...fields];
  }
  
  /** Each row compares only what this request named or created, so another admin's concurrent change is not attributed here. */
  function beginAdminAudit(req: IncomingMessage, res: ServerResponse, method: string, path: string, auth: RequestAuth): void {
    const plan = host.desktopManaged ? null : adminAuditPlan(method, path, host.lendingEnabled());
    const actor = plan ? adminActorFor(auth, req) : null;
    const sharedAtStart = plan ? adminActivityRecording() : false;
    // Set for every request, so a kept-alive connection never inherits one.
    adminActorScope.enterWith(plan?.config && actor ? { actor, sharedAtStart } : null);
    if (!plan || !actor) return;
    const before = {
      bot: auditBot(plan.botId ?? plan.deletesBot),
      botName: host.store().bot(plan.botId ?? plan.deletesBot ?? "")?.name,
      hook: auditHook(plan.webhookId),
      session: plan.sessionId ? sessions.list().find((session) => session.id === plan.sessionId) : undefined,
      roomFloor: plan.roomId ? host.store().group(plan.roomId)?.audienceFloor ?? "everyone" : undefined,
    };
    let answered: unknown;
    if (plan.createsBots || plan.createsWebhook || plan.pairing) onJsonBody(res, (body) => (answered = body));
    res.once("finish", () => {
      if (res.statusCode >= 400 || (!sharedAtStart && !adminActivityRecording())) return;
      try {
        for (const row of adminAuditRows(plan, req, path, before, answered)) appendAdminAction(host.dataDir, { ...row, actor });
      } catch (error) {
        console.warn(`admin activity: could not record ${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  
  function adminAuditRows(
    plan: AuditPlan,
    req: IncomingMessage,
    path: string,
    before: { bot: Record<string, unknown> | null; botName?: string; hook?: WebhookTrigger; session?: ReturnType<typeof sessions.list>[number]; roomFloor?: unknown },
    answered: unknown,
  ): Array<Omit<AdminActionRow, "at" | "actor">> {
    const rows: Array<Omit<AdminActionRow, "at" | "actor">> = [];
    const reply = answered && typeof answered === "object" ? answered as Record<string, unknown> : {};
    const idOf = (value: unknown) => (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" ? (value as { id: string }).id : undefined);
    if (plan.botId) {
      rows.push(...botChangeRows({ id: plan.botId, name: host.store().bot(plan.botId)?.name }, before.bot, auditBot(plan.botId), requestedBotFields(req, path), BOT_AUDITED));
    }
    if (plan.createsBots) {
      const created = [idOf(reply.bot), ...(Array.isArray(reply.bots) ? reply.bots.map(idOf) : [])].filter((id): id is string => Boolean(id));
      for (const id of new Set(created)) {
        const fields = auditBot(id);
        if (fields) rows.push({ category: "bot", action: "bot.create", target: { kind: "bot", id, name: host.store().bot(id)!.name }, after: fields });
      }
    }
    if (plan.deletesBot && before.bot && !host.store().bot(plan.deletesBot)) {
      rows.push({ category: "bot", action: "bot.delete", target: { kind: "bot", id: plan.deletesBot, ...(before.botName ? { name: before.botName } : {}) }, before: before.bot });
    }
    const hookTarget = (hook: WebhookTrigger) => ({ kind: "webhook", id: hook.id, name: hook.name });
    if (plan.createsWebhook) {
      const hook = auditHook(idOf(reply.webhook));
      if (hook) rows.push({ category: "webhook", action: "webhook.create", target: hookTarget(hook), after: hookFields(hook) });
    }
    if (plan.webhookId && before.hook) {
      const after = auditHook(plan.webhookId);
      if (!after) rows.push({ category: "webhook", action: "webhook.delete", target: hookTarget(before.hook), before: hookFields(before.hook) });
      else if (path.endsWith("/rotate")) rows.push({ category: "webhook", action: "webhook.rotate-secret", target: hookTarget(after) });
      else {
        const body = parsedBodyOf(req);
        const named = body && typeof body === "object" ? Object.keys(body) : [];
        const changed = WEBHOOK_AUDIT_FIELDS.filter((field) => named.includes(field) &&
          JSON.stringify(hookFields(before.hook!, [field])) !== JSON.stringify(hookFields(after, [field])));
        if (changed.length) {
          rows.push({ category: "webhook", action: "webhook.update", target: hookTarget(after), changed: [...changed], before: hookFields(before.hook, changed), after: hookFields(after, changed) });
        }
      }
    }
    if (before.session && !sessions.list().some((session) => session.id === before.session!.id)) {
      const session = before.session;
      rows.push({ category: "session", action: "session.revoke", target: { kind: "session", id: session.id, name: session.email ?? session.label },
        before: { label: session.label, ...(session.email ? { email: session.email } : {}), scopes: session.scopes } });
    }
    if (plan.pairing) {
      const pairing = sessions.openPairings().find((candidate) => candidate.id === reply.id);
      if (pairing) rows.push({ category: "session", action: "pairing.create", target: { kind: "pairing", name: pairing.label }, after: { label: pairing.label, scopes: pairing.scopes } });
    }
    if (plan.engineAction) rows.push({ category: "engine", action: `engine.${plan.engineAction.action}`, target: { kind: "engine", id: plan.engineAction.id } });
    const roomBody = plan.roomId ? parsedBodyOf(req) : undefined;
    const room = plan.roomId ? host.store().group(plan.roomId) : undefined;
    if (room && roomBody && typeof roomBody === "object" && (roomBody as { resetAudience?: unknown }).resetAudience === true) {
      rows.push({ category: "visibility", action: "room.audience-reset", target: { kind: "room", id: room.id, name: room.name },
        changed: ["audienceFloor"], before: { audienceFloor: before.roomFloor ?? "everyone" }, after: { audienceFloor: room.audienceFloor ?? "everyone" } });
    }
    return rows;
  }

  return { adminActorScope, beginAdminAudit, adminActivityRecording };
}
