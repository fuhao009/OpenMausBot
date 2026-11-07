import { describe, expect, it } from "vitest";
import { PRODUCT_HIDDEN_SECTIONS, SECTIONS, SIMPLE_PAGES, keySearchResults, sectionMatches, simpleSettingsPages } from "./SettingsModal";
import type { AppSettingsSection } from "@/state/store";
import { KEY_CATALOG, keyEntry } from "./keys/key-catalog";
import type { KeySectionId } from "./keys/key-catalog";

// What a managed account's workspace offers: its AI is the account's, and the personal models, provider keys, decision
// model, organization, Cloud and server pages would only lead to setups the server refuses. Apps and computers stay.
const PRODUCT_KEYS: ReadonlySet<KeySectionId> = new Set<KeySectionId>(["apps", "computers", "voice"]);

const everything = new Set<AppSettingsSection>([...SECTIONS.map((entry) => entry.id), "updates"]);
const productAvailable = new Set([...everything].filter((id) => !PRODUCT_HIDDEN_SECTIONS.includes(id)));

describe("Settings for a managed account", () => {
  it("hides the provider, key, decision model, organization, Cloud and server pages, and keeps everything else", () => {
    for (const id of ["engines", "decisionModel", "organization", "cloudAccount", "desktopWorkspaces", "workspaces"] as const) {
      expect(PRODUCT_HIDDEN_SECTIONS).toContain(id);
      expect(productAvailable.has(id), `${id} must not be offered`).toBe(false);
    }
    for (const id of ["general", "appearance", "computer", "logins", "connections", "account", "usage", "import"] as const) {
      expect(productAvailable.has(id), `${id} must stay`).toBe(true);
    }
  });

  it("keeps only third-party app and computer credentials on the keys page, never a provider key", () => {
    const offered = KEY_CATALOG.filter((entry) => PRODUCT_KEYS.has(entry.section));
    expect(offered.map((entry) => entry.id)).toEqual(expect.arrayContaining(["composio", "box", "vps", "treg"]));
    expect(offered.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["openai", "anthropic", "openrouter", "openaiCompat", "lmStudio"]));
    // A row that borrows a provider key would point at a row the page no longer shows.
    for (const entry of offered.filter((candidate) => candidate.uses)) {
      expect(PRODUCT_KEYS.has(keyEntry(entry.uses!).section), entry.id).toBe(false);
    }
  });

  it("finds a credential by name only where that credential exists", () => {
    expect(keySearchResults("fish").map((entry) => entry.id)).toEqual(["fishAudio"]);
    // Voice belongs to its own provider, so it stays; a model provider key does not.
    expect(keySearchResults("fish", PRODUCT_KEYS).map((entry) => entry.id)).toEqual(["fishAudio"]);
    // OpenAI's model key is gone, and so is the live-call row that borrows it; the live-call key of its own stays.
    expect(keySearchResults("openai", PRODUCT_KEYS).map((entry) => entry.id)).toEqual(["liveKey"]);
    expect(keySearchResults("openrouter", PRODUCT_KEYS)).toEqual([]);
    expect(keySearchResults("composio", PRODUCT_KEYS).map((entry) => entry.id)).toEqual(["composio"]);
    expect(keySearchResults("", PRODUCT_KEYS)).toEqual([]);
  });

  it("keeps the keys page itself, whose remaining rows are the ones search can still find", () => {
    const connections = SECTIONS.find((entry) => entry.id === "connections")!;
    expect(sectionMatches(connections, "composio", PRODUCT_KEYS)).toBe(true);
    // The page still exists for apps and computers; a provider key simply has no row inside it.
    expect(keySearchResults("anthropic", PRODUCT_KEYS)).toEqual([]);
    expect(keySearchResults("1password", PRODUCT_KEYS).map((entry) => entry.id)).toEqual(["onePassword"]);
  });

  it("gives the account its own page and drops the model-provider page from AI", () => {
    const pages = simpleSettingsPages(productAvailable, "general", { productManaged: true });
    expect(pages.map((page) => page.id)).toEqual(["general", "account", "botAccess", "computer", "billing", "updates", "connections"]);
    expect(pages.some((page) => page.id === "account")).toBe(true);
    expect(pages.some((page) => page.id === "ai"), "the model-provider page is gone, not emptied").toBe(false);
    // The remaining page holds only what a managed account may still change.
    expect(pages.find((page) => page.id === "connections")!.sections).toEqual(["connections"]);
    expect(pages.find((page) => page.id === "billing")!.sections).toEqual(["usage"]);
    expect(pages.find((page) => page.id === "computer")!.sections).not.toContain("desktopWorkspaces");
  });

  it("leaves an ordinary installation exactly as it was", () => {
    // The caller adds "updates" itself (it is not a rail section) and leaves out the account page, exactly as
    // SettingsModal does for an installation that is not a managed account's.
    const ordinary = new Set([...everything].filter((id) => id !== "account"));
    const pages = simpleSettingsPages(ordinary, "general");
    // The account page is declared for both builds but holds no section here, so it does not appear.
    expect(pages.map((page) => page.id)).toEqual(SIMPLE_PAGES.map((page) => page.id).filter((id) => id !== "account"));
    expect(pages.some((page) => page.id === "connections")).toBe(false);
    expect(pages.find((page) => page.id === "ai")!.sections).toEqual(["engines", "connections"]);
    expect(pages.some((page) => page.id === "account")).toBe(false);
  });
});
