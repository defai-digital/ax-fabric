import type { z } from "zod";

/**
 * Embedder provider interface — all embedding providers implement this.
 * embed(texts) → vectors
 */
export interface EmbedderProvider {
  readonly modelId: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
  /** Release any held resources (MCP subprocess, HTTP connections, etc.). */
  close?(): Promise<void>;
}

/**
 * LLM provider interface — optional, used for retrieve-then-generate.
 */
export interface LlmProvider {
  readonly modelId: string;
  generate(prompt: string, options?: GenerateOptions): Promise<string>;
  /** Release any held resources (MCP subprocess, HTTP connections, etc.). */
  close?(): Promise<void>;
}

export interface GenerateOptions {
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}
