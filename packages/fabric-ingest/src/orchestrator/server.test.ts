import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createOrchestratorServer, type OrchestratorServer } from "./server.js";

const running: OrchestratorServer[] = [];
const runningWorkers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (running.length > 0) {
    const s = running.pop();
    if (s) {
      await s.close();
    }
  }
  while (runningWorkers.length > 0) {
    const w = runningWorkers.pop();
    if (w) {
      await w.close();
    }
  }
});

describe("Orchestrator server", () => {
  it("rejects non-loopback bind without auth token", () => {
    expect(() => createOrchestratorServer({
      publicHost: "0.0.0.0",
      publicPort: 0,
      internalPort: 0,
    })).toThrow(/without auth token/i);
  });

  it("requires token for internal and admin APIs when configured", async () => {
    const authToken = "test-orch-token";
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      authToken,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const unauthorizedRegister = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 4,
      }),
    });
    expect(unauthorizedRegister.status).toBe(401);

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ax-orchestrator-token": authToken,
      },
      body: JSON.stringify({
        worker_id: "worker-auth",
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 4,
      }),
    });
    expect(registerRes.status).toBe(200);

    const unauthorizedList = await fetch(`${publicBase}/v1/workers`);
    expect(unauthorizedList.status).toBe(401);

    const authorizedList = await fetch(`${publicBase}/v1/workers`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(authorizedList.status).toBe(200);
  });

  it("allows register with empty capabilities", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: "127.0.0.1:28081",
        capabilities: [],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);
  });

  it("reports degraded health when no eligible workers are available", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
    });
    running.push(server);
    const ports = await server.start();

    const publicBase = `http://127.0.0.1:${ports.publicPort}`;
    const healthRes = await fetch(`${publicBase}/health`);
    expect(healthRes.status).toBe(200);
    const body = await healthRes.json() as { status: string; eligible_workers: number };
    expect(body.status).toBe("degraded");
    expect(body.eligible_workers).toBe(0);
  });

  it("registers, heartbeats, lists, and removes workers", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 500,
      ttlMs: 2_000,
      tickIntervalMs: 200,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);
    const registerBody = (await registerRes.json()) as { worker_id: string; heartbeat_interval_ms: number };
    expect(registerBody.worker_id.length).toBeGreaterThan(0);
    expect(registerBody.heartbeat_interval_ms).toBe(500);

    const hbRes = await fetch(`${internalBase}/internal/workers/${encodeURIComponent(registerBody.worker_id)}/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inflight: 2,
        thermal_state: "nominal",
        model_ids: ["default"],
        rss_bytes: 1000,
      }),
    });
    expect(hbRes.status).toBe(200);

    const listInternalRes = await fetch(`${internalBase}/internal/workers`);
    expect(listInternalRes.status).toBe(200);
    const listInternalBody = (await listInternalRes.json()) as { workers: Array<{ id: string; inflight: number }> };
    expect(listInternalBody.workers).toHaveLength(1);
    expect(listInternalBody.workers[0]?.id).toBe(registerBody.worker_id);
    expect(listInternalBody.workers[0]?.inflight).toBe(2);

    const healthRes = await fetch(`${publicBase}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { workers: { total: number } };
    expect(healthBody.workers.total).toBe(1);

    const removeRes = await fetch(`${publicBase}/v1/workers/${encodeURIComponent(registerBody.worker_id)}`, {
      method: "DELETE",
    });
    expect(removeRes.status).toBe(204);

    const listPublicRes = await fetch(`${publicBase}/v1/workers`);
    expect(listPublicRes.status).toBe(200);
    const listPublicBody = (await listPublicRes.json()) as { workers: unknown[] };
    expect(listPublicBody.workers).toHaveLength(0);
  });

  it("evicts stale workers via ttl ticker", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 100,
      ttlMs: 300,
      tickIntervalMs: 50,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: "127.0.0.1:28081",
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    const registerBody = (await registerRes.json()) as { worker_id: string };

    await waitFor(async () => {
      const getRes = await fetch(`${internalBase}/internal/workers/${encodeURIComponent(registerBody.worker_id)}`);
      return getRes.status === 404;
    }, 1_500);
  });

  it("proxies /v1/completions to eligible worker", async () => {
    const worker = createStubWorkerServer({ port: 0, name: "worker-a" });
    runningWorkers.push(worker);
    await worker.start();
    const workerPort = worker.port();

    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 500,
      ttlMs: 2_000,
      globalQueueMax: 4,
      globalQueueDepth: 4,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: `127.0.0.1:${workerPort}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);

    const response = await fetch(`${publicBase}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", prompt: "hello" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; path: string; worker: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/v1/completions");
    expect(body.worker).toBe("worker-a");
  });

  it("supports internal drain and drain-complete lifecycle", async () => {
    const worker = createStubWorkerServer({ port: 0, name: "worker-a" });
    runningWorkers.push(worker);
    await worker.start();

    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker_id: "worker-a",
        addr: `127.0.0.1:${worker.port()}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);

    const drainRes = await fetch(`${internalBase}/internal/workers/worker-a/drain`, { method: "POST" });
    expect(drainRes.status).toBe(200);

    const getRes = await fetch(`${internalBase}/internal/workers/worker-a`);
    expect(getRes.status).toBe(200);
    const drained = (await getRes.json()) as { drain: boolean };
    expect(drained.drain).toBe(true);

    const shouldNotRoute = await fetch(`${publicBase}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", prompt: "hello" }),
    });
    expect(shouldNotRoute.status).toBe(503);

    const drainComplete = await fetch(`${internalBase}/internal/workers/worker-a/drain-complete`, { method: "POST" });
    expect(drainComplete.status).toBe(204);

    const getAfter = await fetch(`${internalBase}/internal/workers/worker-a`);
    expect(getAfter.status).toBe(404);
  });

  it("proxies /v1/chat/completions to eligible worker", async () => {
    const worker = createStubWorkerServer({ port: 0, name: "worker-chat" });
    runningWorkers.push(worker);
    await worker.start();

    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 500,
      ttlMs: 2_000,
      globalQueueMax: 4,
      globalQueueDepth: 4,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: `127.0.0.1:${worker.port()}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);

    const response = await fetch(`${publicBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; path: string; worker: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/v1/chat/completions");
    expect(body.worker).toBe("worker-chat");
  });

  it("reroutes to fallback worker when primary returns 5xx", async () => {
    const workerA = createStubWorkerServer({ port: 0, name: "worker-a", status: 500 });
    const workerB = createStubWorkerServer({ port: 0, name: "worker-b", status: 200 });
    runningWorkers.push(workerA, workerB);
    await workerA.start();
    await workerB.start();

    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      dispatchPolicy: "least_inflight",
      globalQueueMax: 4,
      globalQueueDepth: 4,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerA = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker_id: "a",
        addr: `127.0.0.1:${workerA.port()}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    const registerB = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker_id: "b",
        addr: `127.0.0.1:${workerB.port()}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerA.status).toBe(200);
    expect(registerB.status).toBe(200);

    const response = await fetch(`${publicBase}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", prompt: "hello" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; worker: string };
    expect(body.ok).toBe(true);
    expect(body.worker).toBe("worker-b");
  });

  it("returns 429 when queue is saturated with reject policy", async () => {
    const slowWorker = createStubWorkerServer({ port: 0, name: "slow", delayMs: 200 });
    runningWorkers.push(slowWorker);
    await slowWorker.start();

    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      globalQueueMax: 1,
      globalQueueDepth: 0,
      globalQueuePolicy: "reject",
      retryAfterSecs: 7,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const publicBase = `http://127.0.0.1:${ports.publicPort}`;

    const registerRes = await fetch(`${internalBase}/internal/workers/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        addr: `127.0.0.1:${slowWorker.port()}`,
        capabilities: ["default"],
        max_inflight: 8,
      }),
    });
    expect(registerRes.status).toBe(200);

    const first = fetch(`${publicBase}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", prompt: "first" }),
    });

    await sleep(25);

    const second = await fetch(`${publicBase}/v1/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", prompt: "second" }),
    });

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("7");

    const firstRes = await first;
    expect(firstRes.status).toBe(200);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    if (await check()) {
      return;
    }
    await sleep(25);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

function createStubWorkerServer(config: {
  port: number;
  name: string;
  status?: number;
  delayMs?: number;
}): {
  start: () => Promise<void>;
  close: () => Promise<void>;
  port: () => number;
} {
  const status = config.status ?? 200;
  const delayMs = Math.max(0, config.delayMs ?? 0);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const send = () => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          ok: status < 500,
          worker: config.name,
          path: req.url,
          bytes: Buffer.concat(chunks).length,
        }));
      };
      if (delayMs > 0) {
        setTimeout(send, delayMs);
      } else {
        send();
      }
    });
  });

  return {
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
    port: () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") return 0;
      return addr.port;
    },
  };
}
