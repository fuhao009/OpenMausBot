import { greetingName } from "../../packages/shared/greeting-name.ts";
import { serverLine } from "./server-lines.ts";

const SETUP_CHOICE_KEYS = [
  "server.setup.choice.research", "server.setup.choice.monitor", "server.setup.choice.messages",
  "server.setup.choice.errands", "server.setup.choice.data",
] as const;

export function setupChoices(language?: string): string[] {
  return SETUP_CHOICE_KEYS.map((key) => serverLine(language, key));
}

export function hasSetupChoices(language?: string): boolean {
  return /^(en|es|pt|ko|zh)(?:-|$)/i.test(language?.trim() || "en");
}

export function initialGreeting(name: string, language?: string, person?: string): string {
  const firstName = greetingName(person);
  return serverLine(language, firstName ? "server.greeting.named" : "server.greeting.hello", { name, person: firstName || "" });
}

export function setupRequestLine(language?: string): string {
  return serverLine(language, "server.setup.request");
}

/** The seeded message; a function language is read now, so a language changed in Settings reaches the next new bot.
 * `offerSetup`: the bot has no role or instructions yet, so its greeting carries the setup card and its answers. */
export function initialGreetingMessage(name: string, language: string | (() => string), offerSetup = false, person?: string) {
  const spoken = typeof language === "function" ? language() : language;
  const text = initialGreeting(name, spoken, person);
  return { role: "bot", kind: "text", text, ...(offerSetup ? { setupOffer: true as const, setupChoices: setupChoices(spoken) } : {}) } as const;
}
