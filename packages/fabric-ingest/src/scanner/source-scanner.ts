import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import type { RecordMetadata } from "@ax-fabric/contracts";
import { fingerprint, fingerprintAsync } from "./fingerprint.js";
import type { KnownFileState } from "../registry/index.js";

/** Content type derived from the contracts schema. */
export type ContentType = RecordMetadata["content_type"];

/** Result of scanning a single file. */
export interface ScanResult {
  sourcePath: string;
  fingerprint: string;
  sizeBytes: number;
  mtimeMs: number;
  contentType: ContentType;
}

/** Delta between current scan and known state. */
export interface ChangeSet {
  added: ScanResult[];
  modified: ScanResult[];
  deleted: string[];
  unchanged: ScanResult[];
}

/** Maximum file size (1 GB). Files exceeding this are skipped. */
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const ASYNC_IO_CONCURRENCY = 32;

/** Map file extensions to ContentType values. */
const EXTENSION_MAP: Record<string, ContentType> = {
  ".txt": "txt",
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".csv": "csv",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
};

/**
 * Recursively scans directories for supported file types,
 * computes fingerprints, and detects changes against known state.
 */
export class SourceScanner {
  private readonly extensions: Set<string>;

  constructor(options: { extensions: string[] }) {
    this.extensions = new Set(
      options.extensions.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)),
    );
  }

  /**
   * Async version of scan: concurrent stat + fingerprint computation per directory.
   * Prefer this over scan() in pipelines to avoid blocking the event loop.
   */
  async scanAsync(rootPath: string, knownFiles?: Map<string, KnownFileState>): Promise<ScanResult[]> {
    const results: ScanResult[] = [];
    let rootStat;
    try {
      rootStat = await stat(rootPath);
    } catch {
      return results;
    }

    if (rootStat.isDirectory()) {
      await this.walkDirectoryAsync(rootPath, results, knownFiles);
    } else if (rootStat.isFile()) {
      const r = await this.maybeAddFileAsync(rootPath, rootStat.size, Math.trunc(rootStat.mtimeMs), knownFiles);
      if (r) results.push(r);
    }

    return results;
  }

  /**
   * Recursively walk `rootPath` and return ScanResults for supported files.
   */
  scan(rootPath: string, knownFiles?: Map<string, KnownFileState>): ScanResult[] {
    const results: ScanResult[] = [];
    let rootStat;
    try {
      rootStat = statSync(rootPath);
    } catch {
      return results;
    }

    if (rootStat.isDirectory()) {
      this.walkDirectory(rootPath, results, knownFiles);
    } else if (rootStat.isFile()) {
      this.maybeAddFile(rootPath, rootStat.size, Math.trunc(rootStat.mtimeMs), results, knownFiles);
    }

    return results;
  }

  /**
   * Compare current scan results against previously known fingerprints.
   * `knownFiles` maps sourcePath -> fingerprint from the Job Registry.
   */
  detectChanges(
    scanResults: ScanResult[],
    knownFiles: Map<string, string>,
  ): ChangeSet {
    const added: ScanResult[] = [];
    const modified: ScanResult[] = [];
    const unchanged: ScanResult[] = [];

    const currentPaths = new Set<string>();

    for (const result of scanResults) {
      currentPaths.add(result.sourcePath);
      const knownHash = knownFiles.get(result.sourcePath);

      if (knownHash === undefined) {
        added.push(result);
      } else if (knownHash !== result.fingerprint) {
        modified.push(result);
      } else {
        unchanged.push(result);
      }
    }

    const deleted: string[] = [];
    for (const knownPath of knownFiles.keys()) {
      if (!currentPaths.has(knownPath)) {
        deleted.push(knownPath);
      }
    }

    return { added, modified, deleted, unchanged };
  }

  /** Recursively walk a directory, collecting ScanResults. */
  private walkDirectory(dirPath: string, results: ScanResult[], knownFiles?: Map<string, KnownFileState>): void {
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      // Skip directories we cannot read
      return;
    }

    for (const entry of entries) {
      // Skip hidden files and directories
      if (entry.startsWith(".")) continue;

      const fullPath = join(dirPath, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // Skip inaccessible entries
      }

      if (stat.isDirectory()) {
        this.walkDirectory(fullPath, results, knownFiles);
        continue;
      }

      if (!stat.isFile()) continue;

      this.maybeAddFile(fullPath, stat.size, Math.trunc(stat.mtimeMs), results, knownFiles);
    }
  }

  /** Add a file if it is supported by extension and size constraints. */
  private maybeAddFile(
    filePath: string,
    sizeBytes: number,
    mtimeMs: number,
    results: ScanResult[],
    knownFiles?: Map<string, KnownFileState>,
  ): void {
    const ext = extname(filePath).toLowerCase();
    if (!this.extensions.has(ext)) return;

    if (sizeBytes > MAX_FILE_SIZE) {
      console.warn(
        `[source-scanner] Skipping file > 1 GB: ${filePath} (${sizeBytes} bytes)`,
      );
      return;
    }

    const contentType = EXTENSION_MAP[ext];
    if (contentType === undefined) return;

    try {
      const known = knownFiles?.get(filePath);
      const fp = known && known.sizeBytes === sizeBytes && Math.trunc(known.mtimeMs) === mtimeMs
        ? known.fingerprint
        : fingerprint(filePath);
      results.push({
        sourcePath: filePath,
        fingerprint: fp,
        sizeBytes,
        mtimeMs,
        contentType,
      });
    } catch {
      console.warn(`[source-scanner] Skipping file (fingerprint error): ${filePath}`);
    }
  }

  // ── Async internals ──────────────────────────────────────────────────────

  /**
   * Async directory walk: stats all entries concurrently, then fingerprints
   * all eligible files concurrently, and recurses into subdirectories in parallel.
   */
  private async walkDirectoryAsync(
    dirPath: string,
    results: ScanResult[],
    knownFiles?: Map<string, KnownFileState>,
  ): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      return;
    }

    const visible = entries.filter((e) => !e.startsWith("."));

    // Stat visible entries with bounded concurrency to avoid EMFILE.
    const statted = await mapWithConcurrency(
      visible,
      ASYNC_IO_CONCURRENCY,
      async (entry) => {
        const fullPath = join(dirPath, entry);
        try {
          const s = await stat(fullPath);
          return { fullPath, s };
        } catch {
          return null;
        }
      },
    );

    const subdirTasks: Array<() => Promise<void>> = [];
    const fileTasks: Array<() => Promise<ScanResult | null>> = [];

    for (const res of statted) {
      if (!res) continue;
      const { fullPath, s } = res;
      if (s.isDirectory()) {
        subdirTasks.push(() => this.walkDirectoryAsync(fullPath, results, knownFiles));
      } else if (s.isFile()) {
        fileTasks.push(() => this.maybeAddFileAsync(fullPath, s.size, Math.trunc(s.mtimeMs), knownFiles));
      }
    }

    // Fingerprint files and recurse subdirectories with bounded concurrency.
    // Subdir errors are isolated so one inaccessible directory doesn't halt the scan.
    const [fileResults] = await Promise.all([
      runThunksWithConcurrency(fileTasks, ASYNC_IO_CONCURRENCY),
      runThunksWithConcurrency(
        subdirTasks.map((task) => async () => {
          try {
            await task();
          } catch {
            // Keep scanning other directories.
          }
        }),
        ASYNC_IO_CONCURRENCY,
      ),
    ]);

    for (const r of fileResults) {
      if (r) results.push(r);
    }
  }

  /** Async file eligibility check + fingerprint. Returns null if skipped. */
  private async maybeAddFileAsync(
    filePath: string,
    sizeBytes: number,
    mtimeMs: number,
    knownFiles?: Map<string, KnownFileState>,
  ): Promise<ScanResult | null> {
    const ext = extname(filePath).toLowerCase();
    if (!this.extensions.has(ext)) return null;

    if (sizeBytes > MAX_FILE_SIZE) {
      console.warn(`[source-scanner] Skipping file > 1 GB: ${filePath} (${sizeBytes} bytes)`);
      return null;
    }

    const contentType = EXTENSION_MAP[ext];
    if (contentType === undefined) return null;

    try {
      const known = knownFiles?.get(filePath);
      const fp = known && known.sizeBytes === sizeBytes && Math.trunc(known.mtimeMs) === mtimeMs
        ? known.fingerprint
        : await fingerprintAsync(filePath);
      return { sourcePath: filePath, fingerprint: fp, sizeBytes, mtimeMs, contentType };
    } catch {
      console.warn(`[source-scanner] Skipping file (fingerprint error): ${filePath}`);
      return null;
    }
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out: R[] = new Array(items.length);
  let next = 0;

  const worker = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  };

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return out;
}

async function runThunksWithConcurrency<T>(
  thunks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  return mapWithConcurrency(thunks, concurrency, (fn) => fn());
}
