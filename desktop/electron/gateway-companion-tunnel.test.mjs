import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./product-ca.mjs", () => ({
  normalizeProductTrust: input => input,
  createPinnedHttpsFetch: () => ({ close() {} }),
}));
import { createGatewayCompanionTunnel } from "./gateway-companion-tunnel.mjs";

const sockets = [];
class Socket extends EventEmitter {
  constructor() {
    super();
    sockets.push(this);
    queueMicrotask(() => this.emit("open"));
  }
  close() {}
  terminate() {}
}

afterEach(() => { sockets.length = 0; vi.useRealTimers(); });

it("does not reconnect when the gateway replaces the installation with close 4000", async () => {
  vi.useFakeTimers();
  const tunnel = createGatewayCompanionTunnel({
    origin: "https://gateway.example", ca: "fixture-ca",
    installationId: "11111111-1111-4111-8111-111111111111", credential: "fixture",
    originTarget: { pid: 1234, socketPath: "/tmp/omb-companion-origin-fixture/origin.sock" }, WebSocketImpl: Socket,
  });
  const starting = tunnel.start();
  await Promise.resolve();
  await vi.runAllTicks();
  await starting;
  expect(sockets).toHaveLength(1);
  sockets[0].emit("close", 4000, Buffer.from("replaced"));
  expect(tunnel.getStatus()).toMatchObject({ status: "replaced", ready: false });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(sockets).toHaveLength(1);
  await tunnel.stop();
});
