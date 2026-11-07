// A product account's model catalog owns every choice: one managed route, no personal engine, and a catalog that goes
// away never rewrites a transcript. MausBot's product intro is a plain line, and it is not crowned Chief.
import { rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { ensureDefaultBot, productWelcomeMessage, productWelcomeText } from "./default-bot.ts";
import { reconcileModelSelections, type ManagedModelPolicy } from "./hosted-models.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { OrgInstallStatus } from "./presets.ts";
import { Store, type BotRecord } from "./store.ts";
import { createBotCreateRoutes, type BotCreateRouteDeps, type ModelSelectionCheck } from "./routes/bots-create.ts";
import { PASS, type RouteContext } from "./routes/table.ts";
import type { WireBot } from "../shared/wire.ts";

const productSelection: ModelSelection = { instanceId: "product-ai", model: "model-a" };
/** What POST /api/bots answers: the created bot, or the refusal. */
type CreateAnswer = { status: number; body: { bot?: { id: string; modelSelection: ModelSelection }; error?: string } };

/** A product catalog with no personal engine, shaped like ProductAiProviders: an empty catalog allows nothing and
 * selects nothing. */
function productPolicy(models: readonly string[], state: "ready" | "pending" = "ready"): ManagedModelPolicy {
  const listed = () => state === "ready" ? [...models] : [];
  const allows = (selection: ModelSelection) => selection.instanceId === "product-ai" && listed().includes(selection.model);
  const select = (previous?: ModelSelection): ModelSelection => previous && allows(previous)
    ? { instanceId: previous.instanceId, model: previous.model }
    : listed().length ? { instanceId: "product-ai", model: listed()[0]! } : { instanceId: "", model: "" };
  const resetTask = (previous: ModelSelection, next: ModelSelection) => previous.instanceId === next.instanceId && previous.model === next.model ? {}
    : { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined };
  const error = () => listed().length ? "This model is not available to your account." : "Account AI is not available right now.";
  return { allows, select, resetTask, error };
}

/** The selection a request asked for, or null when it named no complete route. */
function modelSelectionOf(raw: unknown): ModelSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const { instanceId, model } = raw as Record<string, unknown>;
  return typeof instanceId === "string" && instanceId.trim() && typeof model === "string" && model.trim()
    ? { instanceId: instanceId.trim(), model: model.trim() } : null;
}

function createFixture(policy: ManagedModelPolicy) {
  const store = new Store(() => productSelection);
  // Only what POST /api/bots touches before the write; any other dependency reached would throw.
  const deps: BotCreateRouteDeps = {
    store,
    cfg: { newBotDefaults: undefined } as AppConfig,
    presetStore: { resolve: () => null },
    orgInstallStatuses: () => new Map<string, OrgInstallStatus>(),
    hostedWorkspace: false, hostedFullAccessRefusal: "not here", desktopManaged: true,
    maxWorkspaceBots: 100, cloudOwnerKey: null,
    hostedModels: policy, cloudRoutineAuthors: null,
    routines: () => null,
    storedAvatarExists: () => false,
    defaultSelection: async () => policy.select(),
    checkedModelSelection(raw: unknown): ModelSelectionCheck {
      const selection = modelSelectionOf(raw);
      if (!selection) return { ok: false, status: 400, error: "modelSelection.instanceId and model are required" };
      return policy.allows(selection) ? { ok: true, selection } : { ok: false, status: 400, error: policy.error() };
    },
    cloudOwnerSession: () => false,
    // The route only relays this value; the test reads the stored record, never the wire projection.
    wireBot: (bot: BotRecord): WireBot => bot as unknown as WireBot,
  };
  const handler = createBotCreateRoutes(deps);
  const create = async (body: Record<string, unknown>): Promise<CreateAnswer> => {
    const sent: CreateAnswer[] = [];
    const out = await handler({
      req: { headers: {} } as unknown as IncomingMessage,
      res: {} as unknown as ServerResponse,
      url: new URL("http://localhost/api/bots"),
      path: "/api/bots", method: "POST",
      auth: { kind: "loopback", scopes: ["admin", "client"] } as RequestAuth,
      json: ((_res: ServerResponse, status: number, response: unknown) => { sent.push({ status, body: response as CreateAnswer["body"] }); }) as RouteContext["json"],
      readBody: (async () => body) as RouteContext["readBody"],
    });
    expect(out).not.toBe(PASS);
    expect(sent).toHaveLength(1);
    return sent[0]!;
  };
  return { store, create };
}

beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));

describe("a product account creates bots only on its managed route", () => {
  it("takes the policy's default and the models it allows", async () => {
    const { store, create } = createFixture(productPolicy(["model-a", "model-b"]));
    const created = await create({ name: "Scout" });
    expect(created.status).toBe(201);
    const createdBot = created.body.bot!;
    expect(createdBot.modelSelection).toEqual(productSelection);
    expect(store.bot(createdBot.id)?.modelSelection).toEqual(productSelection);

    const picked = await create({ name: "Reader", modelSelection: { instanceId: "product-ai", model: "model-b" } });
    expect(picked.status).toBe(201);
    expect(picked.body.bot!.modelSelection).toEqual({ instanceId: "product-ai", model: "model-b" });
  });

  const refusedSelections: Array<[string, ModelSelection]> = [
    ["a personal provider", { instanceId: "claude", model: "claude-sonnet-5" }],
    ["another managed model", { instanceId: "product-ai", model: "model-not-listed" }],
  ];
  it.each(refusedSelections)("refuses %s instead of falling back to a personal engine", async (_label, modelSelection) => {
    const { store, create } = createFixture(productPolicy(["model-a"]));
    const refused = await create({ name: "Must not exist", modelSelection });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("This model is not available to your account.");
    expect(store.bots).toHaveLength(0);
  });

  it("refuses creation with an empty catalog rather than choosing a personal engine", async () => {
    for (const policy of [productPolicy([]), productPolicy(["model-a"], "pending")]) {
      const { store, create } = createFixture(policy);
      const refused = await create({ name: "No models" });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe("Account AI is not available right now.");
      expect(store.bots).toHaveLength(0);
    }
  });
});

describe("reconciling saved choices against a managed catalog", () => {
  function seeded() {
    const store = new Store(() => productSelection);
    const bot = store.createBot({ name: "Jarvis", title: "My helper", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } });
    const pinned = store.createTask(bot.id, "Kept history", false, undefined, undefined, undefined, { instanceId: "codex", model: "gpt-5" })!;
    const follows = store.createTask(bot.id, "Follows the bot", false)!;
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "Remember this line." });
    return { store, bot, pinned, follows };
  }

  it("moves every unallowed choice to the policy default, clearing only continuation, never the transcript or profile", () => {
    const { store, bot, pinned, follows } = seeded();
    const transcript = store.messagesFor(bot.threadId);
    reconcileModelSelections(productPolicy(["model-a"]), store);
    expect(store.bot(bot.id)).toMatchObject({ name: "Jarvis", title: "My helper", modelSelection: productSelection });
    expect(store.taskByThread(bot.id, pinned.threadId)?.modelSelection).toEqual(productSelection);
    expect(store.taskByThread(bot.id, follows.threadId)?.modelSelection).toBeUndefined();
    for (const threadId of [pinned.threadId, follows.threadId]) {
      const task = store.taskByThread(bot.id, threadId)!;
      expect(task.resumeCursors).toEqual({});
      expect(task.lastInstanceId).toBeUndefined();
      expect(task.rewound).toBe(true);
      expect(task.lastContextModel).toBeUndefined();
      expect(task.appliedCompactionId).toBeUndefined();
      expect(task.title).toBe(threadId === pinned.threadId ? "Kept history" : "Follows the bot");
    }
    expect(store.messagesFor(bot.threadId)).toEqual(transcript);
  });

  it("keeps an allowed choice and its live continuation untouched", () => {
    const { store, bot, pinned } = seeded();
    store.patchBot(bot.id, { modelSelection: productSelection });
    store.patchTask(bot.id, pinned.threadId, { modelSelection: productSelection, resumeCursors: { "product-ai": "live" }, lastInstanceId: "product-ai" });
    reconcileModelSelections(productPolicy(["model-a"]), store);
    expect(store.bot(bot.id)?.modelSelection).toEqual(productSelection);
    expect(store.taskByThread(bot.id, pinned.threadId)).toMatchObject({ resumeCursors: { "product-ai": "live" }, lastInstanceId: "product-ai" });
  });

  it("resets continuation for every thread once the catalog's route changed, even where the model id stays", () => {
    const { store, bot, pinned, follows } = seeded();
    store.patchBot(bot.id, { modelSelection: productSelection });
    store.patchTask(bot.id, pinned.threadId, { modelSelection: productSelection, resumeCursors: { "product-ai": "stale" } });
    reconcileModelSelections(productPolicy(["model-a"]), store, { routeChanged: true });
    expect(store.taskByThread(bot.id, pinned.threadId)?.resumeCursors).toEqual({});
    expect(store.taskByThread(bot.id, pinned.threadId)?.modelSelection).toEqual(productSelection);
    // A thread that followed the bot has no pin of its own: the reset must not invent one.
    expect(store.taskByThread(bot.id, follows.threadId)?.modelSelection).toBeUndefined();
  });

  it("leaves every choice empty when the catalog is empty, still keeping names, titles and history", () => {
    const { store, bot, pinned } = seeded();
    const transcript = store.messagesFor(bot.threadId);
    reconcileModelSelections(productPolicy([]), store);
    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "", model: "" });
    expect(store.taskByThread(bot.id, pinned.threadId)?.modelSelection).toEqual({ instanceId: "", model: "" });
    expect(store.bot(bot.id)).toMatchObject({ name: "Jarvis", title: "My helper" });
    expect(store.messagesFor(bot.threadId)).toEqual(transcript);
  });
});

describe("MausBot's product welcome", () => {
  it("says a plain line in English or Chinese, never the look-around intro", () => {
    expect(productWelcomeMessage("zh")).toEqual({ role: "bot", kind: "text", text: productWelcomeText("zh") });
    expect(productWelcomeMessage().helperIntro).toBeUndefined();
    expect(productWelcomeMessage().helperFollowup).toBeUndefined();
  });

  it("welcome, not crowned: chief: false makes an ordinary default bot, and a custom intro is its first message", () => {
    const store = new Store(() => productSelection);
    const maus = ensureDefaultBot(store, { dataDir: DATA_DIR, intro: () => productWelcomeMessage("en"), chief: false })!;
    expect(maus).toMatchObject({ name: "MausBot", defaultBot: {} });
    expect(maus.chiefOfStaff).toBeFalsy();
    expect(store.messagesFor(maus.threadId).filter((message) => message.role === "bot").some((message) => message.text === productWelcomeText("en"))).toBe(true);
    expect(store.messagesFor(maus.threadId).some((message) => message.helperIntro)).toBe(false);
  });

  it("keeps a renamed, used MausBot and its transcript on the next start", () => {
    const store = new Store(() => productSelection);
    const maus = ensureDefaultBot(store, { dataDir: DATA_DIR, intro: () => productWelcomeMessage("en"), chief: false })!;
    store.patchBot(maus.id, { name: "Jarvis" });
    store.appendMessage(maus.threadId, { role: "user", kind: "text", text: "Hello" });
    const restarted = new Store(() => productSelection);
    expect(ensureDefaultBot(restarted, { dataDir: DATA_DIR, intro: () => productWelcomeMessage("en"), chief: false })?.id).toBe(maus.id);
    expect(restarted.bot(maus.id)).toMatchObject({ name: "Jarvis" });
    expect(restarted.messagesFor(maus.threadId).filter((message) => message.text === productWelcomeText("en"))).toHaveLength(1);
  });

  it("keeps the existing auto-Chief behaviour when no chief option is given", () => {
    const store = new Store(() => productSelection);
    expect(ensureDefaultBot(store, { dataDir: DATA_DIR })).toMatchObject({ chiefOfStaff: true });
  });

  it("gives an adopted seeded MausBot the product welcome too, on top of its history, and does not crown it", () => {
    const store = new Store(() => productSelection);
    const seeded = store.createBot({ name: "MausBot", color: "silver" });
    const first = seeded.threadId;
    store.appendMessage(first, { role: "user", kind: "text", text: "Book my flights." });
    const before = store.messagesFor(first).map((message) => message.id);
    const adopted = ensureDefaultBot(store, { dataDir: DATA_DIR, intro: () => productWelcomeMessage("zh"), chief: false })!;
    expect(adopted.id).toBe(seeded.id);
    expect(adopted).toMatchObject({ defaultBot: {}, color: "chrome" });
    expect(adopted.chiefOfStaff).toBeFalsy();
    // Nobody's earlier message moves: the welcome lands at the top of a new conversation.
    expect(store.messagesFor(first).map((message) => message.id)).toEqual(before);
    const welcomed = (adopted.tasks ?? []).flatMap((task) => store.messagesFor(task.threadId)).filter((message) => message.text === productWelcomeText("zh"));
    expect(welcomed).toHaveLength(1);
    expect(store.messagesFor(adopted.threadId).some((message) => message.helperIntro)).toBe(false);
  });
});
