import { afterEach, describe, expect, it } from "vitest";

import { createOrchestratorServer, type OrchestratorServer } from "./server.js";
import { WorkerLifecycleClient } from "./worker-client.js";

const running: OrchestratorServer[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop();
    if (server) {
      await server.close();
    }
  }
});

describe("WorkerLifecycleClient", () => {
  it("registers and sends heartbeat", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 100,
      ttlMs: 1_000,
      tickIntervalMs: 50,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const client = new WorkerLifecycleClient({
      orchestratorAddr: internalBase,
      selfAddr: "127.0.0.1:28081",
      capabilities: ["default"],
      maxInflight: 8,
    });

    const reg = await client.register();
    const hb = await client.heartbeat(reg.worker_id, {
      inflight: 1,
      model_ids: ["default"],
      thermal_state: "nominal",
      rss_bytes: 123,
    });
    expect(hb.status).toBe(200);

    const workerRes = await fetch(`${internalBase}/internal/workers/${encodeURIComponent(reg.worker_id)}`);
    expect(workerRes.status).toBe(200);
    const worker = await workerRes.json() as { inflight: number };
    expect(worker.inflight).toBe(1);
  });

  it("sends auth token headers when orchestrator auth is enabled", async () => {
    const token = "worker-auth-token";
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      authToken: token,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const client = new WorkerLifecycleClient({
      orchestratorAddr: internalBase,
      orchestratorToken: token,
      selfAddr: "127.0.0.1:28081",
      capabilities: ["default"],
      maxInflight: 8,
    });

    const reg = await client.register();
    const hb = await client.heartbeat(reg.worker_id, {
      inflight: 1,
      model_ids: ["default"],
    });
    expect(hb.status).toBe(200);
  });

  it("auto re-registers on heartbeat 404", async () => {
    const server = createOrchestratorServer({
      publicPort: 0,
      internalPort: 0,
      heartbeatIntervalMs: 80,
      ttlMs: 1_000,
      tickIntervalMs: 40,
    });
    running.push(server);

    const ports = await server.start();
    const internalBase = `http://127.0.0.1:${ports.internalPort}`;
    const client = new WorkerLifecycleClient({
      orchestratorAddr: internalBase,
      selfAddr: "127.0.0.1:28082",
      capabilities: ["default"],
      maxInflight: 8,
    });

    const registrations: string[] = [];
    const loop = client.startHeartbeatLoop({
      minIntervalMs: 40,
      getHeartbeat: () => ({
        inflight: 0,
        model_ids: ["default"],
        thermal_state: "nominal",
        rss_bytes: 1,
      }),
      onRegistered: (workerId) => {
        registrations.push(workerId);
      },
    });

    await waitFor(() => registrations.length >= 1, 1_500);
    const firstId = registrations[0];
    expect(firstId).toBeTruthy();

    const removeRes = await fetch(`${internalBase}/internal/workers/${encodeURIComponent(firstId!)}`, {
      method: "DELETE",
    });
    expect(removeRes.status).toBe(204);

    await waitFor(() => registrations.length >= 2, 2_000);
    expect(loop.workerId()).toBe(registrations[registrations.length - 1]);

    loop.stop();
    await loop.done;
  });

  it("stop aborts in-flight heartbeat requests", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({ worker_id: "worker-1", heartbeat_interval_ms: 50 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };

    const client = new WorkerLifecycleClient({
      orchestratorAddr: "http://127.0.0.1:19090",
      selfAddr: "127.0.0.1:28083",
      capabilities: ["default"],
      maxInflight: 8,
    }, fetchImpl);

    const loop = client.startHeartbeatLoop({
      minIntervalMs: 10,
      getHeartbeat: () => ({ inflight: 0, model_ids: ["default"] }),
    });

    await waitFor(() => callCount >= 2, 500);
    loop.stop();
    await Promise.race([
      loop.done,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("loop did not stop")), 500)),
    ]);
  });

  it("retries re-registration after transient failure", async () => {
    let phase: "register-1" | "heartbeat-404" | "register-fail" | "register-ok" | "heartbeat-ok" = "register-1";
    let registerCalls = 0;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/internal/workers/register")) {
        registerCalls += 1;
        if (phase === "register-1") {
          phase = "heartbeat-404";
          return new Response(JSON.stringify({ worker_id: "w1", heartbeat_interval_ms: 30 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (phase === "register-fail") {
          phase = "register-ok";
          return new Response("fail", { status: 500 });
        }
        return new Response(JSON.stringify({ worker_id: "w2", heartbeat_interval_ms: 30 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/heartbeat")) {
        if (phase === "heartbeat-404") {
          phase = "register-fail";
          return new Response("missing", { status: 404 });
        }
        phase = "heartbeat-ok";
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      void init;
      return new Response("not found", { status: 404 });
    };

    const client = new WorkerLifecycleClient({
      orchestratorAddr: "http://127.0.0.1:19090",
      selfAddr: "127.0.0.1:28084",
      capabilities: ["default"],
      maxInflight: 8,
    }, fetchImpl);

    const loop = client.startHeartbeatLoop({
      minIntervalMs: 10,
      getHeartbeat: () => ({ inflight: 0, model_ids: ["default"] }),
    });

    await waitFor(() => phase === "heartbeat-ok", 1_000);
    expect(registerCalls).toBeGreaterThanOrEqual(3);

    loop.stop();
    await loop.done;
  });

  it("treats drain and drain-complete as idempotent on 404", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/drain") || url.endsWith("/drain-complete")) {
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new WorkerLifecycleClient({
      orchestratorAddr: "http://127.0.0.1:19090",
      selfAddr: "127.0.0.1:28085",
      capabilities: ["default"],
      maxInflight: 8,
    }, fetchImpl);

    await expect(client.drain("missing-worker")).resolves.toBeUndefined();
    await expect(client.drainComplete("missing-worker")).resolves.toBeUndefined();
  });

  it("continues heartbeat loop after transient non-404 heartbeat failure", async () => {
    let heartbeatCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/internal/workers/register")) {
        return new Response(
          JSON.stringify({ worker_id: "worker-3", heartbeat_interval_ms: 20 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/heartbeat")) {
        heartbeatCalls += 1;
        if (heartbeatCalls === 1) {
          return new Response("temporary", { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const client = new WorkerLifecycleClient({
      orchestratorAddr: "http://127.0.0.1:19090",
      selfAddr: "127.0.0.1:28086",
      capabilities: ["default"],
      maxInflight: 8,
    }, fetchImpl);

    const loop = client.startHeartbeatLoop({
      minIntervalMs: 10,
      getHeartbeat: () => ({ inflight: 0, model_ids: ["default"] }),
    });

    await waitFor(() => heartbeatCalls >= 2, 600);
    loop.stop();
    await loop.done;
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition not met before timeout");
}
