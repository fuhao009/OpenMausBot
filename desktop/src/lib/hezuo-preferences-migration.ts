const PREFERENCE_KEYS = [
  "callMode.v1", "lastBotSection.v1", "lastConversation.v1", "remote-voice.v1", "settings.section",
  "roomCard.hidden.v1", "sidebarDensity", "sidebarToolsLayout", "sidebarWidth", "sidebarWidth.simple",
  "sidebarAttentionPinned.v1", "sidebarCollapsedSections.v1", "sidebarSectionOrder.v1", "sidebarSectionOrder.simple.v1",
  "pinnedCircles", "universalPins", "pinnedCircleOrder.v1", "usageCard.dismissed.v1",
] as const;

/** Copy old preferences before any consumer initializes; an existing Hezuo choice always wins. */
export function migrateHezuoPreferences(): void {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = globalThis[name];
      if (!storage) continue;
      for (const suffix of PREFERENCE_KEYS) {
        const oldKey = `openmausbot.${suffix}`;
        const key = `hezuo.${suffix}`;
        const previous = storage.getItem(oldKey);
        if (previous === null) continue;
        if (storage.getItem(key) === null) storage.setItem(key, previous);
        storage.removeItem(oldKey);
      }
      if (name === "sessionStorage" && storage.getItem("omb.launch.dialog") === "mausbot") {
        storage.setItem("omb.launch.dialog", "hezuo");
      }
    } catch {
      // Blocked or full storage must not prevent the page from opening; leave old data for a later attempt.
    }
  }
}

migrateHezuoPreferences();
