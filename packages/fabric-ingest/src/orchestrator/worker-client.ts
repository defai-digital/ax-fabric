import type { HeartbeatRequest, RegisterRequest, RegisterResponse } from "./registry.js";

export interface WorkerClientConfig {
  orchestratorAddr: string;
  selfAddr: string;
  capabilities: string[];
  maxInflight: number;
  orchestratorToken?: string;
  backend?: string;
  friendlyName?: string;
  chipModel?: string;
}

export interface HeartbeatLoopOptions {
  getHeartbeat: () => HeartbeatRequest | Promise<HeartbeatRequest>;
  onRegistered?: (workerId: string) => void;
  minIntervalMs?: number;
}

export interface HeartbeatLoopHandle {
  stop: () => void;
  done: Promise<void>;
  workerId: () => string | null;
}

export class WorkerLifecycleClient {
  private readonly fetchImpl: typeof fetch;
  private readonly config: WorkerClientConfig;

  constructor(config: WorkerClientConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private authHeaders(): Record<string, string> {
    if (!this.config.orchestratorToken) {
      return {};
    }
    return { "x-ax-orchestrator-token": this.config.orchestratorToken };
  }

  async register(signal?: AbortSignal): Promise<RegisterResponse> {
    const body: RegisterRequest = {
      addr: this.config.selfAddr,
      capabilities: [...this.config.capabilities],
      backend: this.config.backend ?? "auto",
      max_inflight: Math.max(1, this.config.maxInflight),
      friendly_name: this.config.friendlyName,
      chip_model: this.config.chipModel,
    };
    const response = await this.fetchImpl(
      `${this.config.orchestratorAddr}/internal/workers/register`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(`register failed (${response.status})`);
    }
    return await response.json() as RegisterResponse;
  }

  async heartbeat(workerId: string, payload: HeartbeatRequest, signal?: AbortSignal): Promise<Response> {
    return await this.fetchImpl(
      `${this.config.orchestratorAddr}/internal/workers/${encodeURIComponent(workerId)}/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify(payload),
        signal,
      },
    );
  }

  async drain(workerId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(
      `${this.config.orchestratorAddr}/internal/workers/${encodeURIComponent(workerId)}/drain`,
      { method: "POST", headers: this.authHeaders(), signal },
    );
    if (!(response.ok || response.status === 404 || response.status === 410)) {
      throw new Error(`drain failed (${response.status})`);
    }
  }

  async drainComplete(workerId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(
      `${this.config.orchestratorAddr}/internal/workers/${encodeURIComponent(workerId)}/drain-complete`,
      { method: "POST", headers: this.authHeaders(), signal },
    );
    if (!(response.ok || response.status === 204 || response.status === 404 || response.status === 410)) {
      throw new Error(`drain-complete failed (${response.status})`);
    }
  }

  startHeartbeatLoop(options: HeartbeatLoopOptions): HeartbeatLoopHandle {
    const controller = new AbortController();
    let workerId: string | null = null;
    const minIntervalMs = Math.max(50, options.minIntervalMs ?? 250);

    const done = (async () => {
      let intervalMs = 5_000;

      const registerWithRetry = async (): Promise<boolean> => {
        while (!controller.signal.aborted) {
          try {
            const reg = await this.register(controller.signal);
            workerId = reg.worker_id;
            intervalMs = Math.max(minIntervalMs, reg.heartbeat_interval_ms);
            options.onRegistered?.(reg.worker_id);
            return true;
          } catch (error) {
            if (controller.signal.aborted && isAbortError(error)) {
              return false;
            }
            await sleep(minIntervalMs, controller.signal);
          }
        }
        return false;
      };

      const ready = await registerWithRetry();
      if (!ready) {
        return;
      }

      while (!controller.signal.aborted) {
        await sleep(intervalMs, controller.signal);
        if (!workerId || controller.signal.aborted) {
          continue;
        }

        let payload: HeartbeatRequest;
        try {
          payload = await options.getHeartbeat();
        } catch {
          await sleep(minIntervalMs, controller.signal);
          continue;
        }
        let response: Response;
        try {
          response = await this.heartbeat(workerId, payload, controller.signal);
        } catch (error) {
          if (controller.signal.aborted && isAbortError(error)) {
            break;
          }
          await sleep(minIntervalMs, controller.signal);
          continue;
        }
        if (response.status === 404 || response.status === 410) {
          const ok = await registerWithRetry();
          if (!ok) {
            break;
          }
          continue;
        }
        if (!response.ok) {
          await sleep(minIntervalMs, controller.signal);
          continue;
        }
      }
    })();

    return {
      stop: () => controller.abort(),
      done,
      workerId: () => workerId,
    };
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }
  if (typeof error === "object" && error !== null && "name" in error) {
    return String((error as { name: unknown }).name) === "AbortError";
  }
  return false;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
