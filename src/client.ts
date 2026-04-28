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
  RerankParams,
  RerankResponse,
} from "./types.js";

const PROVIDER_NAME = "gateway";
const GATEWAY_HEADER_NAME = "AnyLLM-Key";

/**
 * Locked phrasing used by the gateway to signal that the selected
 * provider does not support a moderation request. Matches both the
 * plain "does not support moderation" and "does not support multimodal
 * moderation …" forms.
 */
const UNSUPPORTED_MODERATION_RE = /does not support (?:multimodal )?moderation/;

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

  // -- Moderation -----------------------------------------------------------

  /**
   * Run a content moderation check via the gateway.
   */
  async moderation(params: ModerationCreateParams): Promise<ModerationCreateResponse>;

  /**
   * Run a content moderation check with the provider's raw response body
   * preserved under each result's `provider_raw` field. Bypasses the
   * OpenAI SDK, which strips unknown fields.
   */
  async moderation(
    params: ModerationCreateParams & { includeRaw: true },
  ): Promise<ModerationResponseExt>;

  async moderation(
    params: ModerationCreateParams & { includeRaw?: boolean },
  ): Promise<ModerationCreateResponse | ModerationResponseExt> {
    const { includeRaw, ...rest } = params as ModerationCreateParams & {
      includeRaw?: boolean;
    };
    try {
      if (includeRaw) {
        return await this.rawModerationFetch(rest as ModerationCreateParams);
      }
      return await this.openai.moderations.create(rest as ModerationCreateParams);
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

  // -- Rerank ---------------------------------------------------------------

  /**
   * Rerank documents by relevance to a query.
   *
   * @param params - Rerank parameters including model, query, and documents.
   * @returns Rerank response with scored and sorted results.
   * @throws {AuthenticationError} If the API key is invalid.
   * @throws {RateLimitError} If the rate limit is exceeded.
   *
   * @example
   * ```ts
   * const result = await client.rerank({
   *   model: "cohere:rerank-v3.5",
   *   query: "climate change",
   *   documents: ["doc1", "doc2", "doc3"],
   *   top_n: 2,
   * });
   * ```
   */
  async rerank(params: RerankParams): Promise<RerankResponse> {
    try {
      const response = await this.openai.post("/rerank", {
        body: params,
      });
      return response as RerankResponse;
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
    if (status === 400 && UNSUPPORTED_MODERATION_RE.test(detail)) {
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
   * `"Provider anthropic does not support moderation"`. The OpenAI SDK
   * often prepends the status code to the message (for example
   * `"400 Provider anthropic does not support moderation"`), so we
   * search for the phrase rather than anchoring to the start.
   *
   * Returns `"unknown"` if the phrasing does not match.
   */
  private parseUnsupportedProvider(detail: string): string {
    const match = detail.match(/Provider\s+(\S+)\s+does not/);
    return match ? match[1] : "unknown";
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

  // -- Moderation raw-fetch helpers ----------------------------------------

  /**
   * POST /v1/moderations?include_raw=true using a direct fetch.
   *
   * The OpenAI SDK strips unknown fields from responses, so we can't use
   * it when the caller wants to see the provider's raw body. Errors are
   * routed through {@link buildErrorFromStatus} for consistent mapping.
   */
  private async rawModerationFetch(params: ModerationCreateParams): Promise<ModerationResponseExt> {
    const url = new URL(`${this.baseURL}/moderations`);
    url.searchParams.set("include_raw", "true");

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.authHeaders,
    };

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const body = await response.text();
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { detail?: string };
        if (parsed.detail) detail = parsed.detail;
      } catch {
        // Body is not JSON; keep the raw text as the detail.
      }
      throw this.buildErrorFromStatus(response.status, detail, response.headers);
    }

    return (await response.json()) as ModerationResponseExt;
  }

  /**
   * Map a non-OK HTTP response from the raw moderation fetch to a typed
   * any-llm error, mirroring the logic in {@link handleError}. Inlined
   * (rather than reusing handleError) to avoid synthesizing an APIError.
   */
  private buildErrorFromStatus(status: number, detail: string, headers: Headers): Error {
    const correlationId = headers.get("x-correlation-id") ?? undefined;
    const retryAfter = headers.get("retry-after") ?? undefined;
    const message = correlationId ? `${detail} (correlation_id=${correlationId})` : detail;

    const base = { message, statusCode: status, providerName: PROVIDER_NAME };

    if (status === 400 && UNSUPPORTED_MODERATION_RE.test(detail)) {
      const provider = this.parseUnsupportedProvider(detail);
      const capability = detail.includes("multimodal") ? "multimodal_moderation" : "moderation";
      return new UnsupportedCapabilityError({ ...base, provider, capability });
    }

    // Remaining mappings only apply in platform mode (same policy as the
    // SDK path). In non-platform mode, surface a generic Error.
    if (!this.platformMode) {
      return new Error(`${status}: ${detail}`);
    }

    switch (status) {
      case 401:
      case 403:
        return new AuthenticationError(base);
      case 402:
        return new InsufficientFundsError(base);
      case 404:
        return new ModelNotFoundError(base);
      case 429:
        return new RateLimitError({ ...base, retryAfter });
      case 502:
        return new UpstreamProviderError(base);
      case 504:
        return new GatewayTimeoutError(base);
      default:
        return new Error(`${status}: ${detail}`);
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
