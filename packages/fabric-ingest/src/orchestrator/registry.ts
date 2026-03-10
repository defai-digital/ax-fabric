import { randomUUID } from "node:crypto";

export type WorkerHealth = "healthy" | "unhealthy";

export interface RegisterRequest {
  worker_id?: string;
  addr: string;
  capabilities: string[];
  backend?: string;
  max_inflight: number;
  friendly_name?: string;
  chip_model?: string;
}

export interface RegisterResponse {
  worker_id: string;
  heartbeat_interval_ms: number;
}

export interface HeartbeatRequest {
  inflight: number;
  thermal_state?: string;
  model_ids?: string[];
  rss_bytes?: number;
}

interface WorkerEntry {
  id: string;
  addr: string;
  capabilities: string[];
  backend: string;
  max_inflight: number;
  inflight: number;
  health: WorkerHealth;
  drain: boolean;
  lastHeartbeatMs: number;
  thermal_state: string;
  rss_bytes: number;
  friendly_name?: string;
  chip_model?: string;
}

export interface WorkerSnapshot {
  id: string;
  addr: string;
  capabilities: string[];
  backend: string;
  max_inflight: number;
  inflight: number;
  saturation: number;
  health: WorkerHealth;
  drain: boolean;
  heartbeat_age_ms: number;
  thermal_state: string;
  rss_bytes: number;
  friendly_name?: string;
  chip_model?: string;
}

export interface WorkerCounts {
  total: number;
  healthy: number;
  unhealthy: number;
  draining: number;
}

export interface WorkerStatus {
  id: string;
  addr: string;
  inflight: number;
  max_inflight: number;
  capabilities: string[];
}

export interface UnhealthyWorkerAddress {
  id: string;
  addr: string;
}

export class WorkerRegistry {
  private readonly workers = new Map<string, WorkerEntry>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? (() => Date.now());
  }

  register(req: RegisterRequest, heartbeatIntervalMs: number): RegisterResponse {
    const now = this.now();
    const workerId = req.worker_id && req.worker_id.trim().length > 0
      ? req.worker_id.trim()
      : randomUUID();

    const existing = this.workers.get(workerId);
    if (existing) {
      existing.addr = req.addr;
      existing.capabilities = [...req.capabilities];
      existing.backend = normalizeBackend(req.backend);
      existing.max_inflight = Math.max(1, req.max_inflight);
      existing.health = "healthy";
      existing.lastHeartbeatMs = now;
      existing.drain = false;
      existing.friendly_name = req.friendly_name;
      existing.chip_model = req.chip_model;
    } else {
      this.workers.set(workerId, {
        id: workerId,
        addr: req.addr,
        capabilities: [...req.capabilities],
        backend: normalizeBackend(req.backend),
        max_inflight: Math.max(1, req.max_inflight),
        inflight: 0,
        health: "healthy",
        drain: false,
        lastHeartbeatMs: now,
        thermal_state: "",
        rss_bytes: 0,
        friendly_name: req.friendly_name,
        chip_model: req.chip_model,
      });
    }

    return {
      worker_id: workerId,
      heartbeat_interval_ms: heartbeatIntervalMs,
    };
  }

  heartbeat(workerId: string, req: HeartbeatRequest): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return false;
    }

    entry.lastHeartbeatMs = this.now();
    entry.health = "healthy";
    entry.inflight = Math.max(0, req.inflight);
    entry.thermal_state = req.thermal_state ?? "";
    entry.rss_bytes = req.rss_bytes ?? 0;
    if (req.model_ids) {
      entry.capabilities = [...req.model_ids];
    }
    return true;
  }

  markDrain(workerId: string): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return false;
    }
    entry.drain = true;
    return true;
  }

  markUnhealthy(workerId: string): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return false;
    }
    entry.health = "unhealthy";
    return true;
  }

  adjustInflight(workerId: string, delta: number): boolean {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return false;
    }
    const next = entry.inflight + delta;
    if (next < 0) {
      console.warn(`[registry] inflight underflow for worker ${workerId}: ${String(entry.inflight)} + ${String(delta)}`);
    }
    entry.inflight = Math.max(0, next);
    return true;
  }

  evict(workerId: string): void {
    this.workers.delete(workerId);
  }

  get(workerId: string): WorkerSnapshot | null {
    const entry = this.workers.get(workerId);
    if (!entry) {
      return null;
    }
    return this.toSnapshot(entry, this.now());
  }

  listAll(): WorkerSnapshot[] {
    const now = this.now();
    return Array.from(this.workers.values()).map((entry) => this.toSnapshot(entry, now));
  }

  counts(): WorkerCounts {
    let healthy = 0;
    let unhealthy = 0;
    let draining = 0;

    for (const entry of this.workers.values()) {
      if (entry.health === "healthy") {
        healthy += 1;
      } else {
        unhealthy += 1;
      }
      if (entry.drain) {
        draining += 1;
      }
    }

    return {
      total: this.workers.size,
      healthy,
      unhealthy,
      draining,
    };
  }

  eligibleWorkers(modelId: string): WorkerStatus[] {
    const out: WorkerStatus[] = [];
    for (const worker of this.workers.values()) {
      if (worker.health !== "healthy" || worker.drain) {
        continue;
      }
      if (!worker.capabilities.includes(modelId)) {
        continue;
      }
      out.push({
        id: worker.id,
        addr: worker.addr,
        inflight: worker.inflight,
        max_inflight: worker.max_inflight,
        capabilities: [...worker.capabilities],
      });
    }
    return out;
  }

  tick(ttlMs: number): string[] {
    const now = this.now();
    const toEvict: string[] = [];

    for (const worker of this.workers.values()) {
      const age = Math.max(0, now - worker.lastHeartbeatMs);
      if (worker.drain) {
        if (age > ttlMs) {
          toEvict.push(worker.id);
        }
        continue;
      }
      if (age > ttlMs) {
        toEvict.push(worker.id);
        continue;
      }
      worker.health = age <= Math.floor(ttlMs / 3) ? "healthy" : "unhealthy";
    }

    for (const id of toEvict) {
      this.workers.delete(id);
    }

    return toEvict;
  }

  eligibleHealthyCount(): number {
    let count = 0;
    for (const worker of this.workers.values()) {
      if (worker.health === "healthy" && !worker.drain) {
        count += 1;
      }
    }
    return count;
  }

  listUnhealthyAddresses(): UnhealthyWorkerAddress[] {
    const out: UnhealthyWorkerAddress[] = [];
    for (const worker of this.workers.values()) {
      if (worker.health !== "unhealthy") {
        continue;
      }
      out.push({ id: worker.id, addr: worker.addr });
    }
    return out;
  }

  private toSnapshot(entry: WorkerEntry, now: number): WorkerSnapshot {
    const saturation = entry.max_inflight > 0 ? entry.inflight / entry.max_inflight : 0;
    return {
      id: entry.id,
      addr: entry.addr,
      capabilities: [...entry.capabilities],
      backend: entry.backend,
      max_inflight: entry.max_inflight,
      inflight: entry.inflight,
      saturation,
      health: entry.health,
      drain: entry.drain,
      heartbeat_age_ms: Math.max(0, now - entry.lastHeartbeatMs),
      thermal_state: entry.thermal_state,
      rss_bytes: entry.rss_bytes,
      friendly_name: entry.friendly_name,
      chip_model: entry.chip_model,
    };
  }
}

function normalizeBackend(backend: string | undefined): string {
  if (!backend) {
    return "auto";
  }
  const normalized = backend.trim().toLowerCase();
  if (normalized === "native" || normalized === "llama_cpp" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}
