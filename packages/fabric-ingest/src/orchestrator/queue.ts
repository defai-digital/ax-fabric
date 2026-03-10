export type OverloadPolicy = "reject" | "shed_oldest";

export interface GlobalQueueConfig {
  maxConcurrent: number;
  maxQueueDepth: number;
  waitMs: number;
  overloadPolicy: OverloadPolicy;
}

export interface QueuePermit {
  release: () => void;
}

export type AcquireResult =
  | { kind: "permit"; permit: QueuePermit }
  | { kind: "rejected" }
  | { kind: "shed" }
  | { kind: "timeout" };

interface Waiter {
  resolve: (value: "permit" | "shed" | "timeout") => void;
  timer: NodeJS.Timeout;
}

export class GlobalQueue {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  private readonly config: GlobalQueueConfig;

  constructor(config: GlobalQueueConfig) {
    this.config = {
      maxConcurrent: Math.max(1, config.maxConcurrent),
      maxQueueDepth: Math.max(0, config.maxQueueDepth),
      waitMs: Math.max(1, config.waitMs),
      overloadPolicy: config.overloadPolicy,
    };
  }

  async acquire(): Promise<AcquireResult> {
    if (this.active < this.config.maxConcurrent) {
      this.active += 1;
      return { kind: "permit", permit: this.makePermit() };
    }

    if (this.waiters.length >= this.config.maxQueueDepth) {
      if (this.config.overloadPolicy === "reject") {
        return { kind: "rejected" };
      }

      const oldest = this.waiters.shift();
      if (oldest) {
        clearTimeout(oldest.timer);
        oldest.resolve("shed");
      } else {
        return { kind: "shed" };
      }
    }

    const outcome = await new Promise<"permit" | "shed" | "timeout">((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve("timeout");
      }, this.config.waitMs);

      this.waiters.push({ resolve, timer });
    });

    if (outcome === "permit") {
      return { kind: "permit", permit: this.makePermit() };
    }
    if (outcome === "shed") {
      return { kind: "shed" };
    }
    return { kind: "timeout" };
  }

  activeCount(): number {
    return this.active;
  }

  queueDepth(): number {
    return this.waiters.length;
  }

  private makePermit(): QueuePermit {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.releaseOne();
      },
    };
  }

  private releaseOne(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        break;
      }
      clearTimeout(waiter.timer);
      waiter.resolve("permit");
      return;
    }

    this.active = Math.max(0, this.active - 1);
  }
}
