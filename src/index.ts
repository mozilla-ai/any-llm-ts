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

export {
  AnyLLMError,
  AuthenticationError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  RateLimitError,
  UpstreamProviderError,
} from "./errors.js";

export type {
  AnyLLMErrorOptions,
} from "./errors.js";

export type {
  GatewayClientOptions,
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  CreateEmbeddingResponse,
  EmbeddingCreateParams,
  Model,
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
  Stream,
} from "./types.js";
