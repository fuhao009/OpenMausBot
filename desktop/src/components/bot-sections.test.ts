import { afterEach, describe, expect, it, vi } from "vitest";

import { reorderDepartments, unpinIntoSection } from "./bot-sections";

const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
let failing = false;
let remote = false;

const stubWindow = () => vi.stubGlobal("window", { ogb: remote ? { remoteClient: { active: true } } : undefined, location: { origin: "http://127.0.0.1" } });
const stubFetch = () => vi.stubGlobal("fetch", async (path: string, init: RequestInit = {}) => {
  requests.push({ path: String(path), method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined });
  if (failing) return new Response(JSON.stringify({ error: "List every department exactly once" }), { status: 400, headers: { "content-type": "application/json" } });
  const body = String(path).includes("/order") ? { sections: JSON.parse(String(init.body)).sections } : { bots: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

afterEach(() => {
  requests.length = 0;
  failing = false;
  remote = false;
  vi.unstubAllGlobals();
});

describe("saving the departments' order", () => {
  it("shows the new order at once and keeps what the server answers", async () => {
    stubWindow();
    stubFetch();
    const dispatch = vi.fn();
    await reorderDepartments(dispatch, ["Work", "Home"], ["Home", "Work"]);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "sections", sections: ["Home", "Work"] },
      { type: "sections", sections: ["Home", "Work"] },
    ]);
    expect(requests).toEqual([{ path: "/api/sidebar-sections/order", method: "PUT", body: { sections: ["Home", "Work"] } }]);
  });

  it("puts the old order back, and says why, when the server refuses", async () => {
    stubWindow();
    stubFetch();
    failing = true;
    const dispatch = vi.fn();
    await reorderDepartments(dispatch, ["Work", "Home"], ["Home", "Work"]);
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "sections", sections: ["Home", "Work"] },
      { type: "sections", sections: ["Work", "Home"] },
      { type: "error", message: expect.stringContaining("exactly once") },
    ]);
  });
});

describe("a pinned bot leaving the tiles", () => {
  it("unpins and files it in one profile patch on the desktop", () => {
    stubWindow();
    stubFetch();
    const dispatch = vi.fn();
    unpinIntoSection(dispatch, "pia", "Work");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "updateBot", botId: "pia", patch: { pinned: false, section: "Work" } }]);
    expect(requests).toEqual([]);
  });

  it("unpins by profile patch and files by the department request on a remote client, whose profile patch cannot carry the department", () => {
    remote = true;
    stubWindow();
    stubFetch();
    const dispatch = vi.fn();
    unpinIntoSection(dispatch, "pia", "Work");
    expect(dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "pia", patch: { pinned: false } });
    expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ patch: expect.objectContaining({ section: "Work" }) }));
    expect(requests).toEqual([{ path: "/api/sidebar-sections", method: "POST", body: { name: "Work", botIds: ["pia"] } }]);
  });
});
