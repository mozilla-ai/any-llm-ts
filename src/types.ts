/**
 * Configuration and type re-exports for the any-llm gateway client.
 */

import type OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";

// Batches
export type { Batch } from "openai/resources/batches";

import type { Batch } from "openai/resources/batches";

/**
 * Batch response with the gateway-injected `provider` field.
 *
 * The gateway adds a `provider` string to the response on `POST /v1/batches`
 * (create). The OpenAI `Batch` type does not include this field, so this
 * intersection type captures it for callers who need it.
 */
export type BatchWithProvider = Batch & { provider: string };
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
// Moderation — re-exported from the OpenAI SDK for the default path.
export type {
  Moderation,
  ModerationCreateParams,
  ModerationCreateResponse,
} from "openai/resources/moderations";

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

// ── Rerank types (no OpenAI SDK equivalent) ──────────────────────

/** Parameters for a rerank request. */
export interface RerankParams {
  /** Provider-prefixed model ID, e.g. "cohere:rerank-v3.5" */
  model: string;
  /** The search query */
  query: string;
  /** Documents to rerank */
  documents: string[];
  /** Max results to return */
  top_n?: number;
  /** Per-document token truncation limit */
  max_tokens_per_doc?: number;
  /** User ID for usage attribution (gateway) */
  user?: string;
}

/** A single reranked result. */
export interface RerankResult {
  /** Zero-based index into the original documents array */
  index: number;
  /** Relevance score (higher = more relevant) */
  relevance_score: number;
}

/** Provider-specific billing metadata. */
export interface RerankMeta {
  billed_units?: Record<string, number>;
  tokens?: Record<string, number>;
}

/** Normalized token usage. */
export interface RerankUsage {
  total_tokens?: number;
}

/** Rerank response from the gateway. */
export interface RerankResponse {
  id: string;
  results: RerankResult[];
  meta?: RerankMeta;
  usage?: RerankUsage;
}

/**
 * Options for constructing a {@link GatewayClient}.
 *
 * Auth resolution order (mirrors the Python GatewayProvider):
 *  1. Explicit `platformToken` -> platform mode (Bearer token in Authorization header)
 *  2. `GATEWAY_PLATFORM_TOKEN` env var (when no `apiKey`) -> platform mode
 *  3. `apiKey` or `GATEWAY_API_KEY` env var -> non-platform mode (AnyLLM-Key header)
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
   * Sent via the `AnyLLM-Key: Bearer <key>` header.
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

/**
 * Extended moderation result with optional `provider_raw`. Returned by
 * {@link GatewayClient.moderation} only when the caller passes
 * `{ includeRaw: true }`.
 */
export interface ModerationResultExt {
  category_applied_input_types?: Record<string, string[]>;
  category_scores: Record<string, number>;
  categories: Record<string, boolean>;
  flagged: boolean;
  provider_raw?: unknown;
}

/**
 * Extended moderation response shape used when `includeRaw: true` is
 * requested. Identical to OpenAI's shape but with {@link ModerationResultExt}
 * elements that preserve the provider's raw response body.
 */
export interface ModerationResponseExt {
  id: string;
  model: string;
  results: ModerationResultExt[];
}
