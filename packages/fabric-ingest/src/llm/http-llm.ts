/**
 * HTTP LLM provider — calls an OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Works with OpenAI, Ollama, LM Studio, Cloudflare Workers AI, and any other
 * service that follows the OpenAI Chat Completions API spec.
 *
 * Config example (Ollama):
 *   llm:
 *     type: http
 *     base_url: "http://localhost:11434"
 *     model_id: "qwen3:0.6b"
 *
 * Config example (OpenAI):
 *   llm:
 *     type: http
 *     base_url: "https://api.openai.com"
 *     model_id: "gpt-4o-mini"
 *     auth:
 *       token_env: OPENAI_API_KEY
 */

import { AxFabricError } from "@ax-fabric/contracts";
import type { GenerateOptions, LlmProvider } from "@ax-fabric/contracts";

export interface HttpLlmOptions {
  /** Base URL of the chat completions API (e.g. "http://localhost:11434"). */
  baseUrl: string;
  /** Model identifier sent in the request body. */
  modelId: string;
  /** Bearer token for authentication. Optional for local models. */
  apiKey?: string;
  /** Request timeout in milliseconds. Default: 60 000 */
  timeoutMs?: number;
  /** Default max tokens for generation (overridden by per-call options). */
  maxTokens?: number;
  /** Default temperature for generation (overridden by per-call options). */
  temperature?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export class HttpLlmProvider implements LlmProvider {
  readonly modelId: string;

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly defaultMaxTokens: number | undefined;
  private readonly defaultTemperature: number | undefined;

  constructor(options: HttpLlmOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.modelId = options.modelId;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxTokens = options.maxTokens;
    this.defaultTemperature = options.temperature;
  }

  async generate(prompt: string, options?: GenerateOptions): Promise<string> {
    const url = `${this.baseUrl}/v1/chat/completions`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const messages: ChatMessage[] = [{ role: "user", content: prompt }];

    const body: Record<string, unknown> = {
      model: this.modelId,
      messages,
    };
    const maxTokens = options?.maxTokens ?? this.defaultMaxTokens;
    const temperature = options?.temperature ?? this.defaultTemperature;
    if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
    if (temperature !== undefined) body["temperature"] = temperature;
    if (options?.stopSequences !== undefined) body["stop"] = options.stopSequences;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AxFabricError(
        "LLM_ERROR",
        `LLM request to ${url} failed: ${String(err)}`,
        err,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(unreadable body)");
      throw new AxFabricError(
        "LLM_ERROR",
        `LLM API returned HTTP ${String(response.status)}: ${text}`,
      );
    }

    let json: ChatCompletionResponse;
    try {
      json = (await response.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new AxFabricError("LLM_ERROR", "Failed to parse LLM API response as JSON", err);
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new AxFabricError("LLM_ERROR", "LLM API response missing choices[0].message.content");
    }

    return content;
  }
}
