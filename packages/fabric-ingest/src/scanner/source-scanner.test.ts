import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  computeFingerprint,
  computeSampledFingerprint,
  fingerprint,
  computeFingerprintAsync,
  computeSampledFingerprintAsync,
  fingerprintAsync,
  SourceScanner,
} from "./index.js";
import type { ScanResult } from "./index.js";

/* ---------- helpers ---------- */

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "ax-scanner-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/* ========== fingerprint.ts ========== */

describe("computeFingerprint", () => {
  it("returns SHA-256 hex of file content", () => {
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    const result = computeFingerprint(filePath);
    expect(result).toBe(sha256("hello world"));
    expect(result).toHaveLength(64); // SHA-256 hex is 64 chars
  });

  it("produces different hashes for different content", () => {
    const fileA = join(tempDir, "a.txt");
    const fileB = join(tempDir, "b.txt");
    writeFileSync(fileA, "content A");
    writeFileSync(fileB, "content B");

    expect(computeFingerprint(fileA)).not.toBe(computeFingerprint(fileB));
  });

  it("throws AxFabricError for missing files", () => {
    expect(() => computeFingerprint(join(tempDir, "missing.txt"))).toThrow(
      "Failed to compute fingerprint",
    );
  });

  it("returns deterministic results for same content", () => {
    const filePath = join(tempDir, "same.txt");
    writeFileSync(filePath, "deterministic");
    const first = computeFingerprint(filePath);
    const second = computeFingerprint(filePath);
    expect(first).toBe(second);
  });
});

describe("computeSampledFingerprint", () => {
  it("returns a valid hex string for small files", () => {
    const filePath = join(tempDir, "small.txt");
    writeFileSync(filePath, "small content");

    const result = computeSampledFingerprint(filePath);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("throws AxFabricError for missing files", () => {
    expect(() =>
      computeSampledFingerprint(join(tempDir, "missing.txt")),
    ).toThrow("Failed to compute sampled fingerprint");
  });
});

describe("fingerprint (auto-selector)", () => {
  it("uses full hash for normal-sized files", () => {
    const filePath = join(tempDir, "normal.txt");
    writeFileSync(filePath, "normal file content");

    // For a small file, fingerprint() should equal computeFingerprint()
    expect(fingerprint(filePath)).toBe(computeFingerprint(filePath));
  });
});

/* ========== async fingerprint variants ========== */

describe("computeFingerprintAsync", () => {
  it("returns SHA-256 hex of file content", async () => {
    const filePath = join(tempDir, "hello.txt");
    writeFileSync(filePath, "hello world");

    const result = await computeFingerprintAsync(filePath);
    expect(result).toBe(sha256("hello world"));
    expect(result).toHaveLength(64);
  });

  it("matches the sync computeFingerprint result", async () => {
    const filePath = join(tempDir, "match.txt");
    writeFileSync(filePath, "deterministic content");

    const sync = computeFingerprint(filePath);
    const async_ = await computeFingerprintAsync(filePath);
    expect(async_).toBe(sync);
  });

  it("produces different hashes for different content", async () => {
    const fileA = join(tempDir, "a.txt");
    const fileB = join(tempDir, "b.txt");
    writeFileSync(fileA, "content A");
    writeFileSync(fileB, "content B");

    const [hashA, hashB] = await Promise.all([
      computeFingerprintAsync(fileA),
      computeFingerprintAsync(fileB),
    ]);
    expect(hashA).not.toBe(hashB);
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(
      computeFingerprintAsync(join(tempDir, "missing.txt")),
    ).rejects.toThrow("Failed to compute fingerprint");
  });
});

describe("computeSampledFingerprintAsync", () => {
  it("returns a valid 64-char hex string", async () => {
    const filePath = join(tempDir, "sampled.txt");
    writeFileSync(filePath, "some content for sampling");

    const result = await computeSampledFingerprintAsync(filePath);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic results for same file", async () => {
    const filePath = join(tempDir, "stable.txt");
    writeFileSync(filePath, "stable content");

    const first = await computeSampledFingerprintAsync(filePath);
    const second = await computeSampledFingerprintAsync(filePath);
    expect(first).toBe(second);
  });

  it("produces different hashes for different content", async () => {
    const fileA = join(tempDir, "sa.txt");
    const fileB = join(tempDir, "sb.txt");
    writeFileSync(fileA, "content alpha");
    writeFileSync(fileB, "content beta");

    const hashA = await computeSampledFingerprintAsync(fileA);
    const hashB = await computeSampledFingerprintAsync(fileB);
    expect(hashA).not.toBe(hashB);
  });

  it("throws AxFabricError for missing file", async () => {
    await expect(
      computeSampledFingerprintAsync(join(tempDir, "missing.txt")),
    ).rejects.toThrow("Failed to compute sampled fingerprint");
  });
});

describe("fingerprintAsync (auto-selector)", () => {
  it("uses full hash for normal-sized files (matches computeFingerprintAsync)", async () => {
    const filePath = join(tempDir, "normal.txt");
    writeFileSync(filePath, "normal file content");

    const result = await fingerprintAsync(filePath);
    const full = await computeFingerprintAsync(filePath);
    expect(result).toBe(full);
  });

  it("returns a 64-char hex string", async () => {
    const filePath = join(tempDir, "hex.txt");
    writeFileSync(filePath, "hex test");

    const result = await fingerprintAsync(filePath);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("throws for a missing file", async () => {
    await expect(fingerprintAsync(join(tempDir, "nope.txt"))).rejects.toThrow();
  });
});

/* ========== source-scanner.ts ========== */

describe("SourceScanner", () => {
  const ALL_EXTENSIONS = [
    ".txt", ".pdf", ".docx", ".pptx", ".xlsx", ".csv", ".tsv", ".json", ".jsonl",
    ".yaml", ".yml", ".html", ".htm", ".rtf", ".sql", ".log", ".md", ".markdown",
  ];

  describe("scan", () => {
    it("scans a single file source path", () => {
      const filePath = join(tempDir, "single.txt");
      writeFileSync(filePath, "single file source");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(filePath);

      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toBe(filePath);
      expect(results[0]!.contentType).toBe("txt");
    });

    it("discovers files with supported extensions", () => {
      writeFileSync(join(tempDir, "readme.txt"), "text content");
      writeFileSync(join(tempDir, "data.csv"), "a,b,c");
      writeFileSync(join(tempDir, "config.yaml"), "key: value");

      const scanner = new SourceScanner({ extensions: ALL_EXTENSIONS });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(3);
      const paths = results.map((r) => r.sourcePath);
      expect(paths).toContain(join(tempDir, "readme.txt"));
      expect(paths).toContain(join(tempDir, "data.csv"));
      expect(paths).toContain(join(tempDir, "config.yaml"));
    });

    it("recurses into subdirectories", () => {
      const subDir = join(tempDir, "docs");
      mkdirSync(subDir);
      writeFileSync(join(subDir, "file.txt"), "nested");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toBe(join(subDir, "file.txt"));
    });

    it("skips hidden files and directories", () => {
      writeFileSync(join(tempDir, ".hidden.txt"), "hidden");
      const hiddenDir = join(tempDir, ".config");
      mkdirSync(hiddenDir);
      writeFileSync(join(hiddenDir, "visible.txt"), "inside hidden dir");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(0);
    });

    it("skips unsupported extensions", () => {
      writeFileSync(join(tempDir, "image.png"), "fake png");
      writeFileSync(join(tempDir, "binary.exe"), "fake exe");
      writeFileSync(join(tempDir, "doc.txt"), "text");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.contentType).toBe("txt");
    });

    it("maps .yml to yaml content type", () => {
      writeFileSync(join(tempDir, "config.yml"), "key: val");

      const scanner = new SourceScanner({ extensions: [".yml"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.contentType).toBe("yaml");
    });

    it("handles extensions with or without leading dot", () => {
      writeFileSync(join(tempDir, "file.json"), "{}");

      const scanner = new SourceScanner({ extensions: ["json"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(1);
    });

    it("populates sizeBytes correctly", () => {
      const content = "hello world";
      writeFileSync(join(tempDir, "sized.txt"), content);

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);

      expect(results[0]!.sizeBytes).toBe(Buffer.byteLength(content));
    });

    it("reuses known fingerprint when size and mtime are unchanged", () => {
      const filePath = join(tempDir, "known.txt");
      writeFileSync(filePath, "real content");
      const s = statSync(filePath);

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const known = new Map([
        [
          filePath,
          {
            fingerprint: "cached-fingerprint",
            sizeBytes: s.size,
            mtimeMs: Math.trunc(s.mtimeMs),
          },
        ],
      ]);
      const results = scanner.scan(tempDir, known);

      expect(results).toHaveLength(1);
      expect(results[0]!.fingerprint).toBe("cached-fingerprint");
    });

    it("returns empty array for empty directory", () => {
      const scanner = new SourceScanner({ extensions: ALL_EXTENSIONS });
      const results = scanner.scan(tempDir);

      expect(results).toEqual([]);
    });

    it("maps all supported extensions to correct content types", () => {
      writeFileSync(join(tempDir, "a.txt"), "t");
      writeFileSync(join(tempDir, "b.pdf"), "p");
      writeFileSync(join(tempDir, "c.docx"), "d");
      writeFileSync(join(tempDir, "d.pptx"), "p");
      writeFileSync(join(tempDir, "e.xlsx"), "x");
      writeFileSync(join(tempDir, "f.csv"), "c");
      writeFileSync(join(tempDir, "g.json"), "j");
      writeFileSync(join(tempDir, "h.yaml"), "y");
      writeFileSync(join(tempDir, "i.md"), "# heading");
      writeFileSync(join(tempDir, "j.markdown"), "# heading");

      const scanner = new SourceScanner({ extensions: ALL_EXTENSIONS });
      const results = scanner.scan(tempDir);
      const typeMap = new Map(results.map((r) => [r.contentType, true]));

      expect(typeMap.has("txt")).toBe(true);
      expect(typeMap.has("pdf")).toBe(true);
      expect(typeMap.has("docx")).toBe(true);
      expect(typeMap.has("pptx")).toBe(true);
      expect(typeMap.has("xlsx")).toBe(true);
      expect(typeMap.has("csv")).toBe(true);
      expect(typeMap.has("json")).toBe(true);
      expect(typeMap.has("yaml")).toBe(true);
      expect(typeMap.has("md")).toBe(true);
    });

    it("maps .markdown to md content type", () => {
      writeFileSync(join(tempDir, "readme.markdown"), "# title");

      const scanner = new SourceScanner({ extensions: [".markdown"] });
      const results = scanner.scan(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.contentType).toBe("md");
    });
  });

  describe("detectChanges", () => {
    it("classifies new files as added", () => {
      writeFileSync(join(tempDir, "new.txt"), "new content");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);
      const changes = scanner.detectChanges(results, new Map());

      expect(changes.added).toHaveLength(1);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
      expect(changes.unchanged).toHaveLength(0);
    });

    it("classifies modified files correctly", () => {
      writeFileSync(join(tempDir, "file.txt"), "updated content");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);
      const knownFiles = new Map([
        [join(tempDir, "file.txt"), "old-fingerprint-that-doesnt-match"],
      ]);
      const changes = scanner.detectChanges(results, knownFiles);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(1);
      expect(changes.modified[0]!.sourcePath).toBe(join(tempDir, "file.txt"));
      expect(changes.deleted).toHaveLength(0);
      expect(changes.unchanged).toHaveLength(0);
    });

    it("classifies unchanged files correctly", () => {
      const content = "same content";
      writeFileSync(join(tempDir, "stable.txt"), content);

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);
      const fp = results[0]!.fingerprint;
      const knownFiles = new Map([[join(tempDir, "stable.txt"), fp]]);
      const changes = scanner.detectChanges(results, knownFiles);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(0);
      expect(changes.unchanged).toHaveLength(1);
    });

    it("classifies deleted files (in known but not in scan)", () => {
      // Empty directory — nothing to scan
      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);
      const knownFiles = new Map([
        ["/old/removed-file.txt", "some-old-hash"],
      ]);
      const changes = scanner.detectChanges(results, knownFiles);

      expect(changes.added).toHaveLength(0);
      expect(changes.modified).toHaveLength(0);
      expect(changes.deleted).toHaveLength(1);
      expect(changes.deleted[0]).toBe("/old/removed-file.txt");
      expect(changes.unchanged).toHaveLength(0);
    });

    it("handles mixed change types in one pass", () => {
      writeFileSync(join(tempDir, "new.txt"), "new");
      writeFileSync(join(tempDir, "modified.txt"), "changed");
      writeFileSync(join(tempDir, "same.txt"), "same");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = scanner.scan(tempDir);

      const sameResult = results.find((r) => r.sourcePath.endsWith("same.txt"));

      const knownFiles = new Map([
        [join(tempDir, "modified.txt"), "old-hash"],
        [join(tempDir, "same.txt"), sameResult!.fingerprint],
        [join(tempDir, "deleted.txt"), "deleted-hash"],
      ]);

      const changes = scanner.detectChanges(results, knownFiles);

      expect(changes.added).toHaveLength(1);
      expect(changes.modified).toHaveLength(1);
      expect(changes.deleted).toHaveLength(1);
      expect(changes.unchanged).toHaveLength(1);
    });
  });

  /* ── scanAsync ──────────────────────────────────────────────────────── */

  describe("scanAsync", () => {
    it("returns empty array for non-existent path", async () => {
      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = await scanner.scanAsync(join(tempDir, "nonexistent"));
      expect(results).toEqual([]);
    });

    it("returns empty array for empty directory", async () => {
      const scanner = new SourceScanner({ extensions: ALL_EXTENSIONS });
      const results = await scanner.scanAsync(tempDir);
      expect(results).toEqual([]);
    });

    it("handles a single file path (not a directory)", async () => {
      const filePath = join(tempDir, "single.txt");
      writeFileSync(filePath, "single file");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = await scanner.scanAsync(filePath);

      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toBe(filePath);
      expect(results[0]!.contentType).toBe("txt");
    });

    it("discovers files with supported extensions in a directory", async () => {
      writeFileSync(join(tempDir, "readme.txt"), "text content");
      writeFileSync(join(tempDir, "data.csv"), "a,b,c");
      writeFileSync(join(tempDir, "config.yaml"), "key: value");

      const scanner = new SourceScanner({ extensions: ALL_EXTENSIONS });
      const results = await scanner.scanAsync(tempDir);

      expect(results).toHaveLength(3);
      const paths = results.map((r) => r.sourcePath);
      expect(paths).toContain(join(tempDir, "readme.txt"));
      expect(paths).toContain(join(tempDir, "data.csv"));
      expect(paths).toContain(join(tempDir, "config.yaml"));
    });

    it("recurses into subdirectories", async () => {
      const subDir = join(tempDir, "docs");
      mkdirSync(subDir);
      writeFileSync(join(subDir, "nested.txt"), "nested content");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = await scanner.scanAsync(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.sourcePath).toBe(join(subDir, "nested.txt"));
    });

    it("skips hidden files and directories", async () => {
      writeFileSync(join(tempDir, ".hidden.txt"), "hidden");
      const hiddenDir = join(tempDir, ".config");
      mkdirSync(hiddenDir);
      writeFileSync(join(hiddenDir, "inside.txt"), "inside hidden dir");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = await scanner.scanAsync(tempDir);

      expect(results).toHaveLength(0);
    });

    it("skips unsupported extensions", async () => {
      writeFileSync(join(tempDir, "image.png"), "fake png");
      writeFileSync(join(tempDir, "doc.txt"), "text");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const results = await scanner.scanAsync(tempDir);

      expect(results).toHaveLength(1);
      expect(results[0]!.contentType).toBe("txt");
    });

    it("result fingerprints match the sync scan fingerprints", async () => {
      writeFileSync(join(tempDir, "compare.txt"), "content to fingerprint");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const [syncResults, asyncResults] = await Promise.all([
        Promise.resolve(scanner.scan(tempDir)),
        scanner.scanAsync(tempDir),
      ]);

      expect(asyncResults).toHaveLength(1);
      expect(asyncResults[0]!.fingerprint).toBe(syncResults[0]!.fingerprint);
    });

    it("reuses cached fingerprint when size and mtime match", async () => {
      const filePath = join(tempDir, "cached.txt");
      writeFileSync(filePath, "real content");
      const s = statSync(filePath);

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const known = new Map([
        [
          filePath,
          {
            fingerprint: "cached-async-fingerprint",
            sizeBytes: s.size,
            mtimeMs: Math.trunc(s.mtimeMs),
          },
        ],
      ]);
      const results = await scanner.scanAsync(tempDir, known);

      expect(results).toHaveLength(1);
      expect(results[0]!.fingerprint).toBe("cached-async-fingerprint");
    });

    it("populates sizeBytes and contentType correctly", async () => {
      const content = "size check content";
      writeFileSync(join(tempDir, "check.json"), content);

      const scanner = new SourceScanner({ extensions: [".json"] });
      const results = await scanner.scanAsync(tempDir);

      expect(results[0]!.sizeBytes).toBe(Buffer.byteLength(content));
      expect(results[0]!.contentType).toBe("json");
    });

    it("mirrors sync scan results for a multi-file directory", async () => {
      writeFileSync(join(tempDir, "file1.txt"), "aaa");
      writeFileSync(join(tempDir, "file2.txt"), "bbb");
      const subDir = join(tempDir, "sub");
      mkdirSync(subDir);
      writeFileSync(join(subDir, "file3.txt"), "ccc");

      const scanner = new SourceScanner({ extensions: [".txt"] });
      const syncResults = scanner.scan(tempDir);
      const asyncResults = await scanner.scanAsync(tempDir);

      expect(asyncResults).toHaveLength(syncResults.length);
      const syncPaths = syncResults.map((r) => r.sourcePath).sort();
      const asyncPaths = asyncResults.map((r) => r.sourcePath).sort();
      expect(asyncPaths).toEqual(syncPaths);
    });
  });
});
