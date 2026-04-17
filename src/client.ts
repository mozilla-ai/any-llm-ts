/**
 * GatewayClient: TypeScript client for the any-llm gateway.
 *
 * Wraps the OpenAI Node.js SDK, adding gateway-specific auth handling
 * and error mapping for platform mode.
 */

import OpenAI, { APIError } from "openai";
import type { Batch } from "openai/resources/batches";
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
  AnyLLMError,
  AuthenticationError,
  BatchNotCompleteError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  RateLimitError,
  UnsupportedCapabilityError,
  UpstreamProviderError,
} from "./errors.js";
import type {
  BatchResult,
  BatchWithProvider,
  CreateBatchParams,
  GatewayClientOptions,
  ListBatchesOptions,
  ModerationCreateParams,
  ModerationCreateResponse,
  ModerationResponseExt,
} from "./types.js";

const PROVIDER_NAME = "gateway";
const GATEWAY_HEADER_NAME = "AnyLLM-Key";

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
 * - **Non-platform mode**: An API key is sent via a custom `AnyLLM-Key`
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

  /** Resolved gateway base URL (including `/v1` suffix). */
  private readonly baseURL: string;

  /** API key for non-platform mode, if set. */
  private readonly apiKey?: string;

  /** Platform token for platform mode, if set. */
  private readonly platformToken?: string;

  /** Auth headers for batch method direct HTTP calls. */
  private readonly authHeaders: Record<string, string>;

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

    this.baseURL = apiBase;

    const platformToken = options.platformToken ?? process.env[ENV_PLATFORM_TOKEN];
    const apiKey = options.apiKey ?? process.env[ENV_API_KEY] ?? "";

    const headers: Record<string, string> = { ...options.defaultHeaders };

    // Auth resolution (same logic as Python GatewayProvider.__init__):
    // 1. Explicit platformToken -> platform mode
    // 2. GATEWAY_PLATFORM_TOKEN env + no apiKey option -> platform mode
    // 3. Otherwise -> non-platform mode
    if (platformToken && !options.apiKey) {
      this.platformMode = true;
      this.platformToken = platformToken;
      this.openai = new OpenAI({
        apiKey: platformToken,
        baseURL: apiBase,
        defaultHeaders: headers,
        ...options.openaiOptions,
      });
    } else {
      this.platformMode = false;
      if (apiKey) {
        this.apiKey = apiKey;
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

    // Store auth headers for batch method direct HTTP calls.
    this.authHeaders = {};
    if (platformToken && !options.apiKey) {
      this.authHeaders.Authorization = `Bearer ${platformToken}`;
    } else if (apiKey) {
      this.authHeaders[GATEWAY_HEADER_NAME] = `Bearer ${apiKey}`;
    }
    if (options.defaultHeaders) {
      Object.assign(this.authHeaders, options.defaultHeaders);
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
   * Convert OpenAI APIError to typed any-llm exceptions.
   *
   * Most mappings only apply in platform mode; in non-platform mode the
   * original error propagates unchanged. The one exception is
   * {@link UnsupportedCapabilityError}, which is a logical error (the
   * selected provider cannot perform the requested capability) and
   * therefore surfaces in both modes.
   *
   * Extracts `Retry-After` and `X-Correlation-ID` response headers when
   * available.
   */
  private handleError(error: unknown): void {
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

    // Unsupported-capability is a logical error surfaced regardless of mode.
    if (status === 400 && detail.includes("does not support moderation")) {
      const provider = this.parseUnsupportedProvider(detail);
      const capability = detail.includes("multimodal") ? "multimodal_moderation" : "moderation";
      throw new UnsupportedCapabilityError({
        message: detail,
        statusCode: status,
        originalError: error,
        providerName: PROVIDER_NAME,
        provider,
        capability,
      });
    }

    // The rest of the mappings only apply in platform mode.
    if (!this.platformMode) return;

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

  /**
   * Parse the provider name out of a gateway 400 detail string like
   * `"Provider anthropic does not support moderation"`. Returns
   * `"unknown"` if the phrasing does not match.
   */
  private parseUnsupportedProvider(detail: string): string {
    const prefix = "Provider ";
    if (!detail.startsWith(prefix)) return "unknown";
    const rest = detail.slice(prefix.length);
    const end = rest.indexOf(" does not");
    if (end <= 0) return "unknown";
    return rest.slice(0, end);
  }

  // -- Batch operations -----------------------------------------------------

  /**
   * Create a batch job.
   *
   * @param params - Batch creation parameters including model and requests array.
   * @returns The created batch object including the gateway-injected `provider` field.
   */
  async createBatch(params: CreateBatchParams): Promise<BatchWithProvider> {
    return this.batchRequest<BatchWithProvider>("POST", "/batches", { body: params });
  }

  /**
   * Retrieve the status of a batch job.
   *
   * @param batchId - The ID of the batch to retrieve.
   * @param provider - The provider name (e.g., "openai").
   * @returns The batch object with current status.
   */
  async retrieveBatch(batchId: string, provider: string): Promise<Batch> {
    return this.batchRequest<Batch>(
      "GET",
      `/batches/${encodeURIComponent(batchId)}?provider=${encodeURIComponent(provider)}`,
    );
  }

  /**
   * Cancel a batch job.
   *
   * @param batchId - The ID of the batch to cancel.
   * @param provider - The provider name (e.g., "openai").
   * @returns The batch object with updated status.
   */
  async cancelBatch(batchId: string, provider: string): Promise<Batch> {
    return this.batchRequest<Batch>(
      "POST",
      `/batches/${encodeURIComponent(batchId)}/cancel?provider=${encodeURIComponent(provider)}`,
    );
  }

  /**
   * List batch jobs for a provider.
   *
   * @param provider - The provider name (e.g., "openai").
   * @param options - Optional pagination parameters.
   * @returns Array of batch objects.
   */
  async listBatches(provider: string, options?: ListBatchesOptions): Promise<Batch[]> {
    const params = new URLSearchParams({ provider });
    if (options?.after) params.set("after", options.after);
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    const response = await this.batchRequest<{ data: Batch[] }>(
      "GET",
      `/batches?${params.toString()}`,
    );
    return response.data;
  }

  /**
   * Retrieve the results of a completed batch job.
   *
   * @param batchId - The ID of the batch to retrieve results for.
   * @param provider - The provider name (e.g., "openai").
   * @returns The batch results containing per-request outcomes.
   * @throws {BatchNotCompleteError} If the batch is not yet complete.
   */
  async retrieveBatchResults(batchId: string, provider: string): Promise<BatchResult> {
    return this.batchRequest<BatchResult>(
      "GET",
      `/batches/${encodeURIComponent(batchId)}/results?provider=${encodeURIComponent(provider)}`,
    );
  }

  // -- Batch HTTP helpers ---------------------------------------------------

  /**
   * Make a direct HTTP request for batch operations.
   * Unlike completion/embedding methods which use this.openai, batch methods
   * use direct fetch because the gateway batch API has a custom JSON format.
   */
  private async batchRequest<T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown },
  ): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.authHeaders,
    };

    const response = await fetch(url, {
      method,
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
      await this.handleBatchError(response);
    }

    return (await response.json()) as T;
  }

  /**
   * Map batch HTTP errors to typed SDK errors.
   * This is used by batch methods which use direct fetch (not this.openai).
   */
  private async handleBatchError(response: globalThis.Response): Promise<never> {
    const body = await response.json().catch(() => ({}));
    const detail = (body as Record<string, unknown>)?.detail ?? response.statusText;
    const message = typeof detail === "string" ? detail : response.statusText;
    const correlationId = response.headers.get("x-correlation-id");
    const fullMessage = correlationId ? `${message} (correlation_id=${correlationId})` : message;

    switch (response.status) {
      case 401:
      case 403:
        throw new AuthenticationError({
          message: fullMessage,
          statusCode: response.status,
          providerName: PROVIDER_NAME,
        });
      case 404:
        throw new AnyLLMError({
          message: fullMessage.includes("not found")
            ? fullMessage
            : `This gateway does not support batch operations. Upgrade your gateway. (${fullMessage})`,
          statusCode: 404,
          providerName: PROVIDER_NAME,
        });
      case 409:
        throw new BatchNotCompleteError({
          message: fullMessage,
          statusCode: 409,
          providerName: PROVIDER_NAME,
          batchId: extractBatchId(message),
          batchStatus: extractStatus(message),
        });
      case 422:
        throw new AnyLLMError({
          message: fullMessage,
          statusCode: 422,
          providerName: PROVIDER_NAME,
        });
      case 429:
        throw new RateLimitError({
          message: fullMessage,
          statusCode: 429,
          providerName: PROVIDER_NAME,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        });
      case 502:
        throw new UpstreamProviderError({
          message: fullMessage,
          statusCode: 502,
          providerName: PROVIDER_NAME,
        });
      case 504:
        throw new GatewayTimeoutError({
          message: fullMessage,
          statusCode: 504,
          providerName: PROVIDER_NAME,
        });
      default:
        throw new AnyLLMError({
          message: fullMessage,
          statusCode: response.status,
          providerName: PROVIDER_NAME,
        });
    }
  }
}

function extractBatchId(message: string): string | undefined {
  const match = message.match(/Batch '([^']+)'/);
  return match?.[1];
}

function extractStatus(message: string): string | undefined {
  const match = message.match(/status: (\w+)/);
  return match?.[1];
}
