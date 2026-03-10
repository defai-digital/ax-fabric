import { describe, expect, it } from "vitest";

import { GlobalQueue } from "./queue.js";

describe("GlobalQueue", () => {
  it("grants immediate permit under capacity", async () => {
    const queue = new GlobalQueue({
      maxConcurrent: 2,
      maxQueueDepth: 10,
      waitMs: 100,
      overloadPolicy: "reject",
    });

    const r = await queue.acquire();
    expect(r.kind).toBe("permit");
    if (r.kind === "permit") {
      r.permit.release();
    }
  });

  it("rejects when full and policy=reject", async () => {
    const queue = new GlobalQueue({
      maxConcurrent: 1,
      maxQueueDepth: 0,
      waitMs: 100,
      overloadPolicy: "reject",
    });

    const first = await queue.acquire();
    expect(first.kind).toBe("permit");

    const second = await queue.acquire();
    expect(second.kind).toBe("rejected");

    if (first.kind === "permit") {
      first.permit.release();
    }
  });

  it("returns timeout when queued request exceeds waitMs", async () => {
    const queue = new GlobalQueue({
      maxConcurrent: 1,
      maxQueueDepth: 1,
      waitMs: 20,
      overloadPolicy: "shed_oldest",
    });

    const first = await queue.acquire();
    expect(first.kind).toBe("permit");

    const second = await queue.acquire();
    expect(second.kind).toBe("timeout");

    if (first.kind === "permit") {
      first.permit.release();
    }
  });

  it("sheds oldest queued request when policy=shed_oldest", async () => {
    const queue = new GlobalQueue({
      maxConcurrent: 1,
      maxQueueDepth: 1,
      waitMs: 100,
      overloadPolicy: "shed_oldest",
    });

    const first = await queue.acquire();
    expect(first.kind).toBe("permit");

    const secondPromise = queue.acquire();
    const thirdPromise = queue.acquire();

    const second = await secondPromise;
    expect(second.kind).toBe("shed");

    if (first.kind === "permit") {
      first.permit.release();
    }

    const third = await thirdPromise;
    expect(third.kind).toBe("permit");

    if (third.kind === "permit") {
      third.permit.release();
    }
  });
});
