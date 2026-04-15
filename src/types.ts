/**
 * Configuration and type re-exports for the any-llm gateway client.
 */

import type OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";

// Batches
export type { Batch } from "openai/resources/batches";
// Re-export OpenAI types that callers will interact with directly.
// This avoids forcing consumers to install/import 'openai' themselves.
export type {
  // Chat completions
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
// Embeddings
export type {
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
} from "openai/resources/embeddings";
// Models
export type { Model } from "openai/resources/models";

// Responses API
export type {
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";

// Streaming
export type { Stream } from "openai/streaming";

// -- Batch types ------------------------------------------------------------

export interface BatchRequestItem {
  custom_id: string;
  body: Record<string, unknown>;
}

export interface CreateBatchParams {
  model: string;
  requests: BatchRequestItem[];
  completion_window?: string;
  metadata?: Record<string, string>;
}

export interface ListBatchesOptions {
  after?: string;
  limit?: number;
}

export interface BatchResultError {
  code: string;
  message: string;
}

export interface BatchResultItem {
  custom_id: string;
  result?: ChatCompletion;
  error?: BatchResultError;
}

export interface BatchResult {
  results: BatchResultItem[];
}

/**
 * Options for constructing a {@link GatewayClient}.
 *
 * Auth resolution order (mirrors the Python GatewayProvider):
 *  1. Explicit `platformToken` -> platform mode (Bearer token in Authorization header)
 *  2. `GATEWAY_PLATFORM_TOKEN` env var (when no `apiKey`) -> platform mode
 *  3. `apiKey` or `GATEWAY_API_KEY` env var -> non-platform mode (X-AnyLLM-Key header)
 *  4. No credentials -> non-platform mode, no auth header
 */
export interface GatewayClientOptions {
  /**
   * Base URL of the gateway (e.g. "http://localhost:8000").
   * Falls back to the `GATEWAY_API_BASE` environment variable.
   */
  apiBase?: string;

  /**
   * API key for non-platform mode.
   * Sent via the `X-AnyLLM-Key: Bearer <key>` header.
   * Falls back to the `GATEWAY_API_KEY` environment variable.
   */
  apiKey?: string;

  /**
   * Platform token for platform mode.
   * Sent as a standard Bearer token in the Authorization header.
   * Falls back to the `GATEWAY_PLATFORM_TOKEN` environment variable.
   */
  platformToken?: string;

  /**
   * Additional default headers to send with every request.
   */
  defaultHeaders?: Record<string, string>;

  /**
   * Extra options forwarded to the underlying OpenAI client constructor.
   */
  openaiOptions?: Omit<
    ConstructorParameters<typeof OpenAI>[0],
    "apiKey" | "baseURL" | "defaultHeaders"
  >;
}
