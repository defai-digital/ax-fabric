import { describe, expect, it } from "vitest";

import { LeastInflightPolicy, ModelAffinityPolicy, WeightedRoundRobinPolicy } from "./policy.js";
import type { WorkerStatus } from "./registry.js";

function worker(id: string, inflight: number, max: number): WorkerStatus {
  return {
    id,
    addr: `127.0.0.1:${20000 + inflight}`,
    inflight,
    max_inflight: max,
    capabilities: ["default"],
  };
}

describe("dispatch policies", () => {
  it("least_inflight picks lowest load ratio", () => {
    const policy = new LeastInflightPolicy();
    const selected = policy.select(
      [worker("a", 3, 4), worker("b", 1, 4), worker("c", 2, 4)],
      "default",
    );
    expect(selected?.id).toBe("b");
  });

  it("weighted_round_robin skips full workers", () => {
    const policy = new WeightedRoundRobinPolicy();
    const selected = policy.select(
      [worker("a", 4, 4), worker("b", 1, 4)],
      "default",
    );
    expect(selected?.id).toBe("b");
  });

  it("model_affinity prefers workers with prior successful dispatch", () => {
    const policy = new ModelAffinityPolicy();
    const workers = [worker("a", 0, 4), worker("b", 0, 4)];

    expect(policy.select(workers, "default")?.id).toBe("a");

    policy.recordDispatch?.("b", "default");
    policy.recordDispatch?.("b", "default");

    expect(policy.select(workers, "default")?.id).toBe("b");
  });

  it("model_affinity does not erase affinity for other models", () => {
    const policy = new ModelAffinityPolicy();
    policy.recordDispatch?.("x", "model-a");
    policy.recordDispatch?.("y", "model-b");

    expect(policy.select([worker("x", 0, 4)], "model-a")?.id).toBe("x");
    expect(policy.select([worker("y", 0, 4)], "model-b")?.id).toBe("y");
  });
});
