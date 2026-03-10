import type { WorkerStatus } from "./registry.js";

export interface DispatchPolicy {
  select(workers: WorkerStatus[], modelId: string): WorkerStatus | null;
  recordDispatch?(workerId: string, modelId: string): void;
}

export class LeastInflightPolicy implements DispatchPolicy {
  select(workers: WorkerStatus[], _modelId: string): WorkerStatus | null {
    const eligible = workers.filter((w) => w.inflight < w.max_inflight);
    if (eligible.length === 0) {
      return null;
    }

    eligible.sort((a, b) => {
      const aLoad = a.inflight / Math.max(1, a.max_inflight);
      const bLoad = b.inflight / Math.max(1, b.max_inflight);
      if (aLoad !== bLoad) {
        return aLoad - bLoad;
      }
      return a.id.localeCompare(b.id);
    });

    return eligible[0] ?? null;
  }
}

export class WeightedRoundRobinPolicy implements DispatchPolicy {
  private position = 0;

  select(workers: WorkerStatus[], _modelId: string): WorkerStatus | null {
    const weighted = workers
      .map((worker) => ({ worker, cap: Math.max(0, worker.max_inflight - worker.inflight) }))
      .filter((x) => x.cap > 0);

    if (weighted.length === 0) {
      return null;
    }

    const totalWeight = weighted.reduce((sum, x) => sum + x.cap, 0);
    const slot = this.position % totalWeight;
    this.position += 1;

    let cumulative = 0;
    for (const item of weighted) {
      cumulative += item.cap;
      if (slot < cumulative) {
        return item.worker;
      }
    }

    return weighted[weighted.length - 1]?.worker ?? null;
  }
}

/** Maximum number of distinct model IDs tracked in the affinity map. */
const MAX_AFFINITY_MODELS = 256;

export class ModelAffinityPolicy implements DispatchPolicy {
  private readonly affinity = new Map<string, Map<string, number>>();

  select(workers: WorkerStatus[], modelId: string): WorkerStatus | null {
    const currentWorkerIds = new Set(workers.map((w) => w.id));
    const perModel = this.affinity.get(modelId);
    if (perModel) {
      for (const workerId of perModel.keys()) {
        if (!currentWorkerIds.has(workerId)) {
          perModel.delete(workerId);
        }
      }
      if (perModel.size === 0) {
        this.affinity.delete(modelId);
      }
    }

    const eligible = workers.filter((w) => w.inflight < w.max_inflight);
    if (eligible.length === 0) {
      return null;
    }

    const counts = this.affinity.get(modelId);
    const withAffinity = counts
      ? eligible.filter((w) => (counts.get(w.id) ?? 0) > 0)
      : [];
    const candidates = withAffinity.length > 0 ? withAffinity : eligible;

    candidates.sort((a, b) => {
      const aLoad = a.inflight / Math.max(1, a.max_inflight);
      const bLoad = b.inflight / Math.max(1, b.max_inflight);
      if (aLoad !== bLoad) {
        return aLoad - bLoad;
      }
      return a.id.localeCompare(b.id);
    });
    return candidates[0] ?? null;
  }

  recordDispatch(workerId: string, modelId: string): void {
    let perModel = this.affinity.get(modelId);
    if (!perModel) {
      // Evict the least-recently-inserted model when the cap is reached.
      if (this.affinity.size >= MAX_AFFINITY_MODELS) {
        const oldest = this.affinity.keys().next().value;
        if (oldest !== undefined) this.affinity.delete(oldest);
      }
      perModel = new Map<string, number>();
      this.affinity.set(modelId, perModel);
    }
    perModel.set(workerId, (perModel.get(workerId) ?? 0) + 1);
  }
}

export function policyFromName(name: string | undefined): DispatchPolicy {
  const normalized = (name ?? "least_inflight").trim().toLowerCase();
  if (normalized === "weighted_round_robin") {
    return new WeightedRoundRobinPolicy();
  }
  if (normalized === "model_affinity") {
    return new ModelAffinityPolicy();
  }
  return new LeastInflightPolicy();
}
