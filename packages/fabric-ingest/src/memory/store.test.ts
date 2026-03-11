import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { MemoryStore } from "./store.js";

describe("MemoryStore", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeStore(): MemoryStore {
    const dir = mkdtempSync(join(tmpdir(), "memory-store-"));
    dirs.push(dir);
    return new MemoryStore(join(dir, "memory.json"));
  }

  it("stores and retrieves memory records", () => {
    const store = makeStore();
    const record = store.put({
      sessionId: "session-a",
      kind: "short-term",
      text: "Remember this deployment window.",
    });

    const loaded = store.get(record.id);
    expect(loaded?.sessionId).toBe("session-a");
    expect(loaded?.text).toContain("deployment window");
  });

  it("lists records by session and kind", () => {
    const store = makeStore();
    store.put({ sessionId: "s1", kind: "short-term", text: "A" });
    store.put({ sessionId: "s1", kind: "long-term", text: "B" });
    store.put({ sessionId: "s2", kind: "short-term", text: "C" });

    expect(store.list({ sessionId: "s1" })).toHaveLength(2);
    expect(store.list({ sessionId: "s1", kind: "long-term" })).toHaveLength(1);
  });

  it("assembles context in insertion order", () => {
    const store = makeStore();
    store.put({ sessionId: "session-a", text: "First" });
    store.put({ sessionId: "session-a", text: "Second" });

    const assembled = store.assembleContext({ sessionId: "session-a" });
    expect(assembled.entries).toHaveLength(2);
    expect(assembled.text).toContain("First");
    expect(assembled.text).toContain("Second");
  });

  it("deletes records", () => {
    const store = makeStore();
    const record = store.put({ sessionId: "session-a", text: "Delete me" });
    expect(store.delete(record.id)).toBe(true);
    expect(store.get(record.id)).toBeNull();
  });

  it("updates an existing record when put is called with the same id", () => {
    const store = makeStore();
    const created = store.put({
      id: "memory-1",
      sessionId: "session-a",
      kind: "short-term",
      text: "Original text",
    });

    const updated = store.put({
      id: "memory-1",
      sessionId: "session-b",
      kind: "long-term",
      text: "Updated text",
    });

    expect(store.list()).toHaveLength(1);
    expect(updated.id).toBe("memory-1");
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    expect(store.get("memory-1")).toMatchObject({
      sessionId: "session-b",
      kind: "long-term",
      text: "Updated text",
    });
  });
});
