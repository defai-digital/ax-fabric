import type { DispatchPolicy } from "./policy.js";
import type { WorkerRegistry } from "./registry.js";
import { DEFAULT_WORKER_REQUEST_TIMEOUT_MS } from "../constants.js";

export interface DispatchResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export class DirectDispatcher {
  private readonly policy: DispatchPolicy;

  constructor(policy: DispatchPolicy) {
    this.policy = policy;
  }

  async forward(
    registry: WorkerRegistry,
    modelId: string,
    path: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Promise<DispatchResult> {
    const workers = registry.eligibleWorkers(modelId);
    if (workers.length === 0) {
      return textResult(503, `no eligible workers for model '${modelId}'`);
    }

    const selected = this.policy.select(workers, modelId);
    if (!selected) {
      return textResult(503, `all workers for '${modelId}' are at capacity`);
    }

    const first = await this.forwardToWorker(registry, selected.id, selected.addr, path, body, headers);
    if (!first.retry) {
      if (first.result.status >= 200 && first.result.status < 300) {
        this.policy.recordDispatch?.(selected.id, modelId);
      }
      return first.result;
    }

    registry.markUnhealthy(selected.id);

    const fallbackWorkers = registry.eligibleWorkers(modelId).filter((w) => w.id !== selected.id);
    const fallback = this.policy.select(fallbackWorkers, modelId);
    if (!fallback) {
      return textResult(503, `no alternative worker for '${modelId}' after reroute`);
    }

    const second = await this.forwardToWorker(registry, fallback.id, fallback.addr, path, body, headers);
    if (!second.retry) {
      if (second.result.status >= 200 && second.result.status < 300) {
        this.policy.recordDispatch?.(fallback.id, modelId);
      }
      return second.result;
    }

    registry.markUnhealthy(fallback.id);
    return textResult(503, "all workers failed for this request");
  }

  private async forwardToWorker(
    registry: WorkerRegistry,
    workerId: string,
    workerAddr: string,
    path: string,
    body: Buffer,
    headers: Record<string, string>,
  ): Promise<{ result: DispatchResult; retry: boolean }> {
    registry.adjustInflight(workerId, 1);
    try {
      const response = await fetch(workerUrl(workerAddr, path), {
        method: "POST",
        headers: {
          "content-type": headers["content-type"] ?? "application/json",
          ...(headers["authorization"] ? { authorization: headers["authorization"] } : {}),
        },
        body: new Uint8Array(body),
        signal: AbortSignal.timeout(DEFAULT_WORKER_REQUEST_TIMEOUT_MS),
      });

      const buf = Buffer.from(await response.arrayBuffer());
      const out = {
        status: response.status,
        headers: {
          "content-type": response.headers.get("content-type") ?? "application/json",
        },
        body: buf,
      };

      return {
        result: out,
        retry: response.status >= 500,
      };
    } catch {
      return {
        result: textResult(502, "worker request failed"),
        retry: true,
      };
    } finally {
      registry.adjustInflight(workerId, -1);
    }
  }
}

function workerUrl(addr: string, path: string): string {
  const base = hasScheme(addr) ? addr : `http://${addr}`;
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function textResult(status: number, message: string): DispatchResult {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
    body: Buffer.from(message, "utf-8"),
  };
}
