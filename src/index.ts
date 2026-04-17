/**
 * @mozilla-ai/any-llm - TypeScript SDK for the any-llm gateway.
 *
 * @example
 * ```ts
 * import { GatewayClient } from "@mozilla-ai/any-llm";
 *
 * const client = new GatewayClient({
 *   apiBase: "http://localhost:8000",
 *   platformToken: "tk_xxx",
 * });
 *
 * const res = await client.completion({
 *   model: "openai:gpt-4o-mini",
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 * ```
 */

export { GatewayClient } from "./client.js";
export type { AnyLLMErrorOptions } from "./errors.js";
export {
  AnyLLMError,
  AuthenticationError,
  BatchNotCompleteError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  RateLimitError,
  UpstreamProviderError,
} from "./errors.js";

export type {
  Batch,
  BatchRequestItem,
  BatchResult,
  BatchResultError,
  BatchResultItem,
  BatchWithProvider,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  CreateBatchParams,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  GatewayClientOptions,
  ListBatchesOptions,
  Model,
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
  Stream,
} from "./types.js";
