import { expect, it } from "vitest";
import { readBoundedJSON } from "../src/http";

it("enforces explicit inference limits without increasing ordinary API limits", async () => {
  const body = JSON.stringify({ image: "a".repeat(20 * 1024) });
  const request = () => new Request("https://fixture.test/", { method: "POST", headers: { "content-type": "application/json" }, body });
  await expect(readBoundedJSON(request())).rejects.toMatchObject({ status: 413 });
  expect(await readBoundedJSON(request(), 48 * 1024 * 1024)).toEqual(JSON.parse(body));
});

it("rejects a bounded streamed body whose declared length disagrees", async () => {
  const request = new Request("https://fixture.test/", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "1" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); } }),
  });
  await expect(readBoundedJSON(request)).rejects.toMatchObject({ status: 400 });
});
