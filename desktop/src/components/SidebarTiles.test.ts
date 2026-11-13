import { Children, createElement, isValidElement, type KeyboardEvent, type MemoExoticComponent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rankPinnedCircles } from "@/lib/pinned-circle-order";
import { initialState, type Bot } from "@/state/store";

vi.mock("@/lib/interface-mode", async (original) => ({
  ...await original<typeof import("@/lib/interface-mode")>(),
  useAdvancedMode: () => false,
}));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { botRowProps } from "./Sidebar";
import { SidebarBotTile, SidebarTileGrid } from "./SidebarTiles";

const bot = (extra: Partial<Bot> = {}): Bot => ({
  id: "hezuo", threadId: "t", name: "Hezuo", title: "", description: "", notifications: true, color: "chrome",
  unread: false, modelSelection: { instanceId: "fake", model: "m" }, messages: [], ...extra,
});
const dispatch = vi.fn();
const onMenu = vi.fn();
const props = (candidate: Bot, selected = false) => botRowProps({ ...initialState, bots: [candidate], selectedId: selected ? candidate.id : "", activeView: "chat" }, dispatch, candidate, { density: "comfortable", query: "", onMenu });
const tile = (SidebarBotTile as MemoExoticComponent<(props: Parameters<typeof SidebarBotTile>[0]) => ReactNode>).type;

type Props = { children?: ReactNode; [key: string]: unknown };
function find(tree: ReactNode, attribute: string): ReactElement<Props> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<Props>(child)) continue;
    if (child.props[attribute] !== undefined) return child;
    const found = find(child.props.children, attribute);
    if (found) return found;
  }
}

beforeEach(() => {
  dispatch.mockClear();
  onMenu.mockClear();
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 800 });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => vi.unstubAllGlobals());

describe("the sidebar tiles", () => {
  it.each([true, false])("draws every tile the same: 78 by 92, radius 10, a 56px avatar over a one-line 13px medium name (Chief %s)", (chief) => {
    const html = renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ chiefOfStaff: chief }))));
    expect(html).toMatch(/data-sidebar-tile=""[^>]*class="[^"]*\bh-\[92px\] w-\[78px\][^"]*\brounded-\[10px\]/);
    expect(html).toContain('width="56px" height="56px"');
    expect(html).toMatch(/truncate text-center text-\[13px\] font-medium leading-4 text-ink"[^>]*>Hezuo</);
    expect(html).not.toContain("data-provider-mark");
  });

  it("gives the crown to a Chief's tile, and to no other", () => {
    const tileHtml = (extra: Partial<Bot>) => renderToStaticMarkup(createElement(SidebarBotTile, props(bot(extra))));
    const chief = tileHtml({ chiefOfStaff: true });
    expect(chief).toContain('data-testid="chief-badge"');
    expect(chief).toContain('title="Hezuo · Chief of Staff"');
    expect(tileHtml({})).not.toContain('data-testid="chief-badge"');
  });

  it("fills the selected tile and marks it current, and shows working, waiting and unread as a dot on the avatar", () => {
    const selected = renderToStaticMarkup(createElement(SidebarBotTile, props(bot(), true)));
    expect(selected).toContain('aria-current="page"');
    expect(selected).toContain("[--tile:var(--color-raised)]");
    expect(renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ busy: true }))))).toContain('data-testid="working-dot"');
    expect(renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ activity: "waiting-on-you" }))))).toContain('data-testid="waiting-dot"');
    const unread = renderToStaticMarkup(createElement(SidebarBotTile, props(bot({ unread: true }))));
    expect(unread).toContain('data-testid="unread-dot"');
    expect(unread).toContain('aria-label="Hezuo · Unread"');
  });

  it("opens the bot on Enter and its menu from the ContextMenu key", () => {
    let tree: ReactNode;
    function Capture() { tree = tile(props(bot())); return tree; }
    renderToStaticMarkup(createElement(Capture));
    const element = find(tree, "data-sidebar-tile")!;
    const key = (name: string) => (element.props.onKeyDown as (event: KeyboardEvent) => void)({
      key: name, shiftKey: false, preventDefault: vi.fn(), currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, width: 94, height: 92 }) },
    } as unknown as KeyboardEvent);
    key("Enter");
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "hezuo" });
    key("ContextMenu");
    expect(onMenu).toHaveBeenCalledWith({ botId: "hezuo", x: 57, y: 66 });
  });
});

describe("the tile grid", () => {
  const pins = (count: number) => Array.from({ length: count }, (_, index) => bot({ id: `pin${index}`, name: `Pin ${index}`, pinned: true, ...(index === 0 ? { chiefOfStaff: true } : {}) }));
  const dragApi = { row: () => ({ draggable: true as const }), step: () => {} } as never;
  const grid = (pinned: Bot[], order: string[] = []) => {
    const row = (candidate: Bot) => ({
      ...botRowProps({ ...initialState, bots: pinned, selectedId: "", activeView: "chat" }, dispatch, candidate, { density: "comfortable", query: "", onMenu }),
      botDrag: dragApi,
    });
    return renderToStaticMarkup(createElement(SidebarTileGrid, { pinned: rankPinnedCircles(pinned, order), row }));
  };
  const tiles = (html: string) => [...html.matchAll(/<div [^>]*data-sidebar-bot-row="([^"]+)" data-sidebar-tile="" draggable="true"[^>]*>/g)]
    .map(([tag, id]) => `${id}${tag.includes('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"') ? ":drag" : ""}`);

  it.each([1, 2, 3, 5])("draws exactly the %i pinned bots as same-size, draggable tiles in one centred, wrapping grid", (count) => {
    const html = grid(pins(count));
    expect(tiles(html)).toEqual(pins(count).map((pin) => `${pin.id}:drag`));
    expect(html).toMatch(/^<div data-sidebar-tiles="" class="flex max-h-\[40vh\] flex-wrap justify-center gap-1 overflow-y-auto /);
    expect(html.match(/\bh-\[92px\] w-\[78px\]/g)).toHaveLength(count);
    expect(html.match(/width="56px" height="56px"/g)).toHaveLength(count);
    expect(html.match(/data-testid="chief-badge"/g)).toHaveLength(1);
  });

  it("draws the tiles in the order it is given, with no tile of its own for the default bot", () => {
    expect(tiles(grid(pins(3), ["pin2", "pin0"]))).toEqual(["pin2:drag", "pin0:drag", "pin1:drag"]);
  });

  it("is only a slim place to drop a bot when nothing is pinned", () => {
    const html = grid([]);
    expect(tiles(html)).toEqual([]);
    expect(html).toContain("data-sidebar-tiles");
    expect(html).toContain("Drop here to pin");
    expect(html).toMatch(/\bh-10\b/);
    expect(html).not.toContain("h-[92px]");
  });

  // A grid taller than its 40vh cap scrolls, and its 8px scrollbar takes from the room.
  it.each([[280, 3], [360, 4]])("fits %ipx of sidebar to %i tiles across, with or without a scrollbar", (width, columns) => {
    const html = grid(pins(5));
    const tile = Number(/data-sidebar-tile=""[^>]*class="[^"]*\bw-\[(\d+)px\]/.exec(html)![1]);
    const gridClass = /data-sidebar-tiles="" class="([^"]*)"/.exec(html)![1]!;
    const gap = 4 * Number(/\bgap-(\d+)\b/.exec(gridClass)![1]);
    const gutters = 2 * 4 * Number(/\bpx-(\d+)\b/.exec(gridClass)![1]);
    const across = (room: number) => Math.floor((room + gap) / (tile + gap));
    expect(across(width - gutters)).toBe(columns);
    expect(across(width - gutters - 8)).toBe(columns);
  });
});
