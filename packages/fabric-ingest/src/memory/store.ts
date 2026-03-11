import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type MemoryKind = "short-term" | "long-term";

export interface MemoryRecord {
  id: string;
  sessionId: string;
  workflowId?: string;
  kind: MemoryKind;
  text: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MemoryFile {
  records: MemoryRecord[];
}

export interface PutMemoryInput {
  sessionId: string;
  workflowId?: string;
  kind?: MemoryKind;
  text: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

export interface ListMemoryOptions {
  sessionId?: string;
  workflowId?: string;
  kind?: MemoryKind;
  limit?: number;
}

export interface AssembleContextOptions extends ListMemoryOptions {
  separator?: string;
}

const EMPTY_STORE: MemoryFile = { records: [] };

export class MemoryStore {
  constructor(private readonly filePath: string) {}

  put(input: PutMemoryInput): MemoryRecord {
    const store = this.load();
    const now = new Date().toISOString();
    const recordId = input.id ?? randomUUID();
    const existingIndex = store.records.findIndex((record) => record.id === recordId);
    const createdAt = existingIndex >= 0 ? store.records[existingIndex]!.createdAt : now;
    const record: MemoryRecord = {
      id: recordId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      kind: input.kind ?? "short-term",
      text: input.text,
      metadata: input.metadata,
      createdAt,
      updatedAt: now,
    };
    if (existingIndex >= 0) {
      store.records[existingIndex] = record;
    } else {
      store.records.push(record);
    }
    this.save(store);
    return record;
  }

  get(id: string): MemoryRecord | null {
    return this.load().records.find((record) => record.id === id) ?? null;
  }

  list(options: ListMemoryOptions = {}): MemoryRecord[] {
    let records = this.load().records.filter((record) => {
      if (options.sessionId && record.sessionId !== options.sessionId) return false;
      if (options.workflowId && record.workflowId !== options.workflowId) return false;
      if (options.kind && record.kind !== options.kind) return false;
      return true;
    });

    records = records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (options.limit !== undefined) {
      records = records.slice(Math.max(0, records.length - options.limit));
    }
    return records;
  }

  delete(id: string): boolean {
    const store = this.load();
    const next = store.records.filter((record) => record.id !== id);
    if (next.length === store.records.length) {
      return false;
    }
    store.records = next;
    this.save(store);
    return true;
  }

  assembleContext(options: AssembleContextOptions): { entries: MemoryRecord[]; text: string } {
    const entries = this.list(options);
    const separator = options.separator ?? "\n\n---\n\n";
    return {
      entries,
      text: entries.map((entry) => entry.text).join(separator),
    };
  }

  private load(): MemoryFile {
    if (!existsSync(this.filePath)) {
      return structuredClone(EMPTY_STORE);
    }
    const raw = readFileSync(this.filePath, "utf-8");
    const parsed = JSON.parse(raw) as MemoryFile;
    return {
      records: Array.isArray(parsed.records) ? parsed.records : [],
    };
  }

  private save(store: MemoryFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(store, null, 2), "utf-8");
  }
}
