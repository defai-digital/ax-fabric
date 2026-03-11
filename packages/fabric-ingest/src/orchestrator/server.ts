import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";

import { DirectDispatcher } from "./dispatcher.js";
import { policyFromName } from "./policy.js";
import { GlobalQueue } from "./queue.js";
import {
  WorkerRegistry,
  type HeartbeatRequest,
  type RegisterRequest,
} from "./registry.js";

interface ServerLike {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: string, listeningListener: () => void): unknown;
  close(callback: (err?: Error) => void): unknown;
  address(): string | AddressInfo | null;
}

export interface ServerBinding {
  server: ServerLike;
  port: number;
  host: string;
}

export interface OrchestratorServerConfig {
  publicHost?: string;
  publicPort?: number;
  internalHost?: string;
  internalPort?: number;
  authToken?: string;
  heartbeatIntervalMs?: number;
  ttlMs?: number;
  tickIntervalMs?: number;
  dispatchPolicy?: "least_inflight" | "weighted_round_robin" | "model_affinity";
  globalQueueMax?: number;
  globalQueueDepth?: number;
  globalQueueWaitMs?: number;
  globalQueuePolicy?: "reject" | "shed_oldest";
  retryAfterSecs?: number;
}

export interface OrchestratorServerPorts {
  publicPort: number;
  internalPort: number;
}

export interface OrchestratorServer {
  readonly registry: WorkerRegistry;
  start: () => Promise<OrchestratorServerPorts>;
  close: () => Promise<void>;
  ports: () => OrchestratorServerPorts;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

export function createOrchestratorServer(config: OrchestratorServerConfig = {}): OrchestratorServer {
  const registry = new WorkerRegistry();
  const heartbeatIntervalMs = Math.max(250, config.heartbeatIntervalMs ?? 5_000);
  const ttlMs = Math.max(heartbeatIntervalMs * 2, config.ttlMs ?? 15_000);
  const tickIntervalMs = Math.max(100, config.tickIntervalMs ?? Math.floor(heartbeatIntervalMs / 2));

  const publicHost = config.publicHost ?? "127.0.0.1";
  const publicPort = config.publicPort ?? 18080;
  const internalHost = config.internalHost ?? "127.0.0.1";
  const internalPort = config.internalPort ?? 19090;
  const authToken = normalizeToken(config.authToken ?? process.env["AX_FABRIC_ORCHESTRATOR_TOKEN"]);
  const retryAfterSecs = Math.max(1, config.retryAfterSecs ?? 5);

  if ((isNonLoopbackHost(publicHost) || isNonLoopbackHost(internalHost)) && !authToken) {
    throw new Error(
      "Refusing to bind orchestrator to non-loopback host without auth token. " +
      "Set --auth-token, --auth-token-env, or AX_FABRIC_ORCHESTRATOR_TOKEN.",
    );
  }

  const queue = new GlobalQueue({
    maxConcurrent: Math.max(1, config.globalQueueMax ?? 128),
    maxQueueDepth: Math.max(0, config.globalQueueDepth ?? 256),
    waitMs: Math.max(1, config.globalQueueWaitMs ?? 10_000),
    overloadPolicy: config.globalQueuePolicy ?? "reject",
  });
  const dispatcher = new DirectDispatcher(policyFromName(config.dispatchPolicy));

  const publicServer = createServer((req, res) => {
    handlePublic(req, res, registry, heartbeatIntervalMs, ttlMs, queue, dispatcher, retryAfterSecs, authToken).catch((error: unknown) => {
      if (res.headersSent) return;
      try {
        if (error instanceof BadRequestError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        sendJson(res, 500, { error: toErrorMessage(error) });
      } catch {
        res.destroy();
      }
    });
  });

  const internalServer = createServer((req, res) => {
    handleInternal(req, res, registry, heartbeatIntervalMs, authToken).catch((error: unknown) => {
      if (res.headersSent) return;
      try {
        if (error instanceof BadRequestError) {
          sendJson(res, 400, { error: error.message });
          return;
        }
        sendJson(res, 500, { error: toErrorMessage(error) });
      } catch {
        res.destroy();
      }
    });
  });

  let ticker: NodeJS.Timeout | null = null;
  let tickRunning = false;

  async function start(): Promise<OrchestratorServerPorts> {
    await startServerBindings([
      { server: publicServer, port: publicPort, host: publicHost },
      { server: internalServer, port: internalPort, host: internalHost },
    ]);

    ticker = setInterval(() => {
      if (tickRunning) {
        return;
      }
      tickRunning = true;
      void runHealthTick(registry, ttlMs).catch((err: unknown) => {
        console.error("[orchestrator] health tick error:", err instanceof Error ? err.message : String(err));
      }).finally(() => {
        tickRunning = false;
      });
    }, tickIntervalMs);

    return ports();
  }

  async function close(): Promise<void> {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    await Promise.all([closeServer(publicServer), closeServer(internalServer)]);
  }

  function ports(): OrchestratorServerPorts {
    return {
      publicPort: getPort(publicServer),
      internalPort: getPort(internalServer),
    };
  }

  return {
    registry,
    start,
    close,
    ports,
  };
}

async function handlePublic(
  req: IncomingMessage,
  res: ServerResponse,
  registry: WorkerRegistry,
  heartbeatIntervalMs: number,
  ttlMs: number,
  queue: GlobalQueue,
  dispatcher: DirectDispatcher,
  retryAfterSecs: number,
  authToken?: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (method === "GET" && pathname === "/health") {
    const eligible = registry.eligibleHealthyCount();
    sendJson(res, 200, {
      status: eligible > 0 ? "ok" : "degraded",
      workers: registry.counts(),
      eligible_workers: eligible,
      heartbeat_interval_ms: heartbeatIntervalMs,
      ttl_ms: ttlMs,
    });
    return;
  }

  if (method === "GET" && pathname === "/v1/workers") {
    if (!requireAuthIfConfigured(req, res, authToken)) return;
    sendJson(res, 200, { workers: registry.listAll() });
    return;
  }

  if (method === "DELETE" && pathname.startsWith("/v1/workers/")) {
    if (!requireAuthIfConfigured(req, res, authToken)) return;
    const workerId = decodeURIComponent(pathname.slice("/v1/workers/".length));
    if (!registry.markDrain(workerId)) {
      sendJson(res, 404, { error: "worker not found" });
      return;
    }
    registry.evict(workerId);
    res.statusCode = 204;
    res.end();
    return;
  }

  if (method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/v1/completions")) {
    const body = await readRawBody(req);
    const modelId = modelFromBody(body) ?? "default";
    const path = pathname;

    const acquire = await queue.acquire();
    if (acquire.kind === "rejected") {
      sendText(res, 429, "request rejected: concurrency limit exceeded", {
        "x-queue-depth": String(queue.queueDepth()),
        "retry-after": String(retryAfterSecs),
      });
      return;
    }
    if (acquire.kind === "shed") {
      sendText(res, 503, "request shed: queue overload", { "x-reason": "request_shed" });
      return;
    }
    if (acquire.kind === "timeout") {
      sendText(res, 503, "request timed out waiting for a queue slot", { "x-reason": "queue_timeout" });
      return;
    }

    const headers = getForwardHeaders(req);
    try {
      const out = await dispatcher.forward(registry, modelId, path, body, headers);
      sendBuffer(res, out.status, out.body, out.headers);
      return;
    } finally {
      acquire.permit.release();
    }
  }

  sendJson(res, 404, { error: "not found" });
}

async function handleInternal(
  req: IncomingMessage,
  res: ServerResponse,
  registry: WorkerRegistry,
  heartbeatIntervalMs: number,
  authToken?: string,
): Promise<void> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (!requireAuthIfConfigured(req, res, authToken)) {
    return;
  }

  if (method === "POST" && pathname === "/internal/workers/register") {
    const body = await readJsonBody(req);
    const parsed = parseRegisterRequest(body);
    if ("error" in parsed) {
      sendJson(res, 400, { error: parsed.error });
      return;
    }
    const out = registry.register(parsed.value, heartbeatIntervalMs);
    sendJson(res, 200, out);
    return;
  }

  if (method === "GET" && pathname === "/internal/workers") {
    sendJson(res, 200, { workers: registry.listAll() });
    return;
  }

  const match = pathname.match(/^\/internal\/workers\/([^/]+)(\/heartbeat|\/drain|\/drain-complete)?$/);
  if (match) {
    const workerId = decodeURIComponent(match[1] ?? "").trim();
    if (!workerId) {
      sendJson(res, 400, { error: "worker id must not be empty" });
      return;
    }
    const suffix = match[2] ?? "";

    if (method === "GET" && suffix === "") {
      const worker = registry.get(workerId);
      if (!worker) {
        sendJson(res, 404, { error: "worker not found" });
        return;
      }
      sendJson(res, 200, worker);
      return;
    }

    if (method === "POST" && suffix === "/heartbeat") {
      const body = await readJsonBody(req);
      const parsed = parseHeartbeatRequest(body);
      if ("error" in parsed) {
        sendJson(res, 400, { error: parsed.error });
        return;
      }
      if (!registry.heartbeat(workerId, parsed.value)) {
        sendJson(res, 404, { error: "worker not found" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && suffix === "/drain") {
      if (!registry.markDrain(workerId)) {
        sendJson(res, 404, { error: "worker not found" });
        return;
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && suffix === "/drain-complete") {
      registry.evict(workerId);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === "DELETE" && suffix === "") {
      if (!registry.markDrain(workerId)) {
        sendJson(res, 404, { error: "worker not found" });
        return;
      }
      registry.evict(workerId);
      res.statusCode = 204;
      res.end();
      return;
    }
  }

  sendJson(res, 404, { error: "not found" });
}

export function parseHeartbeatRequest(body: unknown): { ok: true; value: HeartbeatRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid body" };
  }

  const value = body as Record<string, unknown>;
  const inflight = typeof value["inflight"] === "number" ? value["inflight"] : Number.NaN;
  if (!Number.isInteger(inflight) || inflight < 0) {
    return { ok: false, error: "inflight must be an integer >= 0" };
  }

  const rssBytesRaw = value["rss_bytes"];
  const rssBytes = typeof rssBytesRaw === "number" ? rssBytesRaw : undefined;
  if (rssBytes !== undefined && (!Number.isInteger(rssBytes) || rssBytes < 0)) {
    return { ok: false, error: "rss_bytes must be an integer >= 0" };
  }

  return {
    ok: true,
    value: {
      inflight,
      thermal_state: normalizedOptionalString(value["thermal_state"]),
      model_ids: Array.isArray(value["model_ids"])
        ? value["model_ids"]
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0)
        : undefined,
      rss_bytes: rssBytes,
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const bodyText = (await readRawBody(req)).toString("utf-8").trim();
  if (!bodyText) {
    return {};
  }
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    throw new BadRequestError("invalid JSON body");
  }
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buf.length;
    if (totalSize > MAX_BODY_BYTES) {
      req.socket?.destroy();
      throw new BadRequestError("request body too large (max 10 MB)");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function modelFromBody(body: Buffer): string | null {
  try {
    const parsed = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
    const model = parsed["model"];
    return typeof model === "string" && model.trim().length > 0 ? model.trim() : null;
  } catch {
    return null;
  }
}

function getForwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const contentType = req.headers["content-type"];
  if (typeof contentType === "string") {
    out["content-type"] = contentType;
  }
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    out["authorization"] = auth;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(JSON_HEADERS)) {
    res.setHeader(key, value);
  }
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  sendBuffer(res, status, Buffer.from(text, "utf-8"), {
    "content-type": "text/plain; charset=utf-8",
    ...headers,
  });
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, headers: Record<string, string>): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value);
  }
  res.end(body);
}

function normalizedOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validatePositiveInteger(value: unknown, field: string): number | { error: string } {
  if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) {
    return { error: `${field} must be an integer > 0` };
  }
  return value;
}

export function parseRegisterRequest(body: unknown): { ok: true; value: RegisterRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "invalid body" };
  }

  const value = body as Record<string, unknown>;
  const addr = typeof value["addr"] === "string" ? value["addr"].trim() : "";
  const capabilities = Array.isArray(value["capabilities"])
    ? value["capabilities"]
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
    : [];
  const maxInflight = validatePositiveInteger(value["max_inflight"], "max_inflight");

  if (!addr) {
    return { ok: false, error: "missing field: addr" };
  }
  if (typeof maxInflight !== "number") {
    return { ok: false, error: maxInflight.error };
  }

  return {
    ok: true,
    value: {
      worker_id: normalizedOptionalString(value["worker_id"]),
      addr,
      capabilities,
      backend: normalizedOptionalString(value["backend"]),
      max_inflight: maxInflight,
      friendly_name: normalizedOptionalString(value["friendly_name"]),
      chip_model: normalizedOptionalString(value["chip_model"]),
    },
  };
}

function listen(server: ServerLike, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ServerLike): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
          return;
        }
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function getPort(server: ServerLike): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    return 0;
  }
  return (address as AddressInfo).port;
}

export async function startServerBindings(bindings: readonly ServerBinding[]): Promise<void> {
  const started: ServerLike[] = [];
  try {
    for (const binding of bindings) {
      await listen(binding.server, binding.port, binding.host);
      started.push(binding.server);
    }
  } catch (error) {
    await Promise.all(started.map((server) => closeServer(server).catch(() => undefined)));
    throw error;
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

class BadRequestError extends Error {}

function normalizeToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = value.trim();
  return t.length > 0 ? t : undefined;
}

function isNonLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !(
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function requireAuthIfConfigured(
  req: IncomingMessage,
  res: ServerResponse,
  authToken?: string,
): boolean {
  if (!authToken) {
    return true;
  }

  const provided = tokenFromHeaders(req);
  if (!provided || !tokensEqual(provided, authToken)) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
}

function tokenFromHeaders(req: IncomingMessage): string | null {
  const direct = req.headers["x-ax-orchestrator-token"];
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) {
      return m[1].trim();
    }
  }
  return null;
}

async function runHealthTick(registry: WorkerRegistry, ttlMs: number): Promise<void> {
  registry.tick(ttlMs);
  const candidates = registry.listUnhealthyAddresses();
  if (candidates.length === 0) {
    return;
  }
  await Promise.all(candidates.map(async (candidate) => {
    const reachable = await probeTcpReachable(candidate.addr, 1_000);
    if (!reachable) {
      registry.evict(candidate.id);
    }
  }));
}

async function probeTcpReachable(addr: string, timeoutMs: number): Promise<boolean> {
  const parsed = parseHostPort(addr);
  if (!parsed) {
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    try {
      socket.connect(parsed.port, parsed.host);
    } catch {
      // socket.connect() throws synchronously for invalid arguments (e.g. port out of range).
      // The registered "error" handler won't fire in that case, so we resolve here.
      finish(false);
    }
  });
}

export function parseHostPort(addr: string): { host: string; port: number } | null {
  const trimmed = addr.trim();
  if (!trimmed) {
    return null;
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (!url.hostname || !url.port) {
        return null;
      }
      const port = Number.parseInt(url.port, 10);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        return null;
      }
      return { host: url.hostname, port };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing <= 1 || trimmed[closing + 1] !== ":") {
      return null;
    }
    const host = trimmed.slice(1, closing);
    const portText = trimmed.slice(closing + 2);
    if (!/^\d+$/.test(portText)) {
      return null;
    }
    const port = Number.parseInt(portText, 10);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      return null;
    }
    return { host, port };
  }

  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0 || idx >= trimmed.length - 1) {
    return null;
  }
  const host = trimmed.slice(0, idx);
  const portText = trimmed.slice(idx + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }
  const port = Number.parseInt(portText, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return null;
  }
  return { host, port };
}
