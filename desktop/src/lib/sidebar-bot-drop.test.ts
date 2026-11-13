import { describe, expect, it } from "vitest";

import { botDropPlace, PINNED_LIST, planBotDrop, stepBot, stepKey, tileDropPlace, unusedName, type BotLists } from "./sidebar-bot-drop";

const lists: BotLists = new Map([
  ["", ["atlas", "bea", "cleo"]],
  ["Work", ["dodo", "echo"]],
  ["Empty", []],
]);

describe("where a dragged bot lands", () => {
  it("starts a department from the middle half of a row that is in none, and places it above or below otherwise", () => {
    expect([0, 13, 14, 27, 40, 41, 54].map((offset) => botDropPlace(offset, 54, true))).toEqual(["before", "before", "group", "group", "group", "after", "after"]);
    expect([0, 26, 27, 54].map((offset) => botDropPlace(offset, 54, false))).toEqual(["before", "before", "after", "after"]);
  });

  it("reorders within the list, in either direction, and a drop that changes nothing does nothing", () => {
    expect(planBotDrop(lists, "cleo", { kind: "row", botId: "atlas", place: "before" })).toEqual({ kind: "move", section: "", order: ["cleo", "atlas", "bea"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "bea", place: "after" })).toEqual({ kind: "move", section: "", order: ["bea", "atlas", "cleo"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "bea", place: "before" })).toBeNull();
    expect(planBotDrop(lists, "bea", { kind: "row", botId: "bea", place: "after" })).toBeNull();
    expect(planBotDrop(lists, "cleo", { kind: "end", list: "" })).toBeNull();
  });

  it("moves a bot into a department between its rows or at its end, and back out between the others", () => {
    expect(planBotDrop(lists, "bea", { kind: "row", botId: "echo", place: "before" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "bea", "echo"] });
    expect(planBotDrop(lists, "bea", { kind: "end", list: "Work" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "echo", "bea"] });
    expect(planBotDrop(lists, "bea", { kind: "end", list: "Empty" })).toEqual({ kind: "move", section: "Empty", order: ["bea"] });
    expect(planBotDrop(lists, "echo", { kind: "row", botId: "atlas", place: "after" })).toEqual({ kind: "move", section: "", order: ["atlas", "echo", "bea", "cleo"] });
    expect(planBotDrop(lists, "echo", { kind: "end", list: "" })).toEqual({ kind: "move", section: "", order: ["atlas", "bea", "cleo", "echo"] });
  });

  it("starts a department with the bot it was dropped on first, only from a row in no department", () => {
    expect(planBotDrop(lists, "cleo", { kind: "row", botId: "atlas", place: "group" })).toEqual({ kind: "group", botIds: ["atlas", "cleo"] });
    expect(planBotDrop(lists, "dodo", { kind: "row", botId: "bea", place: "group" })).toEqual({ kind: "group", botIds: ["bea", "dodo"] });
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "dodo", place: "group" })).toBeNull();
  });

  it("ignores a bot or a list the sidebar doesn't show as rows", () => {
    expect(planBotDrop(lists, "chief", { kind: "end", list: "Work" })).toBeNull();
    expect(planBotDrop(lists, "atlas", { kind: "row", botId: "chief", place: "before" })).toBeNull();
    expect(planBotDrop(lists, "atlas", { kind: "end", list: "Gone" })).toBeNull();
  });
});

describe("Alt+Up and Alt+Down", () => {
  it("move a bot one place within its own list and stop at either end", () => {
    expect(stepBot(lists, "bea", -1)).toEqual({ kind: "move", section: "", order: ["bea", "atlas", "cleo"] });
    expect(stepBot(lists, "bea", 1)).toEqual({ kind: "move", section: "", order: ["atlas", "cleo", "bea"] });
    expect(stepBot(lists, "dodo", 1)).toEqual({ kind: "move", section: "Work", order: ["echo", "dodo"] });
    expect(stepBot(lists, "atlas", -1)).toBeNull();
    expect(stepBot(lists, "echo", 1)).toBeNull();
    expect(stepBot(lists, "chief", 1)).toBeNull();
  });

  it("are the only keys that move it", () => {
    const key = (key: string, extra: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) =>
      stepKey({ key, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
    expect([key("ArrowUp"), key("ArrowDown"), key("ArrowLeft"), key("ArrowUp", { altKey: false }), key("ArrowDown", { shiftKey: true }), key("ArrowUp", { metaKey: true })])
      .toEqual([-1, 1, null, null, null, null]);
  });
});

describe("a new department's name", () => {
  it("is the plain name until a department has it, then the first free number", () => {
    expect(unusedName("New department", ["Work"])).toBe("New department");
    expect(unusedName("New department", ["New department", "New department 2", "New department 4"])).toBe("New department 3");
  });
});

describe("the pinned tiles as one more list", () => {
  const withPins: BotLists = new Map([
    ["", ["atlas", "bea", "cleo"]],
    ["Work", ["dodo", "echo"]],
    [PINNED_LIST, ["pia", "quin", "rex"]],
  ]);

  it("takes a bot from a department or from no department, before or after a tile, or at the end", () => {
    expect(planBotDrop(withPins, "dodo", { kind: "row", botId: "quin", place: "before" })).toEqual({ kind: "move", section: PINNED_LIST, order: ["pia", "dodo", "quin", "rex"] });
    expect(planBotDrop(withPins, "atlas", { kind: "row", botId: "rex", place: "after" })).toEqual({ kind: "move", section: PINNED_LIST, order: ["pia", "quin", "rex", "atlas"] });
    expect(planBotDrop(withPins, "bea", { kind: "end", list: PINNED_LIST })).toEqual({ kind: "move", section: PINNED_LIST, order: ["pia", "quin", "rex", "bea"] });
  });

  it("lets a tile go back into a department between its rows, at its end, or out to the bots in none", () => {
    expect(planBotDrop(withPins, "quin", { kind: "row", botId: "echo", place: "before" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "quin", "echo"] });
    expect(planBotDrop(withPins, "pia", { kind: "end", list: "Work" })).toEqual({ kind: "move", section: "Work", order: ["dodo", "echo", "pia"] });
    expect(planBotDrop(withPins, "rex", { kind: "row", botId: "atlas", place: "after" })).toEqual({ kind: "move", section: "", order: ["atlas", "rex", "bea", "cleo"] });
    expect(planBotDrop(withPins, "pia", { kind: "end", list: "" })).toEqual({ kind: "move", section: "", order: ["atlas", "bea", "cleo", "pia"] });
  });

  it("reorders the tiles among themselves, and a drop that changes nothing does nothing", () => {
    expect(planBotDrop(withPins, "rex", { kind: "row", botId: "pia", place: "before" })).toEqual({ kind: "move", section: PINNED_LIST, order: ["rex", "pia", "quin"] });
    expect(planBotDrop(withPins, "pia", { kind: "row", botId: "quin", place: "after" })).toEqual({ kind: "move", section: PINNED_LIST, order: ["quin", "pia", "rex"] });
    expect(planBotDrop(withPins, "pia", { kind: "row", botId: "quin", place: "before" })).toBeNull();
    expect(planBotDrop(withPins, "rex", { kind: "end", list: PINNED_LIST })).toBeNull();
  });

  it("starts a department from a tile dropped on the middle of a bot in none, and from a drop on a tile's middle", () => {
    expect(planBotDrop(withPins, "pia", { kind: "row", botId: "atlas", place: "group" })).toEqual({ kind: "group", botIds: ["atlas", "pia"] });
    expect(planBotDrop(withPins, "atlas", { kind: "row", botId: "pia", place: "group" })).toEqual({ kind: "group", botIds: ["pia", "atlas"] });
    expect(planBotDrop(withPins, "dodo", { kind: "row", botId: "quin", place: "group" })).toEqual({ kind: "group", botIds: ["quin", "dodo"] });
    expect(planBotDrop(withPins, "rex", { kind: "row", botId: "pia", place: "group" })).toEqual({ kind: "group", botIds: ["pia", "rex"] });
    expect(planBotDrop(withPins, "pia", { kind: "row", botId: "dodo", place: "group" })).toBeNull();
    expect(planBotDrop(withPins, "pia", { kind: "row", botId: "pia", place: "group" })).toBeNull();
  });

  it("steps a tile along the tiles with Alt+Arrow, and stops at either end", () => {
    expect(stepBot(withPins, "quin", -1)).toEqual({ kind: "move", section: PINNED_LIST, order: ["quin", "pia", "rex"] });
    expect(stepBot(withPins, "quin", 1)).toEqual({ kind: "move", section: PINNED_LIST, order: ["pia", "rex", "quin"] });
    expect(stepBot(withPins, "pia", -1)).toBeNull();
    expect(stepBot(withPins, "rex", 1)).toBeNull();
  });
});

describe("where a dragged bot lands on a pinned tile", () => {
  it("starts a department from the middle 40% of its width, and places before or after from either side", () => {
    expect([0, 20, 30, 31, 39, 50, 69, 70, 80, 100].map((offset) => tileDropPlace(offset, 100))).toEqual(["before", "before", "before", "group", "group", "group", "group", "after", "after", "after"]);
  });

  it("reads the sides the other way round in a right-to-left sidebar, the middle unchanged", () => {
    expect([10, 50, 90].map((offset) => tileDropPlace(offset, 100, true))).toEqual(["after", "group", "before"]);
  });

  it("calls an unmeasured tile a middle", () => {
    expect(tileDropPlace(0, 0)).toBe("group");
  });
});
