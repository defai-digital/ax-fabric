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
  /** Set to true by releaseOne() before calling resolve("permit"). Prevents
   *  a stale timeout callback from treating the waiter as still pending. */
  promoted: boolean;
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

    const waiter: Waiter = { resolve: null as unknown as Waiter["resolve"], timer: null as unknown as NodeJS.Timeout, promoted: false };
    const outcome = await new Promise<"permit" | "shed" | "timeout">((resolve) => {
      waiter.resolve = resolve;
      waiter.timer = setTimeout(() => {
        if (waiter.promoted) return; // releaseOne() already claimed this slot
        const idx = this.waiters.findIndex((w) => w === waiter);
        if (idx >= 0) {
          this.waiters.splice(idx, 1);
        }
        resolve("timeout");
      }, this.config.waitMs);

      this.waiters.push(waiter);
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
      waiter.promoted = true; // fence: prevent stale timeout callback from re-resolving
      waiter.resolve("permit");
      return;
    }

    this.active = Math.max(0, this.active - 1);
  }
}
