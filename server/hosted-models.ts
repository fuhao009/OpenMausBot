import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import { cloudHomeConfigured } from "./cloud-home.ts";
import { hostedWorkspaceConfiguration } from "./enterprise.ts";
import type { InstanceConfigMap, ModelSelection, ProviderInstance } from "./contracts.ts";
import type { Store, TaskPatch } from "./store.ts";

export const HOSTED_MODEL_POLICY_HEADER = "X-Omb-Hosted-Model-Policy";
export const HOSTED_MODEL_SETUP_ERROR = "No company models are assigned to this workspace. Ask your administrator to enable model access in Admin.";
export const HOSTED_MODEL_SELECTION_ERROR = "This model is not assigned to this workspace. Choose one of its company models.";
export const HOSTED_PROVIDER_SETTINGS_ERROR = "Company models and provider accounts are managed in Admin.";

/** The task fields a changed managed model route clears: the old route's continuation cursor and context handles. The
 * transcript, thread id, title and every other field stay exactly as they were. */
const RESET_CONTINUATION: TaskPatch = { resumeCursors: {}, lastInstanceId: undefined, rewound: true, lastContextModel: undefined, appliedCompactionId: undefined };

/** The reset a task gets when its route moves: nothing while it stays on the same instance and model. */
export function modelRouteReset(previous: ModelSelection, next: ModelSelection): TaskPatch {
  return previous.instanceId !== next.instanceId || previous.model !== next.model ? { ...RESET_CONTINUATION } : {};
}

/** The store surface a managed catalog reconciles: bots and their thread choices, nothing else. */
export type ReconcileStore = Pick<Store, "bots" | "tasks" | "patchTask" | "patchBot">;

/** What routing and creation need from a managed model catalog: a Company workspace's assignments today, a product
 * account's gateway models in the desktop app. Both own the choice of model; neither falls back to a personal engine. */
export interface ManagedModelPolicy {
  allows(selection: ModelSelection): boolean;
  select(previous?: ModelSelection): ModelSelection;
  resetTask(previous: ModelSelection, next: ModelSelection): TaskPatch;
  error(): string;
}

/** Replaces every saved bot and thread choice the policy no longer allows with its default, clearing the continuation
 * that belonged to the old route. Transcripts, names, titles and visibility are never touched. An empty catalog leaves
 * every choice empty: no personal engine is ever substituted. */
export function reconcileModelSelections(
  policy: Pick<ManagedModelPolicy, "select">,
  store: ReconcileStore,
  options: { routeChanged?: boolean } = {},
): void {
  for (const bot of store.bots) {
    const previousDefault = bot.modelSelection;
    const nextDefault = policy.select(previousDefault);
    for (const task of store.tasks(bot.id)) {
      const current = task.modelSelection ?? previousDefault;
      const next = policy.select(current);
      const changed = options.routeChanged === true || JSON.stringify(next) !== JSON.stringify(current);
      if (changed) store.patchTask(bot.id, task.threadId, {
        ...(task.modelSelection ? { modelSelection: next } : {}), ...RESET_CONTINUATION,
      });
    }
    if (JSON.stringify(previousDefault) !== JSON.stringify(nextDefault)) store.patchBot(bot.id, { modelSelection: nextDefault });
  }
}
const nativeModels = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/)).max(100);
const catalogSchema = z.object({
  anthropic: nativeModels,
  openai: nativeModels,
  openrouter: z.array(z.string().max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/+-]*$/)).max(100),
}).strict();
type HostedCatalog = z.infer<typeof catalogSchema>;
const providerFor = { claude: "anthropic", codex: "openai", opencode: "openrouter" } as const;

/** Operator-only: partial policy configuration must never enable it, and a Cloud home ignores it. */
export function hostedModelPolicy(dataDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.OMB_HOSTED_MODELS === undefined && env.OMB_HOSTED_MODEL_TOKEN === undefined) return null;
  if (cloudHomeConfigured(env)) return null;
  const hosted = hostedWorkspaceConfiguration(env);
  if (!hosted?.portalMembership || env.OMB_DESKTOP_PARENT === "1" || !/^omb_workspace_[A-Za-z0-9_-]{43}$/.test(env.OMB_HOSTED_MODEL_TOKEN ?? "")) {
    throw new Error("Hosted model access requires complete portal-managed configuration.");
  }
  let catalog: HostedCatalog;
  try {
    if (!env.OMB_HOSTED_MODELS || env.OMB_HOSTED_MODELS.length > 65536) throw new Error();
    catalog = catalogSchema.parse(JSON.parse(env.OMB_HOSTED_MODELS));
  } catch { throw new Error("Invalid hosted model catalog."); }
  for (const key of ["anthropic", "openai", "openrouter"] as const) catalog[key] = [...new Set(catalog[key])];
  const token = env.OMB_HOSTED_MODEL_TOKEN!;
  const base = `${hosted.admin.origin}/api/gateway/${hosted.workspace}`;
  const assigned = (id: string): string[] => Object.hasOwn(providerFor, id) ? catalog[providerFor[id as keyof typeof providerFor]] : [];
  const allows = (selection: ModelSelection) => assigned(selection.instanceId).includes(selection.model);
  const normalized = (selection: ModelSelection): ModelSelection => {
    if (selection.instanceId === "codex" && selection.model.startsWith("omb-managed-openai::")) {
      return { ...selection, model: selection.model.slice("omb-managed-openai::".length) };
    }
    if (["opencode", "opencodeGo"].includes(selection.instanceId) && selection.model.startsWith("omb-managed-openrouter/")) {
      return { instanceId: "opencode", model: selection.model.slice("omb-managed-openrouter/".length) };
    }
    if (selection.instanceId === "opencode") return { instanceId: "opencode", model: selection.model };
    return selection;
  };
  const select = (previous?: ModelSelection): ModelSelection => {
    const current = previous ? normalized(previous) : undefined;
    if (current && allows(current)) return { ...current };
    const id = current && assigned(current.instanceId).length ? current.instanceId
      : Object.keys(providerFor).find(id => assigned(id).length);
    return id ? { instanceId: id, model: assigned(id)[0] } : { instanceId: "", model: "" };
  };
  const home = (name: string) => {
    let directory = dataDirectory;
    for (const part of ["providers", "hosted", name]) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Hosted provider storage must be an owned directory.");
    }
    return directory;
  };
  return {
    allows, select,
    resetTask(previous: ModelSelection, next: ModelSelection) {
      return modelRouteReset(previous, next);
    },
    error: () => Object.values(catalog).some(models => models.length) ? HOSTED_MODEL_SELECTION_ERROR : HOSTED_MODEL_SETUP_ERROR,
    configs(): InstanceConfigMap {
      const configs: InstanceConfigMap = {};
      // Saved instance commands are tenant-editable; only the operator may replace the bundled executables.
      const cli = (name: "CLAUDE" | "CODEX") => env[`OMB_HOSTED_${name}_CLI`]?.trim() || name.toLowerCase();
      if (catalog.anthropic.length) configs.claude = {
        driver: "claudeAgent", displayName: "Company · Claude",
        config: { cli: cli("CLAUDE"), managed: true, managedModels: catalog.anthropic, configDir: home("claude") },
        environment: { ANTHROPIC_API_KEY: token, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_BASE_URL: `${base}/anthropic`,
          ANTHROPIC_MODEL: catalog.anthropic[0], ANTHROPIC_DEFAULT_HAIKU_MODEL: catalog.anthropic[0],
          ANTHROPIC_DEFAULT_SONNET_MODEL: catalog.anthropic[0], ANTHROPIC_DEFAULT_OPUS_MODEL: catalog.anthropic[0],
          ANTHROPIC_SMALL_FAST_MODEL: catalog.anthropic[0] },
      };
      if (catalog.openai.length) configs.codex = {
        driver: "codex", displayName: "Company · Codex",
        config: { cli: cli("CODEX"), managed: { url: `${base}/openai/v1`, models: catalog.openai } },
        environment: { HEZUO_COMPANY_API_KEY: token, CODEX_HOME: home("codex") },
      };
      if (catalog.openrouter.length) configs.opencode = {
        driver: "openai-compat", displayName: "Company · OpenRouter",
        config: { url: `${base}/openrouter/v1`, apiKeyEnv: "HEZUO_COMPANY_API_KEY", provider: "", model: catalog.openrouter[0], managedModels: catalog.openrouter },
        environment: { HEZUO_COMPANY_API_KEY: token },
      };
      return configs;
    },
    decorate(instance: ProviderInstance): ProviderInstance {
      const models = assigned(instance.instanceId);
      return {
        ...instance,
        models: { default: models[0], options: models.map(id => ({ id, label: id })) },
        refreshModels: async () => {},
        installRuntime: undefined, startAuthentication: undefined, getAuthentication: undefined,
        completeAuthentication: undefined, cancelAuthentication: undefined, signOut: undefined,
        snapshot: async () => ({ ...await instance.snapshot(), authenticated: true, billing: "metered" }),
        adapter: { ...instance.adapter, sendTurn: async input => {
          if (!input.model || !models.includes(input.model)) throw new Error(HOSTED_MODEL_SELECTION_ERROR);
          return instance.adapter.sendTurn(input);
        } },
      };
    },
    reconcile(store: Store) {
      const marker = join(dataDirectory, "hosted-model-policy.json");
      const identity = JSON.stringify({ version: 1, admin: hosted.admin.origin, workspace: hosted.workspace });
      const routeChanged = !existsSync(marker) || readFileSync(marker, "utf8") !== identity;
      reconcileModelSelections({ select }, store, { routeChanged });
      writeFileAtomic(marker, identity, { mode: 0o600 });
    },
  };
}
