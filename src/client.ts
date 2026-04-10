/**
 * GatewayClient: TypeScript client for the any-llm gateway.
 *
 * Wraps the OpenAI Node.js SDK, adding gateway-specific auth handling
 * and error mapping for platform mode.
 */

import OpenAI, { APIError } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions";
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from "openai/resources/embeddings";
import type { Model } from "openai/resources/models";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { Stream } from "openai/streaming";

import {
  AuthenticationError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  RateLimitError,
  UpstreamProviderError,
} from "./errors.js";
import type { GatewayClientOptions } from "./types.js";

const PROVIDER_NAME = "gateway";
const GATEWAY_HEADER_NAME = "X-AnyLLM-Key";

const ENV_API_BASE = "GATEWAY_API_BASE";
const ENV_API_KEY = "GATEWAY_API_KEY";
const ENV_PLATFORM_TOKEN = "GATEWAY_PLATFORM_TOKEN";

/** Map of HTTP status codes to error constructors (for simple 1:1 mappings). */
const STATUS_TO_ERROR: Record<number, typeof AuthenticationError | typeof ModelNotFoundError> = {
  401: AuthenticationError,
  403: AuthenticationError,
  404: ModelNotFoundError,
};

/**
 * Client for the any-llm gateway.
 *
 * Supports two authentication modes (mirroring the Python GatewayProvider):
 *
 * - **Platform mode**: A Bearer token is sent in the standard Authorization
 *   header. Errors are mapped to typed any-llm exceptions.
 * - **Non-platform mode**: An API key is sent via a custom `X-AnyLLM-Key`
 *   header. Errors from the OpenAI SDK pass through unmodified.
 *
 * @example
 * ```ts
 * const client = new GatewayClient({
 *   apiBase: "http://localhost:8000",
 *   platformToken: "tk_xxx",
 * });
 *
 * const res = await client.completion({
 *   model: "openai:gpt-4o-mini",
 *   messages: [{ role: "user", content: "Hello" }],
 * });
 * console.log(res.choices[0].message.content);
 * ```
 */
export class GatewayClient {
  /** The underlying OpenAI client instance. */
  readonly openai: OpenAI;

  /** Whether the client is operating in platform mode. */
  readonly platformMode: boolean;

  constructor(options: GatewayClientOptions = {}) {
    const rawBase = options.apiBase ?? process.env[ENV_API_BASE];

    if (!rawBase) {
      throw new Error(
        `api_base is required for the gateway client. ` +
          `Pass it as options.apiBase or set the ${ENV_API_BASE} environment variable.`,
      );
    }

    // The OpenAI SDK v5 does not auto-append /v1 to the base URL.
    // Ensure the base URL includes it since the gateway expects
    // OpenAI-compatible paths like /v1/chat/completions.
    const apiBase = rawBase.replace(/\/+$/, "").endsWith("/v1")
      ? rawBase
      : `${rawBase.replace(/\/+$/, "")}/v1`;

    const platformToken = options.platformToken ?? process.env[ENV_PLATFORM_TOKEN];
    const apiKey = options.apiKey ?? process.env[ENV_API_KEY] ?? "";

    const headers: Record<string, string> = { ...options.defaultHeaders };

    // Auth resolution (same logic as Python GatewayProvider.__init__):
    // 1. Explicit platformToken -> platform mode
    // 2. GATEWAY_PLATFORM_TOKEN env + no apiKey option -> platform mode
    // 3. Otherwise -> non-platform mode
    if (platformToken && !options.apiKey) {
      this.platformMode = true;
      this.openai = new OpenAI({
        apiKey: platformToken,
        baseURL: apiBase,
        defaultHeaders: headers,
        ...options.openaiOptions,
      });
    } else {
      this.platformMode = false;
      if (apiKey) {
        headers[GATEWAY_HEADER_NAME] = `Bearer ${apiKey}`;
      }
      // In non-platform mode we still need to pass *some* API key to the
      // OpenAI client (it validates the field). An empty string works because
      // auth is handled via the custom header.
      this.openai = new OpenAI({
        apiKey: apiKey || "unused",
        baseURL: apiBase,
        defaultHeaders: headers,
        ...options.openaiOptions,
      });
    }
  }

  // -- Chat completions -----------------------------------------------------

  /**
   * Create a chat completion (non-streaming).
   */
  async completion(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion>;

  /**
   * Create a chat completion (streaming).
   */
  async completion(
    params: ChatCompletionCreateParamsStreaming,
  ): Promise<Stream<ChatCompletionChunk>>;

  /**
   * Create a chat completion.
   *
   * When `stream: true` is set, returns an async iterable of chunks.
   */
  async completion(
    params: ChatCompletionCreateParams,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>>;

  async completion(
    params: ChatCompletionCreateParams,
  ): Promise<ChatCompletion | Stream<ChatCompletionChunk>> {
    try {
      return await this.openai.chat.completions.create(params);
    } catch (error) {
      this.handleError(error);
      throw error; // unreachable when handleError throws
    }
  }

  // -- Responses API --------------------------------------------------------

  /**
   * Create a response (non-streaming).
   */
  async response(params: ResponseCreateParamsNonStreaming): Promise<Response>;

  /**
   * Create a response (streaming).
   */
  async response(params: ResponseCreateParamsStreaming): Promise<Stream<ResponseStreamEvent>>;

  /**
   * Create a response using the OpenAI Responses API.
   */
  async response(
    params: ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming,
  ): Promise<Response | Stream<ResponseStreamEvent>>;

  async response(
    params: ResponseCreateParamsNonStreaming | ResponseCreateParamsStreaming,
  ): Promise<Response | Stream<ResponseStreamEvent>> {
    try {
      // The union type doesn't match the SDK's overloaded signatures directly.
      return await this.openai.responses.create(params as ResponseCreateParamsNonStreaming);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  // -- Embeddings -----------------------------------------------------------

  /**
   * Create embeddings for the given input.
   */
  async embedding(params: EmbeddingCreateParams): Promise<CreateEmbeddingResponse> {
    try {
      return await this.openai.embeddings.create(params);
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  // -- Models ---------------------------------------------------------------

  /**
   * List available models from the gateway.
   */
  async listModels(): Promise<Model[]> {
    try {
      const page = await this.openai.models.list();
      const models: Model[] = [];
      for await (const model of page) {
        models.push(model);
      }
      return models;
    } catch (error) {
      this.handleError(error);
      throw error;
    }
  }

  // -- Error handling -------------------------------------------------------

  /**
   * Convert OpenAI APIError to typed any-llm exceptions in platform mode.
   *
   * Extracts `Retry-After` and `X-Correlation-ID` response headers when
   * available. In non-platform mode this is a no-op and the original error
   * propagates unchanged.
   */
  private handleError(error: unknown): void {
    if (!this.platformMode) return;
    if (!(error instanceof APIError)) return;

    const status = error.status;
    if (status === undefined) return;

    const headers = error.headers;
    const correlationId = headers?.get?.("x-correlation-id") ?? undefined;
    const retryAfter = headers?.get?.("retry-after") ?? undefined;

    let detail = error.message;
    if (correlationId) {
      detail = `${detail} (correlation_id=${correlationId})`;
    }

    const ErrorClass = STATUS_TO_ERROR[status];
    if (ErrorClass) {
      throw new ErrorClass({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
      });
    }

    if (status === 402) {
      throw new InsufficientFundsError({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
      });
    }

    if (status === 429) {
      throw new RateLimitError({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
        retryAfter,
      });
    }

    if (status === 502) {
      throw new UpstreamProviderError({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
      });
    }

    if (status === 504) {
      throw new GatewayTimeoutError({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
      });
    }

    // Unrecognized status: let the original error propagate.
  }
}
