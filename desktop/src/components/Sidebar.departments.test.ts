import { Children, isValidElement, type EffectCallback, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Action, AppState, Bot, Group } from "@/state/store";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, advanced: false, phone: false, admin: null as boolean | null,
  state: {} as AppState, dispatch: vi.fn(), storage: new Map<string, string>(),
  requests: [] as Array<{ path: string; method: string; body: unknown }>,
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [fixture.values[index], (next: unknown) => {
      fixture.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(fixture.values[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = { current: initial };
    return fixture.values[index];
  },
  useCallback: (callback: unknown) => callback,
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
  useEffect: (_effect: EffectCallback) => {},
  useLayoutEffect: () => {},
}));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("./MenuMotion", () => ({
  useMenuMotion: (open: boolean) => ({ shown: open, closing: false, className: "", exitProps: {} }),
  useHeldMenuMotion: (value: unknown) => ({ shown: value !== null, value, closing: false, className: "", exitProps: {} }),
}));
vi.mock("./DesktopCapabilities", async () => {
  const { initialDesktopCapabilities } = await import("@/lib/desktop");
  return { useDesktopCapabilities: () => ({ capabilities: initialDesktopCapabilities() }), windowFramed: () => false };
});
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.advanced }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => fixture.advanced, setAdvancedMode: () => {} }));
vi.mock("@/lib/use-owner-or-admin", () => ({ useOwnerOrAdmin: () => fixture.admin }));
vi.mock("@/lib/default-bot", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/default-bot")>(), useViewerEmail: () => null }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }) };
});

import { initialState } from "@/state/store";
import { BOTS_SECTION_ID, CHANNELS_SECTION_ID, userSectionId } from "@/lib/sidebar-layout";
import { PINNED_CIRCLE_ORDER_KEY } from "@/lib/sidebar-preferences";
import { PHONE_LAYOUT } from "@/lib/use-media-query";
import { BotContextMenu, BotListItem, Sidebar, TeamMenuItems } from "./Sidebar";
import { NEW_DEPARTMENT } from "./SidebarBotDrag";
import { SidebarTileGrid } from "./SidebarTiles";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { GlassScroller } from "./GlassScrollFrame";
import { ConfirmDialog } from "./ConfirmDialog";
import { TeamDialog } from "./TeamDialog";

const bot = (id: string, extra: Partial<Bot> = {}): Bot => ({
  id, threadId: `${id}-thread`, name: id, title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const room: Group = {
  id: "room", threadId: "room-thread", name: "Launch room", memberIds: ["atlas"], messages: [],
  defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1,
};

type Props = { children?: ReactNode; [key: string]: unknown };
type RowProps = Parameters<typeof BotListItem>[0];
type HeaderProps = Parameters<typeof SidebarSectionHeader>[0];
function nodes(value: ReactNode): ReactElement<Props>[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement<Props>(child)) return [];
    return [child, ...nodes(child.props.children)];
  });
}
function render() {
  fixture.index = 0;
  const root = Sidebar({ open: false, onClose: () => {} }) as ReactElement<Props>;
  return [root, ...nodes(root.props.children)];
}
const rows = () => render().filter((node) => node.type === BotListItem).map((node) => node.props as unknown as RowProps);
const row = (id: string) => rows().find((props) => props.bot.id === id)!;
const tiles = () => {
  const found = render().find((node) => node.type === SidebarTileGrid);
  if (!found) return [] as RowProps[];
  const { pinned, row: rowFor } = found.props as unknown as Parameters<typeof SidebarTileGrid>[0];
  return pinned.map(rowFor);
};
const listed = () => rows().map((props) => props.bot.id);
const sections = () => render().map((node) => node.props["data-sidebar-section-id"]).filter(Boolean);
const section = (id: string) => render().find((node) => node.props["data-sidebar-section-id"] === id)!.props as unknown as {
  onDragOver: (event: unknown) => void; onDrop: (event: unknown) => void; children: ReactNode;
};
const sectionHas = (id: string) => nodes(section(id).children).some((node) => node.props["data-bot-empty-drop"] !== undefined);
const headers = () => render().filter((node) => node.type === SidebarSectionHeader).map((node) => node.props as unknown as HeaderProps);
const header = (name: string) => headers().find((props) => props.name === name)!;
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action as Action);

function transfer() {
  const data = new Map<string, string>();
  return { types: [] as string[], effectAllowed: "", dropEffect: "", setData(type: string, value: string) { data.set(type, value); this.types.push(type); }, getData: (type: string) => data.get(type) ?? "" };
}
let carried = transfer();
/** The bot rows a section's drop zone finds under it, each 54px tall from `top`. */
let rowElements: Array<{ dataset: { sidebarBotRow: string }; getBoundingClientRect: () => { top: number; bottom: number; height: number } }> = [];
const laidOut = (...ids: string[]) => {
  rowElements = ids.map((id, index) => ({ dataset: { sidebarBotRow: id }, getBoundingClientRect: () => ({ top: 30 + index * 56, bottom: 84 + index * 56, height: 54 }) }));
};
/** A drag event `offset` pixels into a 54px row. */
const at = (offset = 27) => ({
  dataTransfer: carried, clientY: offset, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 54 }), querySelectorAll: () => rowElements },
  preventDefault: vi.fn(), stopPropagation: vi.fn(),
});
function drag(id: string) {
  carried = transfer();
  const props = rows().find((candidate) => candidate.bot.id === id) ?? tiles().find((candidate) => candidate.bot.id === id)!;
  props.botDrag!.row(id).onDragStart(at() as never);
  vi.runOnlyPendingTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  fixture.values = [];
  fixture.advanced = false;
  fixture.phone = false;
  fixture.admin = null;
  fixture.storage = new Map();
  fixture.requests = [];
  rowElements = [];
  fixture.dispatch.mockClear();
  fixture.state = {
    ...initialState,
    bots: [bot("atlas"), bot("bea"), bot("cleo"), bot("dodo", { section: "Work" }), bot("echo", { section: "Work" })],
    groups: [room],
    sections: ["Work"],
  };
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    innerWidth: 1280, innerHeight: 800, ogb: undefined, setTimeout, clearTimeout,
    matchMedia: (query: string) => ({ matches: fixture.phone && query === PHONE_LAYOUT, addEventListener() {}, removeEventListener() {} }),
  }));
  vi.stubGlobal("document", { body: {}, querySelector: () => null });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    fixture.requests.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ sections: ["Clients"], botIds: [] }), { status: 200 });
  });
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => fixture.storage.get(key) ?? null,
    setItem: (key: string, value: string) => { fixture.storage.set(key, value); },
    removeItem: (key: string) => { fixture.storage.delete(key); },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Simple's sidebar before anyone drags", () => {
  it("looks as it did: the same sections and rows, nothing marked, each row ready to drag", () => {
    expect(sections()).toEqual([CHANNELS_SECTION_ID, userSectionId("Work"), BOTS_SECTION_ID]);
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
    for (const props of rows()) {
      expect(props.botDrop).toBeNull();
      expect(props.botDragging).toBe(false);
      expect(props.botDrag!.row(props.bot.id).draggable).toBe(true);
    }
    expect(headers().every((props) => !props.dropInto && !props.naming)).toBe(true);
  });

  it("leaves rows still on a phone, where the menu moves them", () => {
    fixture.phone = true;
    expect(rows().every((props) => props.botDrag === undefined)).toBe(true);
  });
});

describe("dragging a bot", () => {
  it("shows a line where it lands and saves the new order", () => {
    drag("cleo");
    expect(row("cleo").botDragging).toBe(true);
    row("atlas").botDrag!.row("atlas").onDragOver(at(5) as never);
    expect(row("atlas").botDrop).toBe("before");
    row("atlas").botDrag!.row("atlas").onDrop(at(5) as never);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["cleo", "atlas", "bea"] }]);
    expect(fixture.requests).toEqual([{ path: "/api/bots/order", method: "PUT", body: { botIds: ["cleo", "atlas", "bea"] } }]);
    expect(rows().every((props) => !props.botDrop && !props.botDragging)).toBe(true);
  });

  it("onto the middle of a bot makes a department of both at once, called Untitled group, with no name field", () => {
    drag("cleo");
    row("atlas").botDrag!.row("atlas").onDragOver(at() as never);
    expect(row("atlas").botDrop).toBe("group");
    row("atlas").botDrag!.row("atlas").onDrop(at() as never);
    expect(actions()).toEqual([
      { type: "updateBot", botId: "atlas", patch: { section: "Untitled group" } },
      { type: "updateBot", botId: "cleo", patch: { section: "Untitled group" } },
    ]);
    expect(sections()).not.toContain(userSectionId(NEW_DEPARTMENT));
    expect(headers().some((props) => props.naming)).toBe(false);
  });

  it("keeps the bot dropped on above the one dropped, saving that order when it is not already so", () => {
    drag("atlas");
    row("cleo").botDrag!.row("cleo").onDrop(at() as never);
    expect(actions()).toEqual([
      { type: "updateBot", botId: "cleo", patch: { section: "Untitled group" } },
      { type: "updateBot", botId: "atlas", patch: { section: "Untitled group" } },
      { type: "botsOrdered", botIds: ["cleo", "atlas"] },
    ]);
  });

  it("gives the department the first free name", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Untitled group"] };
    drag("cleo");
    row("bea").botDrag!.row("bea").onDrop(at() as never);
    expect(actions()[0]).toEqual({ type: "updateBot", botId: "bea", patch: { section: "Untitled group 2" } });
  });

  it("keeps the naming field for a department started from a bot's menu", () => {
    const menuElement = () => render().find((node) => node.type === BotContextMenu)!;
    row("atlas").onMenu({ botId: "atlas", x: 0, y: 0 });
    (menuElement().props.onNewSection as (botId: string) => void)("atlas");
    const naming = header(NEW_DEPARTMENT).naming!;
    expect([naming.value, naming.label]).toEqual(["New department", "New department name"]);
    expect(actions()).toEqual([]);
    naming.onCommit("  ");
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "New department" } }]);
  });

  it("into a department over its heading, or between its rows", () => {
    drag("atlas");
    section(userSectionId("Work")).onDragOver(at() as never);
    expect(header("Work").dropInto).toBe(true);
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] }]);
    fixture.dispatch.mockClear();
    drag("bea");
    row("echo").botDrag!.row("echo").onDragOver(at(26) as never);
    expect(row("echo").botDrop).toBe("before");
    row("echo").botDrag!.row("echo").onDrop(at(26) as never);
    expect(actions()).toEqual([
      { type: "updateBot", botId: "bea", patch: { section: "Work" } },
      { type: "botsOrdered", botIds: ["dodo", "bea", "echo"] },
    ]);
  });

  it("between rows or under the last one, by the nearest row; over a department's heading, into it", () => {
    drag("atlas");
    laidOut("dodo", "echo");
    section(userSectionId("Work")).onDragOver(at(10) as never);
    expect(header("Work").dropInto).toBe(true);
    section(userSectionId("Work")).onDragOver(at(85) as never);
    expect([header("Work").dropInto, row("echo").botDrop]).toEqual([false, "before"]);
    section(userSectionId("Work")).onDragOver(at(400) as never);
    expect(row("echo").botDrop).toBe("after");
    section(userSectionId("Work")).onDrop(at(85) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "atlas", "echo"] }]);
    fixture.dispatch.mockClear();
    drag("cleo");
    laidOut("atlas", "bea", "cleo");
    section(BOTS_SECTION_ID).onDragOver(at(85) as never);
    expect(row("bea").botDrop).toBe("before");
    section(BOTS_SECTION_ID).onDragOver(at(170) as never);
    expect(rows().some((props) => props.botDrop)).toBe(false);
  });

  it("out of a department to the end of the main list, or a place in it", () => {
    drag("echo");
    section(BOTS_SECTION_ID).onDragOver(at() as never);
    expect(row("cleo").botDrop).toBeNull();
    section(BOTS_SECTION_ID).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "echo", patch: { section: "" } }]);
    expect(fixture.requests).toEqual([]);
    fixture.dispatch.mockClear();
    drag("dodo");
    row("bea").botDrag!.row("bea").onDrop(at(50) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "dodo", patch: { section: "" } }, { type: "botsOrdered", botIds: ["atlas", "bea", "dodo", "cleo"] }]);
  });

  const slotNode = () => render().find((node) => node.props["data-bot-drop-slot"] !== undefined);
  const sectionNodes = () => render().filter((node) => node.props["data-sidebar-section-id"] !== undefined);
  const inSection = (target: ReactElement<Props>) => sectionNodes().some((node) => nodes(node.props.children).includes(target));

  it("offers a place to drop it out outside every section, so no row moves, and takes the drop there", () => {
    drag("echo");
    expect(slotNode()).toBeDefined();
    expect(inSection(slotNode()!)).toBe(false);
    expect(sections()).toEqual([CHANNELS_SECTION_ID, userSectionId("Work"), BOTS_SECTION_ID]);
    const over = at();
    (slotNode()!.props.onDragOver as (event: unknown) => void)(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.stopPropagation).toHaveBeenCalled();
    expect(carried.dropEffect).toBe("move");
    expect(String(slotNode()!.props.className)).toContain("border-accent");
    expect(rows().some((props) => props.botDrop)).toBe(false);
    (slotNode()!.props.onDrop as (event: unknown) => void)(at());
    expect(actions()).toEqual([{ type: "updateBot", botId: "echo", patch: { section: "" } }]);
  });

  it("offers no such place for a bot already outside departments", () => {
    drag("atlas");
    expect(slotNode()).toBeUndefined();
  });

  it("adds no bots section just for the place to drop it out, when every row is in a department", () => {
    fixture.state = { ...fixture.state, bots: fixture.state.bots.map((candidate) => ({ ...candidate, section: "Work" })) };
    expect(sections()).not.toContain(BOTS_SECTION_ID);
    drag("dodo");
    expect(sections()).not.toContain(BOTS_SECTION_ID);
    expect(slotNode()).toBeDefined();
    expect(inSection(slotNode()!)).toBe(false);
    (slotNode()!.props.onDrop as (event: unknown) => void)(at());
    expect(actions()).toEqual([{ type: "updateBot", botId: "dodo", patch: { section: "" } }]);
  });

  it("never drops on group chats, and hands a heading's drag to the section order", () => {
    drag("atlas");
    const event = at();
    section(CHANNELS_SECTION_ID).onDragOver(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    section(CHANNELS_SECTION_ID).onDrop(event as never);
    expect(actions()).toEqual([]);
    expect(rows().every((props) => !props.botDragging)).toBe(true);
  });

  it("moves with Alt+Up/Down within its list and says where it went", () => {
    row("bea").botDrag!.step("bea", 1);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["atlas", "cleo", "bea"] }]);
    const live = render().find((node) => node.props["aria-live"] === "polite")!;
    expect(live.props.children).toBe("bea moved to position 3 of 3");
    fixture.dispatch.mockClear();
    row("atlas").botDrag!.step("atlas", -1);
    expect(actions()).toEqual([]);
  });

  it("works the same in Advanced, where the bots' list has a heading", () => {
    fixture.advanced = true;
    drag("dodo");
    row("atlas").botDrag!.row("atlas").onDrop(at() as never);
    expect(actions()[0]).toEqual({ type: "updateBot", botId: "atlas", patch: { section: "Untitled group" } });
  });
});

describe("dragging between the pinned tiles and the departments", () => {
  beforeEach(() => {
    fixture.state = {
      ...fixture.state,
      bots: [bot("hezuo", { defaultBot: {}, chiefOfStaff: true, pinned: true }), bot("pia", { pinned: true }), bot("quin", { pinned: true }), bot("atlas"), bot("bea"), bot("dodo", { section: "Work" }), bot("echo", { section: "Work" })],
      groups: [],
    };
  });
  const gridNode = () => render().find((node) => node.type === SidebarTileGrid);
  const grid = () => gridNode()!.props as unknown as Parameters<typeof SidebarTileGrid>[0];
  const tile = (id: string) => grid().row(grid().pinned.find((candidate) => candidate.id === id)!);
  const tileEvent = (side: "left" | "middle" | "right") => ({
    dataTransfer: carried, clientX: side === "left" ? 5 : side === "middle" ? 39 : 72, clientY: 40,
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 78, height: 92 }) },
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
  });
  const gridEvent = () => ({ dataTransfer: carried, preventDefault: vi.fn(), stopPropagation: vi.fn(), relatedTarget: null, currentTarget: { contains: () => false } });
  const order = (...botIds: string[]) => ({ path: "/api/bots/order", method: "PUT", body: { botIds } });

  it("draws exactly the pinned bots as tiles, the default bot among them, and every one draggable", () => {
    expect(grid().pinned.map((candidate) => candidate.id)).toEqual(["hezuo", "pia", "quin"]);
    expect(grid().pinned.every((candidate) => grid().row(candidate).botDrag !== undefined)).toBe(true);
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea"]);
  });

  it("moves a bot out of its department when dropped on the pinned grid", () => {
    drag("dodo");
    const over = gridEvent();
    grid().drop!.handlers.onDragOver!(over as never);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(grid().drop!.over).toBe(true);
    grid().drop!.handlers.onDrop!(gridEvent() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "dodo", patch: { pinned: true, section: "" } }]);
    expect(fixture.storage.get(PINNED_CIRCLE_ORDER_KEY)).toBeUndefined();
    expect(grid().drop!.over).toBe(false);
  });

  it("pins a bot dropped before a tile, in that place among the tiles", () => {
    drag("atlas");
    tile("quin").botDrag!.row("quin").onDragOver(tileEvent("left") as never);
    expect(tile("quin").botDrop).toBe("before");
    tile("quin").botDrag!.row("quin").onDrop(tileEvent("left") as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { pinned: true, section: "" } }, { type: "botsOrdered", botIds: ["hezuo", "pia", "atlas", "quin"] }]);
  });

  it("reorders the tiles on the server, not on this device, by the side of the tile dropped on", () => {
    drag("quin");
    tile("pia").botDrag!.row("pia").onDragOver(tileEvent("left") as never);
    tile("pia").botDrag!.row("pia").onDrop(tileEvent("left") as never);
    expect(actions()).toEqual([{ type: "botsOrdered", botIds: ["hezuo", "quin", "pia"] }]);
    expect(fixture.requests).toEqual([order("hezuo", "quin", "pia")]);
    expect(fixture.storage.get(PINNED_CIRCLE_ORDER_KEY)).toBeUndefined();
  });

  it("lets the default bot's tile be dragged into a department, or out to the bots in none", () => {
    drag("hezuo");
    laidOut("dodo", "echo");
    section(userSectionId("Work")).onDragOver(at(10) as never);
    expect(header("Work").dropInto).toBe(true);
    section(userSectionId("Work")).onDrop(at(10) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "hezuo", patch: { pinned: false, section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "hezuo"] }]);
    fixture.dispatch.mockClear();
    drag("hezuo");
    row("bea").botDrag!.row("bea").onDrop(at(50) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "hezuo", patch: { pinned: false, section: "" } }, { type: "botsOrdered", botIds: ["atlas", "bea", "hezuo"] }]);
  });

  it("unpins a tile dropped on a department's heading, into that department, in one patch", () => {
    drag("pia");
    laidOut("dodo", "echo");
    section(userSectionId("Work")).onDragOver(at(10) as never);
    section(userSectionId("Work")).onDrop(at(10) as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "pia", patch: { pinned: false, section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "pia"] }]);
  });

  it("starts a department at once with a tile dropped on the middle of a bot in none, unpinning the tile", () => {
    drag("pia");
    row("atlas").botDrag!.row("atlas").onDrop(at(27) as never);
    expect(actions().slice(0, 3)).toEqual([
      { type: "updateBot", botId: "pia", patch: { pinned: false } },
      { type: "updateBot", botId: "atlas", patch: { section: "Untitled group" } },
      { type: "updateBot", botId: "pia", patch: { section: "Untitled group" } },
    ]);
  });

  it("starts a department from the middle of a tile, unpinning both, the tile dropped on first", () => {
    drag("atlas");
    tile("pia").botDrag!.row("pia").onDragOver(tileEvent("middle") as never);
    expect(tile("pia").botDrop).toBe("group");
    tile("pia").botDrag!.row("pia").onDrop(tileEvent("middle") as never);
    expect(actions().slice(0, 3)).toEqual([
      { type: "updateBot", botId: "pia", patch: { pinned: false } },
      { type: "updateBot", botId: "pia", patch: { section: "Untitled group" } },
      { type: "updateBot", botId: "atlas", patch: { section: "Untitled group" } },
    ]);
  });

  it("lets one tile be dropped on the middle of another to group them, the default bot as any other", () => {
    drag("hezuo");
    tile("quin").botDrag!.row("quin").onDrop(tileEvent("middle") as never);
    expect(actions().slice(0, 2)).toEqual([
      { type: "updateBot", botId: "quin", patch: { pinned: false } },
      { type: "updateBot", botId: "hezuo", patch: { pinned: false } },
    ]);
    expect(actions()).toContainEqual({ type: "updateBot", botId: "hezuo", patch: { section: "Untitled group" } });
  });

  it("a bot dropped on one in a department joins that department, never grouping", () => {
    drag("atlas");
    row("dodo").botDrag!.row("dodo").onDragOver(at(10) as never);
    expect(row("dodo").botDrop).toBe("before");
    row("dodo").botDrag!.row("dodo").onDragOver(at(44) as never);
    expect(row("dodo").botDrop).toBe("after");
    row("dodo").botDrag!.row("dodo").onDragOver(at(27) as never);
    expect(row("dodo").botDrop).not.toBe("group");
  });

  it("offers the place to drop a tile out of the tiles", () => {
    drag("pia");
    expect(render().find((node) => node.props["data-bot-drop-slot"] !== undefined)).toBeDefined();
  });

  describe("with nothing pinned", () => {
    beforeEach(() => {
      fixture.state = { ...fixture.state, bots: fixture.state.bots.map((candidate) => ({ ...candidate, pinned: undefined })) };
    });

    it("draws no tile area until a bot is dragged, then only a slim place to drop it, which pins it", () => {
      expect(gridNode()).toBeUndefined();
      drag("atlas");
      expect(grid().pinned).toEqual([]);
      const over = gridEvent();
      grid().drop!.handlers.onDragOver!(over as never);
      expect(over.preventDefault).toHaveBeenCalled();
      expect(grid().drop!.over).toBe(true);
      grid().drop!.handlers.onDrop!(gridEvent() as never);
      expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { pinned: true, section: "" } }]);
    });

    it("keeps the bots in their lists, with the default bot among the ungrouped", () => {
      expect(listed()).toEqual(["dodo", "echo", "hezuo", "pia", "quin", "atlas", "bea"]);
    });
  });
});

describe("departments, in the workspace's order", () => {
  beforeEach(() => {
    fixture.state = { ...fixture.state, bots: [bot("atlas"), bot("dodo", { section: "Work" }), bot("fay", { section: "Home" })], sections: ["Work", "Home"], groups: [] };
  });

  it("shows them as the workspace lists them, between the group chats and the bots in none", () => {
    expect(sections()).toEqual([userSectionId("Work"), userSectionId("Home"), BOTS_SECTION_ID]);
    fixture.state = { ...fixture.state, sections: ["Home", "Work"] };
    expect(sections()).toEqual([userSectionId("Home"), userSectionId("Work"), BOTS_SECTION_ID]);
  });

  it("saves a department moved by its heading on the server, for every client, and nowhere on this device", () => {
    expect(header("Home").reorderable).toBe(true);
    expect(header("Ungrouped").reorderable).toBe(false);
    header("Home").onMove!(-1);
    expect(actions()).toEqual([{ type: "sections", sections: ["Home", "Work"] }]);
    expect(fixture.requests).toEqual([{ path: "/api/sidebar-sections/order", method: "PUT", body: { sections: ["Home", "Work"] } }]);
    expect(fixture.storage.size).toBe(0);
  });

  it("moves a department by dropping its heading on another, saving that order on the server", () => {
    carried = transfer();
    const start = { dataTransfer: carried, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    header("Work").onDragStart!(start as never);
    expect(carried.types).toContain("application/x-hezuo-sidebar-section");
    const over = { dataTransfer: carried, clientY: 90, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) } };
    section(userSectionId("Home")).onDragOver(over as never);
    section(userSectionId("Home")).onDrop(over as never);
    expect(actions()).toContainEqual({ type: "sections", sections: ["Home", "Work"] });
    expect(fixture.requests).toEqual([{ path: "/api/sidebar-sections/order", method: "PUT", body: { sections: ["Home", "Work"] } }]);
  });
});

describe("dropping between the sections or below the last one", () => {
  type Box = { top: number; bottom: number; height: number };
  const box = (top: number, bottom: number): Box => ({ top, bottom, height: bottom - top });
  const rowAt = (id: string, top: number) => ({ dataset: { sidebarBotRow: id }, getBoundingClientRect: () => box(top, top + 50) });
  const zone = (id: string, top: number, bottom: number, rows: ReturnType<typeof rowAt>[] = []) => ({
    dataset: { sidebarSectionId: id }, getBoundingClientRect: () => box(top, bottom), querySelectorAll: () => rows,
  });
  const list = () => render().find((node) => node.type === GlassScroller)!.props as unknown as {
    onDragOver: (event: unknown) => void; onDrop: (event: unknown) => void;
  };
  const gapAt = (y: number, zones: ReturnType<typeof zone>[], extra: object = {}) => ({
    dataTransfer: carried, clientY: y, target: {}, defaultPrevented: false,
    currentTarget: { querySelectorAll: () => zones }, preventDefault: vi.fn(), ...extra,
  });

  it("puts the bot in the nearer department, whichever side of the gap it is released on", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Empty"] };
    const zones = [zone(userSectionId("Work"), 100, 200, [rowAt("dodo", 150), rowAt("echo", 100)]), zone(userSectionId("Empty"), 204, 244)];
    drag("atlas");
    const over = gapAt(206, zones);
    list().onDragOver(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(carried.dropEffect).toBe("move");
    expect(header("Empty").dropInto).toBe(true);
    list().onDrop(gapAt(206, zones));
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Empty" } }]);
    fixture.dispatch.mockClear();
    drag("atlas");
    list().onDrop(gapAt(202, zones));
    expect(actions()).toEqual([
      { type: "updateBot", botId: "atlas", patch: { section: "Work" } },
      { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] },
    ]);
  });

  it("puts it at the end of the last department when released below it", () => {
    const zones = [zone(userSectionId("Work"), 100, 200, [rowAt("dodo", 100), rowAt("echo", 150)])];
    drag("atlas");
    list().onDragOver(gapAt(600, zones));
    expect(row("echo").botDrop).toBe("after");
    list().onDrop(gapAt(600, zones));
    expect(actions()).toEqual([
      { type: "updateBot", botId: "atlas", patch: { section: "Work" } },
      { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] },
    ]);
  });

  it("leaves a drag a zone or row already took, one begun inside a section, and a drag that is not a bot", () => {
    const zones = [zone(userSectionId("Work"), 100, 200, [rowAt("dodo", 100), rowAt("echo", 150)])];
    drag("atlas");
    const taken = gapAt(600, zones, { defaultPrevented: true });
    list().onDragOver(taken);
    list().onDrop(gapAt(600, zones, { defaultPrevented: true }));
    expect(taken.preventDefault).not.toHaveBeenCalled();
    expect(actions()).toEqual([]);
    const inside = gapAt(150, zones, { target: { closest: () => ({}) } });
    list().onDrop(inside);
    expect(inside.preventDefault).not.toHaveBeenCalled();
    expect(actions()).toEqual([]);
    carried = { ...transfer(), types: ["Files"] };
    const files = gapAt(600, zones);
    list().onDragOver(files);
    expect(files.preventDefault).not.toHaveBeenCalled();
  });
});

describe("an empty department", () => {
  const placeholders = () => render().filter((node) => node.props["data-bot-empty-drop"] !== undefined);

  beforeEach(() => {
    fixture.state = { ...fixture.state, sections: ["Work", "Empty"], config: { ...initialState.config, productManaged: true } as AppState["config"] };
  });

  it("shows a place to drag a bot to in the product, and none in a department that has bots", () => {
    expect(placeholders()).toHaveLength(1);
    expect(sectionHas(userSectionId("Empty"))).toBe(true);
    expect(sectionHas(userSectionId("Work"))).toBe(false);
  });

  it("takes a bot dropped on it, and shows it as the target meanwhile", () => {
    drag("atlas");
    section(userSectionId("Empty")).onDragOver(at() as never);
    expect(String(placeholders()[0]!.props.className)).toContain("border-accent");
    section(userSectionId("Empty")).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Empty" } }]);
  });

  it("is not there where the add-bots button already is", () => {
    fixture.state = { ...fixture.state, config: { ...initialState.config, productManaged: false } as AppState["config"] };
    expect(placeholders()).toHaveLength(0);
  });
});

describe("who may drag a bot: whoever the bot menu offers Move to department", () => {
  it("gives a Team Cloud member without the admin scope no row to drag and no Alt+Up/Down, and starts no drag", () => {
    const drawnEarlier = row("atlas").botDrag!;
    fixture.admin = false;
    expect(listed()).toEqual(["dodo", "echo", "atlas", "bea", "cleo"]);
    expect(rows().map((props) => props.botDrag)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    carried = transfer();
    drawnEarlier.row("atlas").onDragStart(at() as never);
    drawnEarlier.step("atlas", 1);
    expect(carried.types).toEqual([]);
    expect(actions()).toEqual([]);
  });

  it("drops nothing from a drag begun before the session said they are a member", () => {
    drag("atlas");
    fixture.admin = false;
    section(userSectionId("Work")).onDragOver(at() as never);
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });

  it("lets an admin drag", () => {
    fixture.admin = true;
    for (const props of rows()) expect(props.botDrag!.row(props.bot.id).draggable).toBe(true);
    drag("atlas");
    section(userSectionId("Work")).onDrop(at() as never);
    expect(actions()).toEqual([{ type: "updateBot", botId: "atlas", patch: { section: "Work" } }, { type: "botsOrdered", botIds: ["dodo", "echo", "atlas"] }]);
  });
});

describe("a department's menu in Simple", () => {
  const openMenu = (name: string) => {
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    header(name).onMenu!(button);
    return render().find((node) => node.type === TeamMenuItems)!.props as unknown as Parameters<typeof TeamMenuItems>[0];
  };

  it("renames it in place", async () => {
    openMenu("Work").onRename();
    expect(render().some((node) => node.type === TeamDialog)).toBe(false);
    const naming = header("Work").naming!;
    expect([naming.value, naming.label]).toEqual(["Work", "Rename Work department"]);
    naming.onCommit("Clients");
    await vi.waitFor(() => expect(actions()).toEqual([{ type: "sections", sections: ["Clients"] }]));
    expect(fixture.requests).toEqual([{ path: "/api/sidebar-sections?section=Work", method: "PATCH", body: { name: "Clients" } }]);
  });

  it("deletes it saying the bots stay, out of any department", () => {
    openMenu("Work").onDelete();
    const dialog = render().find((node) => node.type === ConfirmDialog && node.props.open === true)!;
    expect(dialog.props.body).toBe("Its bots and group chats stay, with their conversations, outside any department. The department and its shared instructions are deleted. This cannot be undone.");
  });

  it("keeps Advanced's rename dialog", () => {
    fixture.advanced = true;
    const button = { getBoundingClientRect: () => ({ right: 280, bottom: 300 }), focus: vi.fn(), isConnected: true } as unknown as HTMLButtonElement;
    const work = render().find((node) => node.type === SidebarSectionHeader && (node.props as unknown as HeaderProps).name === "Work")!.props as unknown as HeaderProps;
    work.onContextMenu!({ preventDefault: () => {}, clientX: 10, clientY: 10, currentTarget: { querySelector: () => button } } as never);
    (render().find((node) => node.type === TeamMenuItems)!.props as unknown as Parameters<typeof TeamMenuItems>[0]).onRename();
    expect(render().some((node) => node.type === TeamDialog)).toBe(true);
    expect(header("Work").naming).toBeUndefined();
  });
});

describe("a bot's menu in Simple", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const menuProps = (botId: string, extra: Partial<MenuProps> = {}): MenuProps => ({
    menu: { botId, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(),
    onNewFolder: vi.fn(), onNewTaskFolder: vi.fn(), onNewSection: vi.fn(), ...extra,
  });
  const open = (props: MenuProps) => {
    fixture.index = 0;
    const tree = nodes(BotContextMenu(props));
    const move = tree.find((node) => node.props["data-bot-menu-move"] !== undefined)!;
    (move.props.onClick as (event: { detail: number }) => void)({ detail: 1 });
    fixture.index = 0;
    const flyout = nodes(BotContextMenu(props)).find((node) => node.props["data-bot-menu-flyout"] === "move")!;
    return nodes(flyout.props.children).filter((node) => node.props.role === "menuitem");
  };
  const label = (node: ReactElement<Props>) => nodes(node.props.children).length
    ? Children.toArray(node.props.children).filter((part) => typeof part === "string").join("") : String(node.props.children);

  it("moves it to a department, a new one or out of one, from Move to department", () => {
    fixture.state = { ...fixture.state, sections: ["Work", "Home"] };
    const props = menuProps("dodo");
    const items = open(props);
    expect(items.map(label)).toEqual(["Work", "Home", "New department…", "Remove from department"]);
    expect(items[0]!.props.disabled).toBe(true);
    (items[1]!.props.onClick as () => void)();
    (items[3]!.props.onClick as () => void)();
    expect(actions()).toEqual([
      { type: "updateBot", botId: "dodo", patch: { section: "Home" } },
      { type: "updateBot", botId: "dodo", patch: { section: "" } },
    ]);
    (items[2]!.props.onClick as () => void)();
    expect(props.onNewSection).toHaveBeenCalledWith("dodo");
  });

  it("offers only New department… to a bot in none, when there are no departments yet", () => {
    fixture.state = { ...fixture.state, sections: [], bots: [bot("atlas"), bot("bea")] };
    expect(open(menuProps("atlas")).map(label)).toEqual(["New department…"]);
  });
});

describe("deleting a Chief of Staff", () => {
  type MenuProps = Parameters<typeof BotContextMenu>[0];
  const askToDelete = (target: Bot) => (render().find((node) => node.type === BotContextMenu)!.props as unknown as MenuProps).onDelete(target);
  const openDialog = () => render().find((node) => node.type === ConfirmDialog && node.props.open === true);

  it("offers Archive first, which keeps its chats, and archives it as an ordinary bot", async () => {
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.state = { ...fixture.state, bots: [chief, bot("bea")] };
    askToDelete(chief);
    const dialog = openDialog()!;
    expect(dialog.props.body).toContain("Archive it instead to keep every conversation");
    const alternative = dialog.props.alternative as { label: string; onClick: () => void };
    expect(alternative.label).toBe("Archive instead");
    alternative.onClick();
    await vi.waitFor(() => expect(fixture.requests).toContainEqual({ path: "/api/bots/atlas", method: "PATCH", body: { hidden: true, chiefOfStaff: false } }));
    expect(openDialog()).toBeUndefined();
  });

  it("offers nothing else for any other bot, or for the last bot there is", () => {
    askToDelete(bot("bea"));
    expect(openDialog()!.props.alternative).toBeUndefined();
    const chief = bot("atlas", { chiefOfStaff: true });
    fixture.values = [];
    fixture.state = { ...fixture.state, bots: [chief] };
    askToDelete(chief);
    expect(openDialog()!.props.alternative).toBeUndefined();
  });
});
