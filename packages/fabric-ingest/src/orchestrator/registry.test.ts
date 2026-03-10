import { describe, it, expect } from "vitest";

import { WorkerRegistry } from "./registry.js";

describe("WorkerRegistry", () => {
  it("registers worker and returns worker_id + heartbeat interval", () => {
    const registry = new WorkerRegistry(() => 1_000);

    const out = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    expect(out.worker_id.length).toBeGreaterThan(0);
    expect(out.heartbeat_interval_ms).toBe(5_000);

    const workers = registry.listAll();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.capabilities).toEqual(["default"]);
  });

  it("supports idempotent re-register with same worker_id", () => {
    const registry = new WorkerRegistry(() => 1_000);

    const first = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    const second = registry.register(
      {
        worker_id: first.worker_id,
        addr: "127.0.0.1:28082",
        capabilities: ["alpha"],
        max_inflight: 4,
      },
      5_000,
    );

    expect(second.worker_id).toBe(first.worker_id);
    const worker = registry.get(first.worker_id);
    expect(worker?.addr).toBe("127.0.0.1:28082");
    expect(worker?.capabilities).toEqual(["alpha"]);
    expect(worker?.max_inflight).toBe(4);
  });

  it("clears optional metadata when re-register omits it", () => {
    const registry = new WorkerRegistry(() => 1_000);
    const first = registry.register(
      {
        worker_id: "worker-a",
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
        friendly_name: "GPU-A",
        chip_model: "M4 Max",
      },
      5_000,
    );
    expect(first.worker_id).toBe("worker-a");
    expect(registry.get("worker-a")?.friendly_name).toBe("GPU-A");
    expect(registry.get("worker-a")?.chip_model).toBe("M4 Max");

    registry.register(
      {
        worker_id: "worker-a",
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    const worker = registry.get("worker-a");
    expect(worker?.friendly_name).toBeUndefined();
    expect(worker?.chip_model).toBeUndefined();
  });

  it("updates heartbeat state and model capability snapshot", () => {
    let now = 1_000;
    const registry = new WorkerRegistry(() => now);

    const reg = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    now = 2_000;
    const ok = registry.heartbeat(reg.worker_id, {
      inflight: 3,
      thermal_state: "nominal",
      model_ids: ["qwen3-8b"],
      rss_bytes: 123,
    });

    expect(ok).toBe(true);
    const worker = registry.get(reg.worker_id);
    expect(worker?.inflight).toBe(3);
    expect(worker?.thermal_state).toBe("nominal");
    expect(worker?.capabilities).toEqual(["qwen3-8b"]);
    expect(worker?.rss_bytes).toBe(123);
  });

  it("keeps existing capabilities when heartbeat omits model_ids", () => {
    const registry = new WorkerRegistry(() => 1_000);

    const reg = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default", "qwen3-8b"],
        max_inflight: 8,
      },
      5_000,
    );

    const ok = registry.heartbeat(reg.worker_id, {
      inflight: 1,
      thermal_state: "nominal",
      rss_bytes: 256,
    });
    expect(ok).toBe(true);
    expect(registry.get(reg.worker_id)?.capabilities).toEqual(["default", "qwen3-8b"]);
  });

  it("transitions to unhealthy then evicts when ttl exceeded", () => {
    let now = 0;
    const registry = new WorkerRegistry(() => now);

    const reg = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    const ttl = 9_000;

    now = 4_000; // > ttl/3
    registry.tick(ttl);
    expect(registry.get(reg.worker_id)?.health).toBe("unhealthy");

    now = 10_000; // > ttl
    const evicted = registry.tick(ttl);
    expect(evicted).toEqual([reg.worker_id]);
    expect(registry.get(reg.worker_id)).toBeNull();
  });

  it("tracks eligible healthy workers and unhealthy addresses", () => {
    let now = 0;
    const registry = new WorkerRegistry(() => now);
    const a = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );
    const b = registry.register(
      {
        addr: "127.0.0.1:28082",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    expect(registry.eligibleHealthyCount()).toBe(2);
    expect(registry.listUnhealthyAddresses()).toEqual([]);

    registry.markDrain(a.worker_id);
    now = 4_000;
    registry.tick(9_000);

    expect(registry.eligibleHealthyCount()).toBe(0);
    expect(registry.listUnhealthyAddresses()).toEqual([{ id: b.worker_id, addr: "127.0.0.1:28082" }]);
  });

  it("marks worker as draining and supports eviction", () => {
    const registry = new WorkerRegistry(() => 1_000);
    const reg = registry.register(
      {
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      },
      5_000,
    );

    expect(registry.markDrain(reg.worker_id)).toBe(true);
    expect(registry.get(reg.worker_id)?.drain).toBe(true);

    registry.evict(reg.worker_id);
    expect(registry.get(reg.worker_id)).toBeNull();
  });
});
