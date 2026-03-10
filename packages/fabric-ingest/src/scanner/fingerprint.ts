import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { AxFabricError } from "@ax-fabric/contracts";

/** Threshold (in bytes) above which sampled fingerprinting is used. */
const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MB

/** Sample size for head/tail reads on large files. */
const SAMPLE_SIZE = 64 * 1024; // 64 KB

/**
 * Compute a SHA-256 fingerprint of the full file content.
 * Suitable for files up to ~100 MB.
 */
export function computeFingerprint(filePath: string): string {
  try {
    const content = readFileSync(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    throw new AxFabricError(
      "EXTRACT_ERROR",
      `Failed to compute fingerprint for ${filePath}`,
      err,
    );
  }
}

/**
 * Compute a sampled SHA-256 fingerprint for large files.
 * Hashes: first 64 KB + last 64 KB + file size + mtime.
 */
export function computeSampledFingerprint(filePath: string): string {
  try {
    const stat = statSync(filePath);
    const fd = openSync(filePath, "r");

    try {
      const head = Buffer.alloc(SAMPLE_SIZE);
      readSync(fd, head, 0, SAMPLE_SIZE, 0);

      const tail = Buffer.alloc(SAMPLE_SIZE);
      const tailOffset = Math.max(0, stat.size - SAMPLE_SIZE);
      readSync(fd, tail, 0, SAMPLE_SIZE, tailOffset);

      const hash = createHash("sha256");
      hash.update(head);
      hash.update(tail);
      // Use a ":" separator so "12","34" and "1","234" hash differently.
      hash.update(`${String(stat.size)}:`);
      hash.update(String(stat.mtimeMs));
      return hash.digest("hex");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (err instanceof AxFabricError) throw err;
    throw new AxFabricError(
      "EXTRACT_ERROR",
      `Failed to compute sampled fingerprint for ${filePath}`,
      err,
    );
  }
}

/**
 * Automatically choose full or sampled fingerprinting based on file size.
 */
export function fingerprint(filePath: string): string {
  const s = statSync(filePath);
  if (s.size > LARGE_FILE_THRESHOLD) {
    return computeSampledFingerprint(filePath);
  }
  return computeFingerprint(filePath);
}

// ── Async variants (use fs/promises to avoid blocking the event loop) ─────────

/** Async version of computeFingerprint. */
export async function computeFingerprintAsync(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath);
    return createHash("sha256").update(content).digest("hex");
  } catch (err) {
    throw new AxFabricError(
      "EXTRACT_ERROR",
      `Failed to compute fingerprint for ${filePath}`,
      err,
    );
  }
}

/** Async version of computeSampledFingerprint. */
export async function computeSampledFingerprintAsync(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    const fh = await open(filePath, "r");
    try {
      const head = Buffer.alloc(SAMPLE_SIZE);
      await fh.read(head, 0, SAMPLE_SIZE, 0);

      const tail = Buffer.alloc(SAMPLE_SIZE);
      const tailOffset = Math.max(0, fileStat.size - SAMPLE_SIZE);
      await fh.read(tail, 0, SAMPLE_SIZE, tailOffset);

      const hash = createHash("sha256");
      hash.update(head);
      hash.update(tail);
      // Use a ":" separator so "12","34" and "1","234" hash differently.
      hash.update(`${String(fileStat.size)}:`);
      hash.update(String(fileStat.mtimeMs));
      return hash.digest("hex");
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (err instanceof AxFabricError) throw err;
    throw new AxFabricError(
      "EXTRACT_ERROR",
      `Failed to compute sampled fingerprint for ${filePath}`,
      err,
    );
  }
}

/**
 * Async auto-selecting fingerprint: non-blocking, suitable for concurrent use.
 */
export async function fingerprintAsync(filePath: string): Promise<string> {
  const fileStat = await stat(filePath);
  if (fileStat.size > LARGE_FILE_THRESHOLD) {
    return computeSampledFingerprintAsync(filePath);
  }
  return computeFingerprintAsync(filePath);
}
