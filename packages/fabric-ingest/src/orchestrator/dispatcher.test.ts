/**
 * Unit tests for DirectDispatcher — routing, fallback, and error handling.
 *
 * Uses vi.stubGlobal to mock the global `fetch` so no real HTTP calls are made.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DirectDispatcher } from "./dispatcher.js";
import type { DispatchPolicy } from "./policy.js";
import type { WorkerRegistry } from "./registry.js";
import type { WorkerStatus } from "./registry.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorker(id: string, overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    id,
    addr: `127.0.0.1:1800${id}`,
    inflight: 0,
    max_inflight: 8,
    capabilities: ["default"],
    ...overrides,
  };
}

function makeMockRegistry(workers: WorkerStatus[]): WorkerRegistry {
  const registry: Partial<WorkerRegistry> = {
    eligibleWorkers: vi.fn().mockImplementation((_modelId: string) => workers),
    adjustInflight: vi.fn(),
    markUnhealthy: vi.fn(),
  };
  return registry as WorkerRegistry;
}

function makeSuccessResponse(body = "{}") {
  return {
    status: 200,
    headers: { get: () => "application/json" },
    arrayBuffer: () => Promise.resolve(Buffer.from(body).buffer),
  };
}

function makeErrorResponse(status: number) {
  return {
    status,
    headers: { get: () => "application/json" },
    arrayBuffer: () => Promise.resolve(Buffer.from("error").buffer),
  };
}

// ─── Policy stub ─────────────────────────────────────────────────────────────

function makePolicyAlwaysSelectFirst(): DispatchPolicy {
  return {
    select: (workers) => workers[0] ?? null,
    recordDispatch: vi.fn(),
  };
}

function makePolicyAlwaysReturnNull(): DispatchPolicy {
  return {
    select: () => null,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("DirectDispatcher", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 503 when there are no eligible workers", async () => {
    const registry = makeMockRegistry([]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    const result = await dispatcher.forward(registry, "default", "/v1/chat/completions", Buffer.from("{}"), {});
    expect(result.status).toBe(503);
    expect(result.body.toString()).toContain("no eligible workers");
  });

  it("returns 503 when policy selects no worker (all at capacity)", async () => {
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysReturnNull());

    const result = await dispatcher.forward(registry, "default", "/v1/chat/completions", Buffer.from("{}"), {});
    expect(result.status).toBe(503);
    expect(result.body.toString()).toContain("at capacity");
  });

  it("forwards request to selected worker and returns 200", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse('{"id":"resp-1"}'));
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    const result = await dispatcher.forward(registry, "default", "/v1/chat/completions", Buffer.from("{}"), {});
    expect(result.status).toBe(200);
    expect(result.body.toString()).toContain("resp-1");
  });

  it("calls adjustInflight +1 before request and -1 after", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    await dispatcher.forward(registry, "default", "/", Buffer.from(""), {});

    expect(registry.adjustInflight).toHaveBeenCalledWith(worker.id, 1);
    expect(registry.adjustInflight).toHaveBeenCalledWith(worker.id, -1);
  });

  it("calls recordDispatch on success", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const policy = makePolicyAlwaysSelectFirst();
    const dispatcher = new DirectDispatcher(policy);

    await dispatcher.forward(registry, "default", "/", Buffer.from(""), {});

    expect(policy.recordDispatch).toHaveBeenCalledWith(worker.id, "default");
  });

  it("marks worker unhealthy and retries on 5xx response", async () => {
    const worker1 = makeWorker("1");
    const worker2 = makeWorker("2");
    // First call → 500; second call → 200
    fetchMock
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeSuccessResponse());

    let callCount = 0;
    const policy: DispatchPolicy = {
      select: (workers) => {
        const picked = workers[callCount % workers.length] ?? null;
        callCount++;
        return picked;
      },
      recordDispatch: vi.fn(),
    };

    // Registry returns both workers initially, then only worker2 after worker1 is excluded
    const registry: Partial<WorkerRegistry> = {
      eligibleWorkers: vi
        .fn()
        .mockReturnValueOnce([worker1, worker2])
        .mockReturnValueOnce([worker2]),
      adjustInflight: vi.fn(),
      markUnhealthy: vi.fn(),
    };

    const dispatcher = new DirectDispatcher(policy);
    const result = await dispatcher.forward(
      registry as WorkerRegistry,
      "default",
      "/",
      Buffer.from(""),
      {},
    );

    expect(registry.markUnhealthy).toHaveBeenCalledWith(worker1.id);
    expect(result.status).toBe(200);
  });

  it("returns 503 when both primary and fallback workers fail", async () => {
    const worker1 = makeWorker("1");
    const worker2 = makeWorker("2");
    fetchMock.mockRejectedValue(new Error("network error"));

    let selectCall = 0;
    const policy: DispatchPolicy = {
      select: (workers) => {
        const picked = workers[selectCall % Math.max(1, workers.length)] ?? null;
        selectCall++;
        return picked;
      },
    };

    const registry: Partial<WorkerRegistry> = {
      eligibleWorkers: vi
        .fn()
        .mockReturnValueOnce([worker1, worker2])
        .mockReturnValueOnce([worker2]),
      adjustInflight: vi.fn(),
      markUnhealthy: vi.fn(),
    };

    const dispatcher = new DirectDispatcher(policy);
    const result = await dispatcher.forward(
      registry as WorkerRegistry,
      "default",
      "/",
      Buffer.from(""),
      {},
    );

    expect(result.status).toBe(503);
    expect(result.body.toString()).toContain("all workers failed");
  });

  it("returns 503 when primary fails and no fallback worker available", async () => {
    const worker = makeWorker("1");
    fetchMock.mockRejectedValue(new Error("connection refused"));

    const registry: Partial<WorkerRegistry> = {
      eligibleWorkers: vi
        .fn()
        .mockReturnValueOnce([worker])
        .mockReturnValueOnce([]), // no fallback
      adjustInflight: vi.fn(),
      markUnhealthy: vi.fn(),
    };

    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());
    const result = await dispatcher.forward(
      registry as WorkerRegistry,
      "default",
      "/",
      Buffer.from(""),
      {},
    );

    expect(result.status).toBe(503);
    expect(result.body.toString()).toContain("no alternative worker");
  });

  it("passes Authorization header when provided", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    await dispatcher.forward(
      registry,
      "default",
      "/v1/chat/completions",
      Buffer.from("{}"),
      { authorization: "Bearer test-token" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("127.0.0.1"),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer test-token" }),
      }),
    );
  });

  it("path without leading slash is handled correctly", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    await dispatcher.forward(registry, "default", "v1/completions", Buffer.from(""), {});

    const calledUrl: string = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1.*\/v1\/completions/);
  });

  it("path with leading slash is handled correctly", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1");
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    await dispatcher.forward(registry, "default", "/v1/completions", Buffer.from(""), {});

    const calledUrl: string = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toMatch(/^http:\/\/127\.0\.0\.1.*\/v1\/completions/);
  });

  it("preserves https worker base url when worker addr includes scheme", async () => {
    fetchMock.mockResolvedValue(makeSuccessResponse());
    const worker = makeWorker("1", { addr: "https://worker.example.com:443/base" });
    const registry = makeMockRegistry([worker]);
    const dispatcher = new DirectDispatcher(makePolicyAlwaysSelectFirst());

    await dispatcher.forward(registry, "default", "/v1/completions", Buffer.from(""), {});

    const calledUrl: string = (fetchMock.mock.calls[0] as unknown[])[0] as string;
    expect(calledUrl).toBe("https://worker.example.com:443/base/v1/completions");
  });
});
