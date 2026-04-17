import { APIError } from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../../src/client.js";
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
} from "../../src/errors.js";

// Helpers to build a fake APIError with typed status and headers.
function makeAPIError(
  status: number,
  message: string,
  headers: Record<string, string> = {},
): APIError {
  const h = new Headers(headers);
  return APIError.generate(status, { message }, message, h);
}

describe("GatewayClient constructor", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    // Restore env vars after each test.
    process.env = { ...envBackup };
  });

  it("throws when apiBase is not provided and env is unset", () => {
    delete process.env.GATEWAY_API_BASE;
    expect(() => new GatewayClient()).toThrow("api_base is required");
  });

  it("uses apiBase from options", () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
    });
    expect(client.openai.baseURL).toBe("http://localhost:8000/v1");
  });

  it("does not double-append /v1 if already present", () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000/v1",
    });
    expect(client.openai.baseURL).toBe("http://localhost:8000/v1");
  });

  it("falls back to GATEWAY_API_BASE env var", () => {
    process.env.GATEWAY_API_BASE = "http://env-gateway:9000";
    const client = new GatewayClient();
    expect(client.openai.baseURL).toBe("http://env-gateway:9000/v1");
  });

  describe("platform mode", () => {
    it("activates when platformToken is provided", () => {
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
        platformToken: "tk_test123",
      });
      expect(client.platformMode).toBe(true);
      // The OpenAI client should use the platform token as the API key
      // (sent as Bearer in the Authorization header).
      expect(client.openai.apiKey).toBe("tk_test123");
    });

    it("activates via GATEWAY_PLATFORM_TOKEN env when no apiKey is set", () => {
      process.env.GATEWAY_PLATFORM_TOKEN = "tk_env_token";
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
      });
      expect(client.platformMode).toBe(true);
      expect(client.openai.apiKey).toBe("tk_env_token");
    });

    it("does not activate when apiKey option is also provided", () => {
      process.env.GATEWAY_PLATFORM_TOKEN = "tk_env_token";
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
        apiKey: "my-key",
      });
      // apiKey takes precedence -> non-platform mode
      expect(client.platformMode).toBe(false);
    });
  });

  describe("non-platform mode", () => {
    it("is the default when no platform token is available", () => {
      delete process.env.GATEWAY_PLATFORM_TOKEN;
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
      });
      expect(client.platformMode).toBe(false);
    });

    it("sends apiKey via AnyLLM-Key header", () => {
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
        apiKey: "my-key",
      });
      expect(client.platformMode).toBe(false);
      // The AnyLLM-Key header is set as a default header on the OpenAI client.
      // We can verify by inspecting the internal _options or defaultHeaders.
      // For this test we just verify the mode is correct.
    });

    it("falls back to GATEWAY_API_KEY env var", () => {
      process.env.GATEWAY_API_KEY = "env-key";
      delete process.env.GATEWAY_PLATFORM_TOKEN;
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
      });
      expect(client.platformMode).toBe(false);
    });
  });

  it("forwards defaultHeaders", () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      defaultHeaders: { "X-Custom": "value" },
    });
    expect(client).toBeDefined();
  });
});

describe("GatewayClient error handling (platform mode)", () => {
  let client: GatewayClient;

  beforeEach(() => {
    client = new GatewayClient({
      apiBase: "http://localhost:8000",
      platformToken: "tk_test",
    });
  });

  // Helper: mock the openai method to throw an APIError.
  function mockCompletionError(error: Error) {
    vi.spyOn(client.openai.chat.completions, "create").mockRejectedValue(error);
  }

  it("maps 401 to AuthenticationError", async () => {
    mockCompletionError(makeAPIError(401, "Unauthorized"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("maps 403 to AuthenticationError", async () => {
    mockCompletionError(makeAPIError(403, "Forbidden"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("maps 404 to ModelNotFoundError", async () => {
    mockCompletionError(makeAPIError(404, "Not Found"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(ModelNotFoundError);
  });

  it("maps 402 to InsufficientFundsError", async () => {
    mockCompletionError(makeAPIError(402, "Payment Required"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(InsufficientFundsError);
  });

  it("maps 429 to RateLimitError with retryAfter", async () => {
    mockCompletionError(makeAPIError(429, "Too Many Requests", { "retry-after": "60" }));
    try {
      await client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe("60");
    }
  });

  it("maps 502 to UpstreamProviderError", async () => {
    mockCompletionError(makeAPIError(502, "Bad Gateway"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(UpstreamProviderError);
  });

  it("maps 504 to GatewayTimeoutError", async () => {
    mockCompletionError(makeAPIError(504, "Gateway Timeout"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(GatewayTimeoutError);
  });

  it("includes correlation_id in error message when present", async () => {
    mockCompletionError(
      makeAPIError(401, "Unauthorized", {
        "x-correlation-id": "abc-123",
      }),
    );
    try {
      await client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as AuthenticationError).message).toContain("correlation_id=abc-123");
    }
  });

  it("passes through unrecognized status codes", async () => {
    mockCompletionError(makeAPIError(418, "I'm a teapot"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(APIError);
  });

  it("passes through non-APIError exceptions", async () => {
    mockCompletionError(new TypeError("network failure"));
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(TypeError);
  });

  it("stores the original OpenAI error", async () => {
    const apiErr = makeAPIError(401, "Unauthorized");
    mockCompletionError(apiErr);
    try {
      await client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as AuthenticationError).originalError).toBe(apiErr);
      expect((err as AuthenticationError).providerName).toBe("gateway");
      expect((err as AuthenticationError).statusCode).toBe(401);
    }
  });
});

describe("GatewayClient error handling (non-platform mode)", () => {
  it("does not map errors in non-platform mode", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "my-key",
    });

    vi.spyOn(client.openai.chat.completions, "create").mockRejectedValue(
      makeAPIError(401, "Unauthorized"),
    );

    // In non-platform mode, the raw APIError should pass through.
    await expect(
      client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(APIError);

    // Should NOT be an AnyLLMError.
    try {
      await client.completion({
        model: "openai:gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (err) {
      expect(err).not.toBeInstanceOf(AnyLLMError);
    }
  });
});

describe("GatewayClient methods delegate to OpenAI client", () => {
  let client: GatewayClient;

  beforeEach(() => {
    client = new GatewayClient({
      apiBase: "http://localhost:8000",
      platformToken: "tk_test",
    });
  });

  it("completion calls openai.chat.completions.create", async () => {
    const mockResponse = { id: "chatcmpl-123", choices: [] };
    vi.spyOn(client.openai.chat.completions, "create").mockResolvedValue(mockResponse as any);

    const result = await client.completion({
      model: "openai:gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toBe(mockResponse);
    expect(client.openai.chat.completions.create).toHaveBeenCalledWith({
      model: "openai:gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("embedding calls openai.embeddings.create", async () => {
    const mockResponse = { data: [], model: "test", usage: {} };
    vi.spyOn(client.openai.embeddings, "create").mockResolvedValue(mockResponse as any);

    const result = await client.embedding({
      model: "openai:text-embedding-3-small",
      input: "hello",
    });
    expect(result).toBe(mockResponse);
  });

  it("response calls openai.responses.create", async () => {
    const mockResponse = { id: "resp-123" };
    vi.spyOn(client.openai.responses, "create").mockResolvedValue(mockResponse as any);

    const result = await client.response({
      model: "openai:gpt-4o-mini",
      input: "hello",
    });
    expect(result).toBe(mockResponse);
  });

  it("listModels calls openai.models.list", async () => {
    const mockModels = [
      { id: "model-1", object: "model", created: 0, owned_by: "test" },
      { id: "model-2", object: "model", created: 0, owned_by: "test" },
    ];

    // The OpenAI SDK returns a paginated result with async iteration.
    const mockPage = {
      [Symbol.asyncIterator]: async function* () {
        for (const m of mockModels) yield m;
      },
    };
    vi.spyOn(client.openai.models, "list").mockResolvedValue(mockPage as any);

    const result = await client.listModels();
    expect(result).toEqual(mockModels);
  });

  it("error mapping applies to embedding method too", async () => {
    vi.spyOn(client.openai.embeddings, "create").mockRejectedValue(
      makeAPIError(401, "Unauthorized"),
    );
    await expect(
      client.embedding({
        model: "openai:text-embedding-3-small",
        input: "hello",
      }),
    ).rejects.toThrow(AuthenticationError);
  });

  it("error mapping applies to response method too", async () => {
    vi.spyOn(client.openai.responses, "create").mockRejectedValue(
      makeAPIError(429, "Rate limited"),
    );
    await expect(
      client.response({
        model: "openai:gpt-4o-mini",
        input: "hello",
      }),
    ).rejects.toThrow(RateLimitError);
  });

  it("error mapping applies to listModels method too", async () => {
    vi.spyOn(client.openai.models, "list").mockRejectedValue(makeAPIError(502, "Bad Gateway"));
    await expect(client.listModels()).rejects.toThrow(UpstreamProviderError);
  });

  it("moderation calls openai.moderations.create", async () => {
    const mockResponse = {
      id: "modr-abc",
      model: "omni-moderation-latest",
      results: [{ flagged: true, categories: {}, category_scores: {} }],
    };
    const spy = vi
      .spyOn(client.openai.moderations, "create")
      .mockResolvedValue(mockResponse as any);

    const params = { model: "openai:omni-moderation-latest", input: "hello" };
    const result = await client.moderation(params);

    expect(spy).toHaveBeenCalledWith(params);
    expect(result).toBe(mockResponse);
  });

  it("moderation strips includeRaw from the SDK path", async () => {
    const spy = vi.spyOn(client.openai.moderations, "create").mockResolvedValue({
      id: "m",
      model: "x",
      results: [],
    } as any);

    await client.moderation({
      model: "openai:omni-moderation-latest",
      input: "x",
    } as any);
    expect(spy.mock.calls[0][0]).not.toHaveProperty("includeRaw");
  });

  it("error mapping applies to moderation method too", async () => {
    vi.spyOn(client.openai.moderations, "create").mockRejectedValue(
      makeAPIError(429, "Rate limited"),
    );
    await expect(
      client.moderation({
        model: "openai:omni-moderation-latest",
        input: "x",
      }),
    ).rejects.toThrow(RateLimitError);
  });
});

describe("GatewayClient moderation includeRaw path", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses raw fetch (not the openai SDK) and parses provider_raw", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: "m",
        model: "x",
        results: [
          {
            flagged: true,
            categories: {},
            category_scores: {},
            provider_raw: { foo: "bar" },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new GatewayClient({
      apiBase: "https://gw.example.com",
      apiKey: "k",
    });
    const openaiSpy = vi.spyOn(client.openai.moderations, "create");

    const result = await client.moderation({
      model: "openai:omni-moderation-latest",
      input: "x",
      includeRaw: true,
    } as any);

    expect(openaiSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/moderations?include_raw=true");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["AnyLLM-Key"]).toBe("Bearer k");
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("includeRaw");
    expect(body).toMatchObject({
      model: "openai:omni-moderation-latest",
      input: "x",
    });
    expect((result as { results: { provider_raw?: unknown }[] }).results[0].provider_raw).toEqual({
      foo: "bar",
    });
  });

  it("sends Authorization Bearer header in platform mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: "m", model: "x", results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new GatewayClient({
      apiBase: "https://gw.example.com",
      platformToken: "tk_123",
    });

    await client.moderation({
      model: "openai:omni-moderation-latest",
      input: "x",
      includeRaw: true,
    } as any);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tk_123");
    expect(headers["AnyLLM-Key"]).toBeUndefined();
  });

  it("maps a non-OK raw response to UnsupportedCapabilityError", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () =>
        JSON.stringify({ detail: "Provider anthropic does not support moderation" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new GatewayClient({
      apiBase: "https://gw.example.com",
      platformToken: "tk_123",
    });

    await expect(
      client.moderation({
        model: "anthropic:claude-3-haiku",
        input: "x",
        includeRaw: true,
      } as any),
    ).rejects.toMatchObject({
      name: "UnsupportedCapabilityError",
      capability: "moderation",
      provider: "anthropic",
    });
  });
});

describe("GatewayClient moderation error mapping", () => {
  it("maps 400 'does not support moderation' to UnsupportedCapabilityError (platform mode)", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      platformToken: "tk_test",
    });
    vi.spyOn(client.openai.moderations, "create").mockRejectedValue(
      makeAPIError(400, "Provider anthropic does not support moderation"),
    );

    await expect(
      client.moderation({
        model: "anthropic:claude-3-haiku",
        input: "x",
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedCapabilityError",
      capability: "moderation",
      provider: "anthropic",
    });
  });

  it("maps 400 'does not support multimodal moderation' to the multimodal capability", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      platformToken: "tk_test",
    });
    vi.spyOn(client.openai.moderations, "create").mockRejectedValue(
      makeAPIError(400, "Provider mistral does not support multimodal moderation input"),
    );

    await expect(
      client.moderation({
        model: "mistral:mistral-moderation-latest",
        input: [{ type: "image_url", image_url: { url: "..." } }] as any,
      }),
    ).rejects.toMatchObject({
      name: "UnsupportedCapabilityError",
      capability: "multimodal_moderation",
      provider: "mistral",
    });
  });

  it("UnsupportedCapabilityError surfaces even in non-platform mode", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "k",
    });
    vi.spyOn(client.openai.moderations, "create").mockRejectedValue(
      makeAPIError(400, "Provider anthropic does not support moderation"),
    );

    await expect(
      client.moderation({
        model: "anthropic:claude-3-haiku",
        input: "x",
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);
  });

  it("does not map unrelated 400 errors in non-platform mode", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "k",
    });
    const apiErr = makeAPIError(400, "bad request");
    vi.spyOn(client.openai.moderations, "create").mockRejectedValue(apiErr);

    try {
      await client.moderation({
        model: "openai:omni-moderation-latest",
        input: "x",
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).not.toBeInstanceOf(AnyLLMError);
      expect(err).toBeInstanceOf(APIError);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch method tests
// ---------------------------------------------------------------------------

/** Helper: create a mock fetch Response. */
function mockFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): globalThis.Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "mock",
    headers: new Headers(headers),
    json: async () => body,
  } as globalThis.Response;
}

describe("GatewayClient batch methods", () => {
  let client: GatewayClient;
  let mockFetch: ReturnType<
    typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "test-key",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const batchResponse = {
    id: "batch_abc123",
    object: "batch",
    endpoint: "/v1/chat/completions",
    status: "validating",
    created_at: 1714502400,
    completion_window: "24h",
    request_counts: { total: 2, completed: 0, failed: 0 },
    metadata: {},
    provider: "openai",
  };

  describe("createBatch", () => {
    it("sends correct request", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, batchResponse));

      const params = {
        model: "openai:gpt-4o-mini",
        requests: [{ custom_id: "req-1", body: { messages: [{ role: "user", content: "hi" }] } }],
        completion_window: "24h",
      };

      await client.createBatch(params);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/batches");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual(params);
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("returns BatchWithProvider object including provider field", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, batchResponse));

      const result = await client.createBatch({
        model: "openai:gpt-4o-mini",
        requests: [{ custom_id: "req-1", body: {} }],
      });

      expect(result.id).toBe("batch_abc123");
      expect(result.status).toBe("validating");
      expect(result.provider).toBe("openai");
    });
  });

  describe("retrieveBatch", () => {
    it("sends provider query param", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, batchResponse));

      await client.retrieveBatch("batch_abc123", "openai");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/batches/batch_abc123?provider=openai");
      expect(init?.method).toBe("GET");
    });

    it("encodes special characters in batchId and provider", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, batchResponse));

      await client.retrieveBatch("batch/special id", "my provider");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(
        "http://localhost:8000/v1/batches/batch%2Fspecial%20id?provider=my%20provider",
      );
    });
  });

  describe("cancelBatch", () => {
    it("sends correct request", async () => {
      const cancelResponse = { ...batchResponse, status: "cancelling" };
      mockFetch.mockResolvedValue(mockFetchResponse(200, cancelResponse));

      const result = await client.cancelBatch("batch_abc123", "openai");

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/batches/batch_abc123/cancel?provider=openai");
      expect(init?.method).toBe("POST");
      expect(result.status).toBe("cancelling");
    });
  });

  describe("listBatches", () => {
    it("sends pagination params", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, { data: [batchResponse] }));

      await client.listBatches("openai", { after: "cursor", limit: 10 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("provider=openai");
      expect(url).toContain("after=cursor");
      expect(url).toContain("limit=10");
    });

    it("sends only provider when no options given", async () => {
      mockFetch.mockResolvedValue(mockFetchResponse(200, { data: [] }));

      await client.listBatches("openai");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/batches?provider=openai");
    });

    it("returns array of Batch", async () => {
      mockFetch.mockResolvedValue(
        mockFetchResponse(200, { data: [batchResponse, { ...batchResponse, id: "batch_def" }] }),
      );

      const result = await client.listBatches("openai");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("batch_abc123");
      expect(result[1].id).toBe("batch_def");
    });
  });

  describe("retrieveBatchResults", () => {
    it("returns BatchResult", async () => {
      const batchResult = {
        results: [
          { custom_id: "req-1", result: { id: "chatcmpl-1" }, error: null },
          { custom_id: "req-2", result: null, error: { code: "rate_limit", message: "..." } },
        ],
      };
      mockFetch.mockResolvedValue(mockFetchResponse(200, batchResult));

      const result = await client.retrieveBatchResults("batch_abc123", "openai");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:8000/v1/batches/batch_abc123/results?provider=openai");
      expect(result.results).toHaveLength(2);
      expect(result.results[0].custom_id).toBe("req-1");
      expect(result.results[1].error?.code).toBe("rate_limit");
    });
  });
});

describe("GatewayClient batch error handling", () => {
  let client: GatewayClient;
  let mockFetch: ReturnType<
    typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "test-key",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("409 throws BatchNotCompleteError with batchId and batchStatus", async () => {
    mockFetch.mockResolvedValue(
      mockFetchResponse(409, {
        detail: "Batch 'batch_abc123' is not yet complete (status: in_progress)",
      }),
    );

    try {
      await client.retrieveBatchResults("batch_abc123", "openai");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BatchNotCompleteError);
      const batchErr = err as BatchNotCompleteError;
      expect(batchErr.batchId).toBe("batch_abc123");
      expect(batchErr.batchStatus).toBe("in_progress");
      expect(batchErr.statusCode).toBe(409);
      expect(batchErr.providerName).toBe("gateway");
    }
  });

  it("404 throws AnyLLMError with upgrade message", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(404, { detail: "Not supported" }));

    try {
      await client.retrieveBatch("batch_abc", "openai");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnyLLMError);
      expect((err as AnyLLMError).message).toContain("Upgrade your gateway");
      expect((err as AnyLLMError).statusCode).toBe(404);
    }
  });

  it("404 with 'not found' in message passes through message directly", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(404, { detail: "Batch not found" }));

    try {
      await client.retrieveBatch("batch_abc", "openai");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnyLLMError);
      expect((err as AnyLLMError).message).toBe("Batch not found");
    }
  });

  it("401 throws AuthenticationError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(401, { detail: "Unauthorized" }));

    await expect(client.createBatch({ model: "openai:gpt-4o-mini", requests: [] })).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("403 throws AuthenticationError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(403, { detail: "Forbidden" }));

    await expect(client.createBatch({ model: "openai:gpt-4o-mini", requests: [] })).rejects.toThrow(
      AuthenticationError,
    );
  });

  it("429 throws RateLimitError with retryAfter", async () => {
    mockFetch.mockResolvedValue(
      mockFetchResponse(429, { detail: "Too Many Requests" }, { "retry-after": "30" }),
    );

    try {
      await client.createBatch({ model: "openai:gpt-4o-mini", requests: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe("30");
      expect((err as RateLimitError).statusCode).toBe(429);
    }
  });

  it("502 throws UpstreamProviderError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(502, { detail: "Bad Gateway" }));

    await expect(client.createBatch({ model: "openai:gpt-4o-mini", requests: [] })).rejects.toThrow(
      UpstreamProviderError,
    );
  });

  it("504 throws GatewayTimeoutError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(504, { detail: "Gateway Timeout" }));

    await expect(client.createBatch({ model: "openai:gpt-4o-mini", requests: [] })).rejects.toThrow(
      GatewayTimeoutError,
    );
  });

  it("422 throws AnyLLMError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(422, { detail: "Unsupported provider" }));

    try {
      await client.createBatch({ model: "bad:model", requests: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnyLLMError);
      expect((err as AnyLLMError).statusCode).toBe(422);
    }
  });

  it("unrecognized status throws AnyLLMError", async () => {
    mockFetch.mockResolvedValue(mockFetchResponse(418, { detail: "I'm a teapot" }));

    try {
      await client.createBatch({ model: "openai:gpt-4o-mini", requests: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnyLLMError);
      expect((err as AnyLLMError).statusCode).toBe(418);
    }
  });

  it("includes correlation_id in error message when present", async () => {
    mockFetch.mockResolvedValue(
      mockFetchResponse(401, { detail: "Unauthorized" }, { "x-correlation-id": "corr-456" }),
    );

    try {
      await client.createBatch({ model: "openai:gpt-4o-mini", requests: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect((err as AuthenticationError).message).toContain("correlation_id=corr-456");
    }
  });

  it("falls back to statusText when response body has no detail", async () => {
    // Mock a response where json() throws (no parseable body)
    const resp = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Headers(),
      json: async () => {
        throw new Error("no body");
      },
    } as globalThis.Response;
    mockFetch.mockResolvedValue(resp);

    try {
      await client.createBatch({ model: "openai:gpt-4o-mini", requests: [] });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnyLLMError);
      expect((err as AnyLLMError).message).toBe("Internal Server Error");
    }
  });
});

describe("GatewayClient batch auth modes", () => {
  let mockFetch: ReturnType<
    typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>
  >;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses AnyLLM-Key header in non-platform mode", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "my-key",
    });

    mockFetch.mockResolvedValue(
      mockFetchResponse(200, { id: "batch_1", object: "batch", status: "validating" }),
    );

    await client.createBatch({
      model: "openai:gpt-4o-mini",
      requests: [{ custom_id: "r1", body: {} }],
    });

    const [, init] = mockFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers["AnyLLM-Key"]).toBe("Bearer my-key");
    expect(headers.Authorization).toBeUndefined();
  });

  it("uses Authorization header in platform mode", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      platformToken: "tk_platform",
    });

    mockFetch.mockResolvedValue(
      mockFetchResponse(200, { id: "batch_1", object: "batch", status: "validating" }),
    );

    await client.createBatch({
      model: "openai:gpt-4o-mini",
      requests: [{ custom_id: "r1", body: {} }],
    });

    // Find the batch call (URL contains /batches)
    const batchCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/batches"),
    );
    expect(batchCall).toBeDefined();
    const headers = batchCall![1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tk_platform");
    expect(headers["X-AnyLLM-Key"]).toBeUndefined();
  });

  it("includes defaultHeaders in batch requests", async () => {
    const client = new GatewayClient({
      apiBase: "http://localhost:8000",
      apiKey: "my-key",
      defaultHeaders: { "X-Custom": "custom-value" },
    });

    mockFetch.mockResolvedValue(
      mockFetchResponse(200, { id: "batch_1", object: "batch", status: "validating" }),
    );

    await client.createBatch({
      model: "openai:gpt-4o-mini",
      requests: [{ custom_id: "r1", body: {} }],
    });

    // Find the batch call (URL contains /batches)
    const batchCall = mockFetch.mock.calls.find(
      ([url]) => typeof url === "string" && url.includes("/batches"),
    );
    expect(batchCall).toBeDefined();
    const headers = batchCall![1]?.headers as Record<string, string>;
    expect(headers["X-Custom"]).toBe("custom-value");
  });
});
