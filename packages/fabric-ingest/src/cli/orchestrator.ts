import type { Command } from "commander";

import { createOrchestratorServer } from "../orchestrator/server.js";
import { loadConfig, resolveToken } from "./config-loader.js";
import {
  DEFAULT_LOCALHOST,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_INTERNAL_PORT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WORKER_TTL_MS,
  DEFAULT_RETRY_AFTER_SECS,
  ORCHESTRATOR_QUEUE_MAX,
  ORCHESTRATOR_QUEUE_DEPTH,
  ORCHESTRATOR_QUEUE_WAIT_MS,
} from "../constants.js";

export function registerOrchestratorCommand(program: Command): void {
  program
    .command("orchestrator")
    .description("Run ax-fabric worker orchestrator")
    .command("start")
    .description("Start public/internal worker orchestration APIs")
    .option("-c, --config <path>", "Config file path")
    .option("--public-host <host>", `Public API host (default: config.orchestrator.public_host or ${DEFAULT_LOCALHOST})`)
    .option("--public-port <port>", `Public API port (default: config.orchestrator.public_port or ${DEFAULT_PUBLIC_PORT})`)
    .option("--internal-host <host>", `Internal worker API host (default: config.orchestrator.internal_host or ${DEFAULT_LOCALHOST})`)
    .option("--internal-port <port>", `Internal worker API port (default: config.orchestrator.internal_port or ${DEFAULT_INTERNAL_PORT})`)
    .option("--auth-token <token>", "Auth token for internal/admin APIs")
    .option("--auth-token-env <env>", "Env var name containing auth token")
    .option("--heartbeat-ms <ms>", "Heartbeat interval hint (ms)", String(DEFAULT_HEARTBEAT_INTERVAL_MS))
    .option("--ttl-ms <ms>", "Worker TTL before eviction (ms)", String(DEFAULT_WORKER_TTL_MS))
    .option("--dispatch-policy <name>", "Dispatch policy: least_inflight|weighted_round_robin|model_affinity", "least_inflight")
    .option("--queue-max <n>", "Max concurrent forwarded requests", String(ORCHESTRATOR_QUEUE_MAX))
    .option("--queue-depth <n>", "Max queued requests", String(ORCHESTRATOR_QUEUE_DEPTH))
    .option("--queue-wait-ms <ms>", "Queue wait timeout (ms)", String(ORCHESTRATOR_QUEUE_WAIT_MS))
    .option("--queue-policy <name>", "Queue overload policy: reject|shed_oldest", "reject")
    .option("--retry-after-secs <n>", "Retry-After seconds for 429 responses", String(DEFAULT_RETRY_AFTER_SECS))
    .action(async (opts: {
      config?: string;
      publicHost?: string;
      publicPort?: string;
      internalHost?: string;
      internalPort?: string;
      authToken?: string;
      authTokenEnv?: string;
      heartbeatMs: string;
      ttlMs: string;
      dispatchPolicy: string;
      queueMax: string;
      queueDepth: string;
      queueWaitMs: string;
      queuePolicy: string;
      retryAfterSecs: string;
    }) => {
      const config = loadConfig(opts.config);
      const orch = config.orchestrator;
      const publicHost = opts.publicHost ?? orch?.public_host ?? DEFAULT_LOCALHOST;
      const publicPort = parseInt(opts.publicPort ?? String(orch?.public_port ?? DEFAULT_PUBLIC_PORT), 10);
      const internalHost = opts.internalHost ?? orch?.internal_host ?? DEFAULT_LOCALHOST;
      const internalPort = parseInt(opts.internalPort ?? String(orch?.internal_port ?? DEFAULT_INTERNAL_PORT), 10);
      const authToken = resolveToken({
        token: opts.authToken ?? orch?.auth_token,
        token_env: opts.authTokenEnv ?? orch?.auth_token_env,
      });

      const server = createOrchestratorServer({
        publicHost,
        publicPort,
        internalHost,
        internalPort,
        authToken,
        heartbeatIntervalMs: parseInt(opts.heartbeatMs, 10),
        ttlMs: parseInt(opts.ttlMs, 10),
        dispatchPolicy: opts.dispatchPolicy === "weighted_round_robin"
          ? "weighted_round_robin"
          : opts.dispatchPolicy === "model_affinity"
            ? "model_affinity"
            : "least_inflight",
        globalQueueMax: parseInt(opts.queueMax, 10),
        globalQueueDepth: parseInt(opts.queueDepth, 10),
        globalQueueWaitMs: parseInt(opts.queueWaitMs, 10),
        globalQueuePolicy: opts.queuePolicy === "shed_oldest" ? "shed_oldest" : "reject",
        retryAfterSecs: parseInt(opts.retryAfterSecs, 10),
      });

      const ports = await server.start();
      console.log(`ax-fabric orchestrator started`);
      console.log(`public:   http://${publicHost}:${ports.publicPort}`);
      console.log(`internal: http://${internalHost}:${ports.internalPort}`);

      const shutdown = async (): Promise<void> => {
        await server.close();
        process.exit(0);
      };

      process.on("SIGINT", () => {
        void shutdown();
      });
      process.on("SIGTERM", () => {
        void shutdown();
      });

      await new Promise<void>(() => {
        // Keep process alive until signal.
      });
    });
}
