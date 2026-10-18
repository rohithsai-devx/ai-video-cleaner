import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRunEvents, type RunEvent } from "./events";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 1;
  url: string;
  closed = false;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: MessageEvent) => void>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(name, fn);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

function open() {
  const events: RunEvent[] = [];
  const onError = vi.fn();
  const close = openRunEvents("r1", { onEvent: (e) => events.push(e), onError });
  return { es: FakeEventSource.instances[0]!, events, onError, close };
}

describe("openRunEvents", () => {
  it("connects to the same-origin proxy and types each named event", () => {
    const { es, events } = open();
    expect(es.url).toBe("/api/runs/r1/events");
    es.emit("run.status", { status: "queued", stage: null });
    es.emit("run.proposal_ready", { version: 1, flags: [], auto_approved: false });
    expect(events).toEqual([
      { type: "run.status", data: { status: "queued", stage: null } },
      { type: "run.proposal_ready", data: { version: 1, flags: [], auto_approved: false } },
    ]);
    expect(es.closed).toBe(false);
  });

  it("closes on run.done and run.failed", () => {
    for (const [name, data] of [
      ["run.done", { video_id: "v", output_uri: "gs://x" }],
      ["run.failed", { stage: "render", message: "boom", retryable: true }],
    ] as const) {
      FakeEventSource.instances = [];
      const { es, events } = open();
      es.emit(name, data);
      expect(events).toHaveLength(1);
      expect(es.closed).toBe(true);
    }
  });

  it("closes on a cancelled status", () => {
    const { es } = open();
    es.emit("run.status", { status: "cancelled", stage: null });
    expect(es.closed).toBe(true);
  });

  it("reports connection drops and ignores malformed payloads", () => {
    const { es, events, onError } = open();
    es.listeners.get("run.status")?.(new MessageEvent("run.status", { data: "{nope" }));
    es.onerror?.();
    expect(events).toEqual([]);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(false);
  });

  it("tells the caller when the browser gave up reconnecting (non-2xx)", () => {
    const { es, onError } = open();
    es.readyState = FakeEventSource.CLOSED;
    es.onerror?.();
    expect(onError).toHaveBeenCalledWith(true);
  });

  it("closes when the caller unmounts and stops delivering", () => {
    const { es, events, close } = open();
    close();
    expect(es.closed).toBe(true);
    es.emit("run.status", { status: "queued" });
    expect(events).toEqual([]);
  });
});
