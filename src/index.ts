/**
 * @mozilla-ai/otari - TypeScript SDK for the otari gateway.
 *
 * @example
 * ```ts
 * import { OtariClient } from "@mozilla-ai/otari";
 *
 * const client = new OtariClient({
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

export { OtariClient } from "./client.js";
export type { OtariErrorOptions } from "./errors.js";
export {
  AuthenticationError,
  BatchNotCompleteError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  OtariError,
  RateLimitError,
  UnsupportedCapabilityError,
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
  ListBatchesOptions,
  Model,
  Moderation,
  ModerationCreateParams,
  ModerationCreateResponse,
  ModerationResponseExt,
  ModerationResultExt,
  OtariClientOptions,
  RerankMeta,
  RerankParams,
  RerankResponse,
  RerankResult,
  RerankUsage,
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
  Stream,
} from "./types.js";
