import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { t } from "@/lib/i18n";
import { StoreProvider, type Bot } from "@/state/store";
import { draftOf, HezuoWelcomeCard, hezuoWelcomeDue, welcomeName, welcomePatch } from "./HezuoWelcome";

const hezuo = { id: "hezuo", threadId: "t1", name: "Hezuo", title: "", description: "", notifications: true, color: "chrome", mascotBody: null,
  avatarUrl: null, unread: false, modelSelection: { instanceId: "claude", model: "sonnet" }, createdAt: 1, defaultBot: {} } as unknown as Bot;

describe("Hezuo's first-launch welcome", () => {
  it("shows once, after onboarding and its tour, and never again after either choice", () => {
    const due = (bot: Pick<Bot, "welcomed" | "hidden"> | undefined, more: Partial<Parameters<typeof hezuoWelcomeDue>[0]> = {}) =>
      hezuoWelcomeDue({ bot, onboardingDue: false, welcomeOpen: false, tourOpen: false, ...more });
    expect(due({})).toBe(true);
    expect(due({ welcomed: true })).toBe(false);
    expect(due({}, { onboardingDue: true })).toBe(false);
    expect(due({}, { welcomeOpen: true })).toBe(false);
    expect(due({}, { tourOpen: true })).toBe(false);
    expect(due(undefined)).toBe(false);
    expect(due({ hidden: true })).toBe(false);
  });

  it("Add saves the person's changes, pins Hezuo and keeps it in the sidebar", () => {
    expect(welcomePatch(hezuo, { ...draftOf(hezuo), name: " Jarvis ", color: "blue", mascotBody: "blob" }, true))
      .toEqual({ name: "Jarvis", color: "blue", mascotBody: "blob", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Add with the panel never opened keeps the chrome-steel defaults", () => {
    expect(welcomePatch(hezuo, draftOf(hezuo), true)).toEqual({ welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("Not now turns Show Hezuo in the sidebar off, keeping what was changed, and nothing unchanged is sent", () => {
    expect(welcomePatch(hezuo, draftOf(hezuo), false)).toEqual({ welcomed: true, sidebarHidden: true });
    expect(welcomePatch(hezuo, { ...draftOf(hezuo), mascotBody: "star" }, false)).toEqual({ mascotBody: "star", welcomed: true, sidebarHidden: true });
  });

  it("saves an empty name as Hezuo and caps a long one at the bot-name limit", () => {
    const jarvis = { ...hezuo, name: "Jarvis" };
    expect(welcomePatch(jarvis, { ...draftOf(jarvis), name: "   " }, true).name).toBe("Hezuo");
    expect(welcomeName("x".repeat(300))).toHaveLength(100);
    expect(welcomeName("  Ada ")).toBe("Ada");
  });

  it("saves an uploaded picture as the bot's own edit screen would, and a colour picked after it goes back to the shape", () => {
    const uploaded = { ...draftOf(hezuo), avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" as const };
    expect(welcomePatch(hezuo, uploaded, true)).toEqual({ avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle", welcomed: true, sidebarHidden: false, pinned: true });
    expect(welcomePatch(hezuo, { ...uploaded, color: "blue", avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: "/api/attachments/abc.png", color: "blue", welcomed: true, sidebarHidden: false, pinned: true });
    const pictured = { ...hezuo, avatarUrl: "/api/attachments/abc.png", avatarCrop: "circle" } as Bot;
    expect(welcomePatch(pictured, { ...draftOf(pictured), avatarUrl: null, avatarCrop: "mascot" }, true))
      .toEqual({ avatarUrl: null, avatarCrop: "mascot", welcomed: true, sidebarHidden: false, pinned: true });
  });

  it("opens on Hezuo's picture alone: the customise panel stays closed until the picture is clicked", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(HezuoWelcomeCard, { bot: hezuo, onClose: () => {} })));
    expect(html).toContain(`aria-label="${t("hezuoWelcome.customize", { name: "Hezuo" })}"`);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-hezuo-welcome-panel="closed"');
    expect(html).toMatch(/data-hezuo-welcome-panel="closed"[^>]*|inert=""[^>]*data-hezuo-welcome-panel="closed"/);
    expect(html).toContain(t("hezuoWelcome.title", { name: "Hezuo" }));
    expect(html).toContain(t("hezuoWelcome.add", { name: "Hezuo" }));
  });
});
