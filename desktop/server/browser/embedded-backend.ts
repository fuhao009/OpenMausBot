import { randomUUID } from "node:crypto";
import type { Backend, BackendCaps, OpenedBrowser, OpenRequest } from "./backends.ts";
import { CdpBrowser } from "./cdp/browser.ts";
import type { CdpTransport } from "./cdp/transport.ts";

const OPEN_TIMEOUT_MS = 20_000;
const MAX_PENDING = 32;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const CAPS: BackendCaps = {
  persistentProfile: true, window: false, egressGate: true, identityOverride: false,
  ownsAllTabs: true, downloads: "local", uploads: "path", botPasskeys: false,
};

type Wire = Record<string, unknown>;
type Lease = { leaseId: string; generation: string; version: string; pageLimit: { width: number; height: number } | null };
type Pending = { resolve(lease: Lease): void; reject(error: Error): void; timer: NodeJS.Timeout };

export interface EmbeddedBrowserBackend extends Backend {
  receive(raw: unknown): boolean;
  close(): void;
}

/** The parent owns the native browser; this child owns only its explicitly granted CDP leases. */
export function createEmbeddedBrowserBackend(options: {
  send(message: Wire): void;
  egressPort(key: string): Promise<number>;
}): EmbeddedBrowserBackend {
  const pending = new Map<string, Pending>();
  const leases = new Map<string, { generation: string; transport: CdpTransport; end(reason: string, release: boolean): void }>();
  const releases = new Map<string, { generation: string; done: Promise<boolean>; finish(acknowledged: boolean): void }>();
  const releaseResults = new WeakMap<CdpTransport, Promise<boolean>>();
  let closed = false;

  function openLease(request: OpenRequest): Promise<Lease> {
    if (closed) return Promise.reject(new Error("The desktop browser link is closed."));
    if (pending.size >= MAX_PENDING) return Promise.reject(new Error("Too many desktop browsers are opening."));
    const requestId = randomUUID();
    let resolve!: (lease: Lease) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Lease>((accept, refuse) => { resolve = accept; reject = refuse; });
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("The desktop browser did not open in time."));
    }, OPEN_TIMEOUT_MS);
    timer.unref?.();
    pending.set(requestId, { resolve, reject, timer });
    void options.egressPort(request.key).then((egressPort) => {
      if (!pending.has(requestId)) return;
      if (!Number.isSafeInteger(egressPort) || egressPort < 1 || egressPort > 65535) throw new Error("The browser egress gate is unavailable.");
      options.send({ type: "hezuo:embedded-browser-open", requestId, profileKey: request.key, fresh: request.fresh, viewport: request.viewport, egressPort });
    }).catch((error: unknown) => {
      const waiting = pending.get(requestId);
      if (!waiting) return;
      pending.delete(requestId);
      clearTimeout(waiting.timer);
      waiting.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return promise;
  }

  function transportFor(lease: Lease): CdpTransport {
    if (closed) {
      try { options.send({ type: "hezuo:embedded-browser-release", leaseId: lease.leaseId, generation: lease.generation }); } catch {}
      throw new Error("The desktop browser link is closed.");
    }
    if (leases.has(lease.leaseId)) throw new Error("The desktop returned an unavailable browser lease.");
    const messages = new Set<(message: string) => void>();
    const closes = new Set<(reason: string) => void>();
    let reason: string | null = null;
    function end(why: string, release: boolean): void {
      if (reason !== null) return;
      reason = why;
      leases.delete(lease.leaseId);
      if (release) {
        let settle!: (acknowledged: boolean) => void;
        const done = new Promise<boolean>((resolve) => { settle = resolve; });
        releaseResults.set(transport, done);
        const timer = setTimeout(() => finish(false), 5_000);
        timer.unref?.();
        function finish(acknowledged: boolean): void {
          clearTimeout(timer);
          releases.delete(lease.leaseId);
          settle(acknowledged);
        }
        releases.set(lease.leaseId, { generation: lease.generation, done, finish });
        try { options.send({ type: "hezuo:embedded-browser-release", leaseId: lease.leaseId, generation: lease.generation }); }
        catch { finish(false); }
      }
      messages.clear();
      for (const listener of closes) { try { listener(why); } catch {} }
      closes.clear();
    }
    const transport: CdpTransport = {
      send(message) {
        if (reason !== null) throw new Error(reason);
        try { options.send({ type: "hezuo:embedded-browser-cdp", leaseId: lease.leaseId, generation: lease.generation, message }); }
        catch (error) { end("The desktop browser link failed.", true); throw error; }
      },
      onMessage(listener) { if (reason === null) messages.add(listener); },
      onClose(listener) { if (reason !== null) listener(reason); else closes.add(listener); },
      close() { end("The desktop browser lease was released.", true); },
    };
    // Inbound messages are delivered only after both lease and generation were matched below.
    inbound.set(transport, (message) => { for (const listener of messages) listener(message); });
    leases.set(lease.leaseId, { generation: lease.generation, transport, end });
    return transport;
  }
  const inbound = new WeakMap<CdpTransport, (message: string) => void>();

  return {
    kind: "embedded",
    caps: CAPS,
    async open(request): Promise<OpenedBrowser> {
      const lease = await openLease(request);
      const transport = transportFor(lease);
      let exited!: () => void;
      const exit = new Promise<void>((resolve) => { exited = resolve; });
      transport.onClose(() => exited());
      try {
        const browser = await CdpBrowser.connect(transport, {
          identity: null, headless: false, viewport: null, downloadDir: request.downloadDir,
          permissions: false, handleAuth: true, maxPages: 8, timeoutMs: OPEN_TIMEOUT_MS,
        });
        return { browser, pid: null, version: lease.version, pageLimit: lease.pageLimit, exited: exit,
          async close() {
            browser.disconnect();
            transport.close();
            const release = releaseResults.get(transport);
            if (release && !await release) throw new Error("The desktop browser did not acknowledge release in time.");
          },
        };
      } catch (error) {
        transport.close();
        throw error;
      }
    },
    receive(raw): boolean {
      if (!raw || typeof raw !== "object") return false;
      const message = raw as Wire;
      if (message.type === "hezuo:embedded-browser-open-result") {
        if (typeof message.requestId !== "string") return true;
        const waiting = pending.get(message.requestId);
        const valid = message.ok === true && typeof message.leaseId === "string" && message.leaseId.length > 0
          && typeof message.generation === "string" && message.generation.length > 0 && typeof message.version === "string"
          && (message.pageLimit === null || (typeof message.pageLimit === "object" && message.pageLimit !== null
            && Number.isFinite((message.pageLimit as Wire).width) && Number.isFinite((message.pageLimit as Wire).height)
            && Number((message.pageLimit as Wire).width) > 0 && Number((message.pageLimit as Wire).height) > 0));
        if (!waiting) {
          if (valid && !leases.has(message.leaseId as string)) {
            try { options.send({ type: "hezuo:embedded-browser-release", leaseId: message.leaseId, generation: message.generation }); } catch {}
          }
          return true;
        }
        pending.delete(message.requestId);
        clearTimeout(waiting.timer);
        if (valid) waiting.resolve(message as unknown as Lease);
        else waiting.reject(new Error(typeof message.error === "string" ? message.error : "The desktop returned an invalid browser lease."));
        return true;
      }
      if (message.type !== "hezuo:embedded-browser-cdp" && message.type !== "hezuo:embedded-browser-closed") return false;
      if (message.type === "hezuo:embedded-browser-closed" && typeof message.leaseId === "string") {
        const release = releases.get(message.leaseId);
        if (release && release.generation === message.generation) release.finish(true);
      }
      const lease = typeof message.leaseId === "string" ? leases.get(message.leaseId) : undefined;
      if (!lease || message.generation !== lease.generation) return true;
      if (message.type === "hezuo:embedded-browser-closed") lease.end(typeof message.reason === "string" ? message.reason : "The desktop browser closed.", false);
      else if (typeof message.message === "string" && Buffer.byteLength(message.message) <= MAX_MESSAGE_BYTES) inbound.get(lease.transport)?.(message.message);
      else lease.end("The desktop sent an invalid CDP message.", true);
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error("The desktop browser link closed while opening."));
      }
      pending.clear();
      for (const lease of [...leases.values()]) lease.end("The desktop browser link closed.", true);
      for (const release of [...releases.values()]) release.finish(false);
    },
  };
}
