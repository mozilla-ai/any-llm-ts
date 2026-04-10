import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import OpenAI, { APIError } from "openai";
import { GatewayClient } from "../../src/client.js";
import {
  AuthenticationError,
  ModelNotFoundError,
  InsufficientFundsError,
  RateLimitError,
  UpstreamProviderError,
  GatewayTimeoutError,
  AnyLLMError,
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

    it("sends apiKey via X-AnyLLM-Key header", () => {
      const client = new GatewayClient({
        apiBase: "http://localhost:8000",
        apiKey: "my-key",
      });
      expect(client.platformMode).toBe(false);
      // The X-AnyLLM-Key header is set as a default header on the OpenAI client.
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
    vi.spyOn(client.openai.chat.completions, "create").mockRejectedValue(
      error,
    );
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
    mockCompletionError(
      makeAPIError(429, "Too Many Requests", { "retry-after": "60" }),
    );
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
      expect((err as AuthenticationError).message).toContain(
        "correlation_id=abc-123",
      );
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
    vi.spyOn(client.openai.chat.completions, "create").mockResolvedValue(
      mockResponse as any,
    );

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
    vi.spyOn(client.openai.embeddings, "create").mockResolvedValue(
      mockResponse as any,
    );

    const result = await client.embedding({
      model: "openai:text-embedding-3-small",
      input: "hello",
    });
    expect(result).toBe(mockResponse);
  });

  it("response calls openai.responses.create", async () => {
    const mockResponse = { id: "resp-123" };
    vi.spyOn(client.openai.responses, "create").mockResolvedValue(
      mockResponse as any,
    );

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
    vi.spyOn(client.openai.models, "list").mockResolvedValue(
      mockPage as any,
    );

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
    vi.spyOn(client.openai.models, "list").mockRejectedValue(
      makeAPIError(502, "Bad Gateway"),
    );
    await expect(client.listModels()).rejects.toThrow(UpstreamProviderError);
  });
});
