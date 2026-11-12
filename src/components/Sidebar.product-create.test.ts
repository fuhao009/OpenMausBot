// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot } from "@/state/store";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => true }));
vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(), useAdvancedMode: () => mode.advanced,
}));
vi.mock("./DesktopCapabilities", async (original) => ({
  ...await original<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: false, platform: "other" }, localComputer: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("@/lib/cloud-guest", () => ({ useCanWriteIn: () => true }));

const { Sidebar } = await import("./Sidebar");
const { BotEditorStore, initialState } = await import("@/state/store");
const { setLocale } = await import("@/lib/i18n");
const bot: Bot = {
  id: "pepper", name: "Pepper", threadId: "current", title: "", description: "", color: "green", unread: false,
  notifications: true, messages: [], modelSelection: { instanceId: "test", model: "test" },
  tasks: [{ threadId: "current", title: "Current thread", createdAt: 1 }],
};
const dispatch = vi.fn();
let host: HTMLDivElement;
let root: Root;
const render = (productManaged: boolean) => flushSync(() => root.render(createElement(BotEditorStore, {
  value: {
    state: { ...initialState, connected: true, bots: [bot], selectedId: bot.id, config: { ...initialState.config, productManaged } as AppState["config"] },
    dispatch, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {},
  },
  children: createElement(Sidebar, { open: true, onClose: () => {} }),
})));
const plus = () => document.querySelector<HTMLButtonElement>('button[aria-label="New or share"]');
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent);

beforeEach(() => {
  mode.advanced = false;
  dispatch.mockReset();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("creating a bot in a product-managed workspace", () => {
  it("shows the + menu with New bot and none of the channel, team or library entries", () => {
    render(true);
    expect(plus()).not.toBeNull();
    flushSync(() => plus()!.click());
    expect(items()).toContain("New bot");
    expect(items()).not.toContain("New group chat");
    expect(items()).not.toContain("Team library");
    flushSync(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === "New bot")!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "newBot" });
  });

  it("keeps the channel entry in an ordinary workspace", () => {
    render(false);
    flushSync(() => plus()!.click());
    expect(items()).toEqual(expect.arrayContaining(["New bot", "New group chat"]));
  });
});
