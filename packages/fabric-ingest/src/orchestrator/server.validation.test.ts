import { describe, expect, it, vi } from "vitest";

import {
  parseHeartbeatRequest,
  parseHostPort,
  parseRegisterRequest,
  startServerBindings,
  type ServerBinding,
} from "./server.js";

function makeBinding(options: { fail?: boolean } = {}): ServerBinding & { closed: ReturnType<typeof vi.fn> } {
  const listeners = new Map<string, (error: Error) => void>();
  const closed = vi.fn();

  const server = {
    once(event: "error", listener: (error: Error) => void) {
      listeners.set(event, listener);
    },
    off(event: "error", listener: (error: Error) => void) {
      const current = listeners.get(event);
      if (current === listener) {
        listeners.delete(event);
      }
    },
    listen(_port: number, _host: string, listeningListener: () => void) {
      if (options.fail) {
        const listener = listeners.get("error");
        listener?.(new Error("bind failed"));
        return;
      }
      listeningListener();
    },
    close(callback: (err?: Error) => void) {
      closed();
      callback();
    },
    address() {
      return { address: "127.0.0.1", family: "IPv4", port: 0 };
    },
  };

  return {
    server,
    port: 0,
    host: "127.0.0.1",
    closed,
  };
}

describe("orchestrator server validation", () => {
  it("rejects non-integer register max_inflight and trims capabilities", () => {
    const bad = parseRegisterRequest({
      addr: "127.0.0.1:28081",
      capabilities: ["default"],
      max_inflight: 1.5,
    });
    expect(bad).toEqual({
      ok: false,
      error: "max_inflight must be an integer > 0",
    });

    const good = parseRegisterRequest({
      worker_id: " worker-a ",
      addr: "127.0.0.1:28081",
      capabilities: [" default ", "", "alpha"],
      max_inflight: 2,
      friendly_name: " GPU A ",
    });

    expect(good).toEqual({
      ok: true,
      value: {
        worker_id: "worker-a",
        addr: "127.0.0.1:28081",
        capabilities: ["default", "alpha"],
        backend: undefined,
        max_inflight: 2,
        friendly_name: "GPU A",
        chip_model: undefined,
      },
    });
  });

  it("rejects invalid heartbeat counters and trims model ids", () => {
    expect(parseHeartbeatRequest({ inflight: 0.25 })).toEqual({
      ok: false,
      error: "inflight must be an integer >= 0",
    });
    expect(parseHeartbeatRequest({ inflight: 1, rss_bytes: -1 })).toEqual({
      ok: false,
      error: "rss_bytes must be an integer >= 0",
    });

    expect(parseHeartbeatRequest({
      inflight: 1,
      model_ids: [" default ", "", "alpha"],
      thermal_state: " nominal ",
      rss_bytes: 42,
    })).toEqual({
      ok: true,
      value: {
        inflight: 1,
        model_ids: ["default", "alpha"],
        thermal_state: "nominal",
        rss_bytes: 42,
      },
    });
  });

  it("rejects malformed host:port values with trailing junk", () => {
    expect(parseHostPort("127.0.0.1:8080/path")).toBeNull();
    expect(parseHostPort("[::1]:8080extra")).toBeNull();
    expect(parseHostPort("http://127.0.0.1:8080/base")).toEqual({
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("closes already-started listeners when a later bind fails", async () => {
    const first = makeBinding();
    const second = makeBinding({ fail: true });

    await expect(startServerBindings([first, second])).rejects.toThrow("bind failed");
    expect(first.closed).toHaveBeenCalledTimes(1);
    expect(second.closed).not.toHaveBeenCalled();
  });
});
