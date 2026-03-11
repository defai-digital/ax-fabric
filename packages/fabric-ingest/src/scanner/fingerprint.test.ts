import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeAll, afterAll } from "vitest";

import { AxFabricError } from "@ax-fabric/contracts";

import {
  computeFingerprint,
  computeSampledFingerprint,
  fingerprint,
  computeFingerprintAsync,
  computeSampledFingerprintAsync,
  fingerprintAsync,
} from "./fingerprint.js";

let workdir: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "fingerprint-test-"));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("computeFingerprint", () => {
  it("returns a hex string for a normal file", () => {
    const file = join(workdir, "normal.txt");
    writeFileSync(file, "hello world");
    const result = computeFingerprint(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same content produces same hash", () => {
    const file1 = join(workdir, "determ1.txt");
    const file2 = join(workdir, "determ2.txt");
    writeFileSync(file1, "deterministic content");
    writeFileSync(file2, "deterministic content");
    expect(computeFingerprint(file1)).toBe(computeFingerprint(file2));
  });

  it("different content produces different hash", () => {
    const file1 = join(workdir, "diff1.txt");
    const file2 = join(workdir, "diff2.txt");
    writeFileSync(file1, "content A");
    writeFileSync(file2, "content B");
    expect(computeFingerprint(file1)).not.toBe(computeFingerprint(file2));
  });

  it("handles empty file without throwing", () => {
    const file = join(workdir, "empty.txt");
    writeFileSync(file, "");
    const result = computeFingerprint(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AxFabricError with EXTRACT_ERROR code for missing file", () => {
    expect(() => computeFingerprint(join(workdir, "nonexistent.txt"))).toThrow(AxFabricError);
    try {
      computeFingerprint(join(workdir, "nonexistent.txt"));
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

describe("computeSampledFingerprint", () => {
  it("returns a hex string for a normal file", () => {
    const file = join(workdir, "sampled-normal.txt");
    writeFileSync(file, "sampled content");
    const result = computeSampledFingerprint(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same file returns same hash", () => {
    const file = join(workdir, "sampled-determ.txt");
    writeFileSync(file, "sampled deterministic");
    expect(computeSampledFingerprint(file)).toBe(computeSampledFingerprint(file));
  });

  it("different content produces different hash", () => {
    const file1 = join(workdir, "sampled-diff1.txt");
    const file2 = join(workdir, "sampled-diff2.txt");
    writeFileSync(file1, "sampled content A");
    writeFileSync(file2, "sampled content B");
    expect(computeSampledFingerprint(file1)).not.toBe(computeSampledFingerprint(file2));
  });

  it("handles empty file without throwing", () => {
    const file = join(workdir, "sampled-empty.txt");
    writeFileSync(file, "");
    const result = computeSampledFingerprint(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AxFabricError with EXTRACT_ERROR code for missing file", () => {
    try {
      computeSampledFingerprint(join(workdir, "no-such-file.txt"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });

  it("produces a different hash from computeFingerprint for the same file", () => {
    // The sampled algorithm includes mtime and size, making it structurally
    // different from a plain SHA-256 of the file contents.
    const file = join(workdir, "algo-diff.txt");
    writeFileSync(file, "algorithm comparison content");
    const full = computeFingerprint(file);
    const sampled = computeSampledFingerprint(file);
    expect(full).not.toBe(sampled);
  });
});

describe("fingerprint (auto-select)", () => {
  it("returns a hex string for a small file", () => {
    const file = join(workdir, "auto-small.txt");
    writeFileSync(file, "small file content");
    expect(fingerprint(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches computeFingerprint output for a small file (< 100 MB threshold)", () => {
    const file = join(workdir, "auto-match.txt");
    writeFileSync(file, "match content");
    expect(fingerprint(file)).toBe(computeFingerprint(file));
  });

  it("is deterministic for the same content", () => {
    const file1 = join(workdir, "auto-determ1.txt");
    const file2 = join(workdir, "auto-determ2.txt");
    writeFileSync(file1, "auto deterministic");
    writeFileSync(file2, "auto deterministic");
    expect(fingerprint(file1)).toBe(fingerprint(file2));
  });

  it("throws for missing file", () => {
    expect(() => fingerprint(join(workdir, "missing-auto.txt"))).toThrow();
  });
});

describe("computeFingerprintAsync", () => {
  it("returns a hex string for a normal file", async () => {
    const file = join(workdir, "async-normal.txt");
    writeFileSync(file, "async content");
    const result = await computeFingerprintAsync(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the sync variant for the same file", async () => {
    const file = join(workdir, "async-sync-match.txt");
    writeFileSync(file, "sync vs async content");
    const sync = computeFingerprint(file);
    const async_ = await computeFingerprintAsync(file);
    expect(async_).toBe(sync);
  });

  it("is deterministic", async () => {
    const file1 = join(workdir, "async-determ1.txt");
    const file2 = join(workdir, "async-determ2.txt");
    writeFileSync(file1, "async deterministic");
    writeFileSync(file2, "async deterministic");
    expect(await computeFingerprintAsync(file1)).toBe(await computeFingerprintAsync(file2));
  });

  it("handles empty file", async () => {
    const file = join(workdir, "async-empty.txt");
    writeFileSync(file, "");
    const result = await computeFingerprintAsync(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AxFabricError with EXTRACT_ERROR for missing file", async () => {
    await expect(computeFingerprintAsync(join(workdir, "no-async.txt"))).rejects.toThrow(AxFabricError);
    try {
      await computeFingerprintAsync(join(workdir, "no-async.txt"));
    } catch (err) {
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });
});

describe("computeSampledFingerprintAsync", () => {
  it("returns a hex string for a normal file", async () => {
    const file = join(workdir, "async-sampled.txt");
    writeFileSync(file, "async sampled content");
    const result = await computeSampledFingerprintAsync(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the sync variant for the same file", async () => {
    const file = join(workdir, "async-sampled-sync-match.txt");
    writeFileSync(file, "sampled sync vs async");
    const sync = computeSampledFingerprint(file);
    const async_ = await computeSampledFingerprintAsync(file);
    expect(async_).toBe(sync);
  });

  it("is deterministic", async () => {
    const file = join(workdir, "async-sampled-determ.txt");
    writeFileSync(file, "sampled async deterministic");
    expect(await computeSampledFingerprintAsync(file)).toBe(await computeSampledFingerprintAsync(file));
  });

  it("handles empty file", async () => {
    const file = join(workdir, "async-sampled-empty.txt");
    writeFileSync(file, "");
    const result = await computeSampledFingerprintAsync(file);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws AxFabricError with EXTRACT_ERROR for missing file", async () => {
    try {
      await computeSampledFingerprintAsync(join(workdir, "no-sampled-async.txt"));
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AxFabricError);
      expect((err as AxFabricError).code).toBe("EXTRACT_ERROR");
    }
  });

  it("produces different hash from computeFingerprintAsync for the same file", async () => {
    const file = join(workdir, "async-algo-diff.txt");
    writeFileSync(file, "async algorithm comparison");
    const full = await computeFingerprintAsync(file);
    const sampled = await computeSampledFingerprintAsync(file);
    expect(full).not.toBe(sampled);
  });
});

describe("fingerprintAsync (async auto-select)", () => {
  it("returns a hex string for a small file", async () => {
    const file = join(workdir, "async-auto.txt");
    writeFileSync(file, "async auto content");
    expect(await fingerprintAsync(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches computeFingerprintAsync for a small file (< 100 MB)", async () => {
    const file = join(workdir, "async-auto-match.txt");
    writeFileSync(file, "auto match content");
    const auto = await fingerprintAsync(file);
    const full = await computeFingerprintAsync(file);
    expect(auto).toBe(full);
  });

  it("matches sync fingerprint for the same small file", async () => {
    const file = join(workdir, "async-auto-sync.txt");
    writeFileSync(file, "sync async auto match");
    expect(await fingerprintAsync(file)).toBe(fingerprint(file));
  });

  it("is deterministic", async () => {
    const file1 = join(workdir, "async-auto-determ1.txt");
    const file2 = join(workdir, "async-auto-determ2.txt");
    writeFileSync(file1, "async auto deterministic");
    writeFileSync(file2, "async auto deterministic");
    expect(await fingerprintAsync(file1)).toBe(await fingerprintAsync(file2));
  });

  it("throws for missing file", async () => {
    await expect(fingerprintAsync(join(workdir, "no-auto.txt"))).rejects.toThrow();
  });
});
