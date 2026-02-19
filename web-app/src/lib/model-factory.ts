/**
 * Model Factory
 *
 * This factory provides a unified interface for creating language models from various providers.
 * It handles the complexity of initializing different AI SDK providers with their specific
 * configurations and returns a standard LanguageModel interface.
 *
 * Supported Providers:
 * - anthropic: Claude models via Anthropic API (@ai-sdk/anthropic v2.0)
 * - google/gemini: Gemini models via Google Generative AI API (@ai-sdk/google v2.0)
 * - openai: OpenAI models via OpenAI API (@ai-sdk/openai)
 * - OpenAI-compatible: Azure, Groq, Together, Fireworks, DeepSeek, Mistral, Cohere, etc.
 *
 * Usage:
 * ```typescript
 * const model = await ModelFactory.createModel(modelId, provider, parameters)
 * ```
 *
 * The factory automatically:
 * - Handles provider-specific authentication and headers
 * - Configures custom headers for each provider
 * - Returns a unified LanguageModel interface compatible with Vercel AI SDK
 */

/**
 * Inference parameters for customizing model behavior
 */
export interface ModelParameters {
  temperature?: number
  top_k?: number
  top_p?: number
  repeat_penalty?: number
  max_output_tokens?: number
  presence_penalty?: number
  frequency_penalty?: number
  stop_sequences?: string[]
}

import {
  type LanguageModel,
} from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import {
  createOpenAICompatible,
} from '@ai-sdk/openai-compatible'
import { createAnthropic } from '@ai-sdk/anthropic'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isPlatformTauri } from '@/lib/platform'

// Use Tauri's HTTP plugin on native platforms; fall back to native fetch for web/browser mode.
// @tauri-apps/plugin-http internally calls window.__TAURI_INTERNALS__.invoke which is undefined
// outside the Tauri WebView context, so we must not use it in web/browser mode.
const httpFetch = isPlatformTauri() ? tauriFetch : globalThis.fetch

/**
 * Create a custom fetch function that injects additional parameters into the request body
 */
function createCustomFetch(
  baseFetch: typeof httpFetch,
  parameters: Record<string, unknown>
): typeof httpFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Only transform POST requests with JSON body
    if (init?.method === 'POST' || !init?.method) {
      const body = init?.body ? JSON.parse(init.body as string) : {}

      // Merge parameters into the request body
      const mergedBody = { ...body, ...parameters }

      init = {
        ...init,
        body: JSON.stringify(mergedBody),
      }
    }

    return baseFetch(input, init)
  }
}

/**
 * Factory for creating language models based on provider type.
 * Supports native AI SDK providers (Anthropic, Google) and OpenAI-compatible providers.
 */
export class ModelFactory {
  /**
   * Create a language model instance based on the provider configuration
   */
  static async createModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): Promise<LanguageModel> {
    const providerName = provider.provider.toLowerCase()

    switch (providerName) {
      case 'anthropic':
        return this.createAnthropicModel(modelId, provider)

      case 'openai':
        return this.createOpenAIModel(modelId, provider)

      // Ax-Fabric API Service — OpenAI-compatible inference proxy
      case 'ax-fabric':
        return this.createAxFabricModel(modelId, provider, parameters)

      case 'google':
      case 'gemini':
      case 'azure':
      case 'groq':
      case 'together':
      case 'fireworks':
      case 'deepseek':
      case 'mistral':
      case 'cohere':
      case 'perplexity':
      case 'moonshot':
        return this.createOpenAICompatibleModel(modelId, provider)
      default:
        return this.createOpenAICompatibleModel(modelId, provider, parameters)
    }
  }

  /**
   * Create an Anthropic model using the official AI SDK
   */
  private static createAnthropicModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Add custom headers if specified (e.g., anthropic-version)
    if (provider.custom_header) {
      provider.custom_header.forEach((customHeader) => {
        headers[customHeader.header] = customHeader.value
      })
    }

    const anthropic = createAnthropic({
      apiKey: provider.api_key,
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: createCustomFetch(httpFetch, parameters),
    })

    return anthropic(modelId)
  }

  /**
   * Create an OpenAI model using the official AI SDK
   */
  private static createOpenAIModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Add custom headers if specified
    if (provider.custom_header) {
      provider.custom_header.forEach((customHeader) => {
        headers[customHeader.header] = customHeader.value
      })
    }

    const openai = createOpenAI({
      apiKey: provider.api_key,
      baseURL: provider.base_url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      fetch: createCustomFetch(httpFetch, parameters),
    })

    return openai(modelId)
  }

  /**
   * Create a model that routes through the Ax-Fabric API Service.
   * The API Service speaks the OpenAI-compatible chat/completions format and
   * can proxy requests to any underlying model provider.
   * Default base URL: http://127.0.0.1:8000/v1
   */
  private static createAxFabricModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const baseURL = provider.base_url?.trim() || 'http://127.0.0.1:8000/v1'
    // Ensure the base URL ends with /v1 as expected by the OpenAI-compatible SDK
    const normalizedBaseURL = baseURL.endsWith('/v1')
      ? baseURL
      : `${baseURL.replace(/\/+$/, '')}/v1`
    return this.createOpenAICompatibleModel(
      modelId,
      { ...provider, base_url: normalizedBaseURL },
      parameters
    )
  }

  /**
   * Create an OpenAI-compatible model for providers that support the OpenAI API format
   */
  private static createOpenAICompatibleModel(
    modelId: string,
    provider: ProviderObject,
    parameters: Record<string, unknown> = {}
  ): LanguageModel {
    const headers: Record<string, string> = {}

    // Add custom headers if specified
    if (provider.custom_header) {
      provider.custom_header.forEach((customHeader) => {
        headers[customHeader.header] = customHeader.value
      })
    }

    // Add authorization header if api_key is present
    if (provider.api_key) {
      headers['Authorization'] = `Bearer ${provider.api_key}`
    }

    const openAICompatible = createOpenAICompatible({
      name: provider.provider,
      baseURL: provider.base_url || 'https://api.openai.com/v1',
      headers,
      includeUsage: true,
      fetch: createCustomFetch(httpFetch, parameters),
    })

    return openAICompatible.languageModel(modelId)
  }
}
