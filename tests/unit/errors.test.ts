import { describe, expect, it } from "vitest";
import {
  AnyLLMError,
  AuthenticationError,
  BatchNotCompleteError,
  GatewayTimeoutError,
  InsufficientFundsError,
  ModelNotFoundError,
  RateLimitError,
  UpstreamProviderError,
} from "../../src/errors.js";

describe("AnyLLMError", () => {
  it("uses default message when none is provided", () => {
    const err = new AnyLLMError();
    expect(err.message).toBe("An error occurred");
    expect(err.name).toBe("AnyLLMError");
  });

  it("uses custom message when provided", () => {
    const err = new AnyLLMError({ message: "custom" });
    expect(err.message).toBe("custom");
  });

  it("stores statusCode, originalError, and providerName", () => {
    const orig = new Error("original");
    const err = new AnyLLMError({
      message: "test",
      statusCode: 500,
      originalError: orig,
      providerName: "gateway",
    });
    expect(err.statusCode).toBe(500);
    expect(err.originalError).toBe(orig);
    expect(err.providerName).toBe("gateway");
  });

  it("toString includes provider name when set", () => {
    const err = new AnyLLMError({
      message: "fail",
      providerName: "gateway",
    });
    expect(err.toString()).toBe("[gateway] fail");
  });

  it("toString returns just message when no provider name", () => {
    const err = new AnyLLMError({ message: "fail" });
    expect(err.toString()).toBe("fail");
  });

  it("is an instance of Error", () => {
    const err = new AnyLLMError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnyLLMError);
  });
});

describe("AuthenticationError", () => {
  it("uses its own default message", () => {
    const err = new AuthenticationError();
    expect(err.message).toBe("Authentication failed");
    expect(err.name).toBe("AuthenticationError");
  });

  it("is an instance of AnyLLMError", () => {
    expect(new AuthenticationError()).toBeInstanceOf(AnyLLMError);
  });
});

describe("ModelNotFoundError", () => {
  it("uses its own default message", () => {
    const err = new ModelNotFoundError();
    expect(err.message).toBe("Model not found");
    expect(err.name).toBe("ModelNotFoundError");
  });

  it("is an instance of AnyLLMError", () => {
    expect(new ModelNotFoundError()).toBeInstanceOf(AnyLLMError);
  });
});

describe("InsufficientFundsError", () => {
  it("uses its own default message", () => {
    const err = new InsufficientFundsError();
    expect(err.message).toBe("Insufficient funds or budget exceeded");
    expect(err.name).toBe("InsufficientFundsError");
  });

  it("is an instance of AnyLLMError", () => {
    expect(new InsufficientFundsError()).toBeInstanceOf(AnyLLMError);
  });
});

describe("RateLimitError", () => {
  it("uses its own default message", () => {
    const err = new RateLimitError();
    expect(err.message).toBe("Rate limit exceeded");
    expect(err.name).toBe("RateLimitError");
  });

  it("stores retryAfter", () => {
    const err = new RateLimitError({ retryAfter: "30" });
    expect(err.retryAfter).toBe("30");
  });

  it("retryAfter is undefined by default", () => {
    const err = new RateLimitError();
    expect(err.retryAfter).toBeUndefined();
  });

  it("is an instance of AnyLLMError", () => {
    expect(new RateLimitError()).toBeInstanceOf(AnyLLMError);
  });
});

describe("UpstreamProviderError", () => {
  it("uses its own default message", () => {
    const err = new UpstreamProviderError();
    expect(err.message).toBe("Upstream provider error");
    expect(err.name).toBe("UpstreamProviderError");
  });
});

describe("GatewayTimeoutError", () => {
  it("uses its own default message", () => {
    const err = new GatewayTimeoutError();
    expect(err.message).toBe("Gateway timeout waiting for upstream provider");
    expect(err.name).toBe("GatewayTimeoutError");
  });
});

describe("BatchNotCompleteError", () => {
  it("has correct defaultMessage", () => {
    const err = new BatchNotCompleteError();
    expect(err.message).toBe("Batch is not yet complete");
    expect(err.name).toBe("BatchNotCompleteError");
  });

  it("stores batchId and batchStatus", () => {
    const err = new BatchNotCompleteError({
      batchId: "batch_abc123",
      batchStatus: "in_progress",
    });
    expect(err.batchId).toBe("batch_abc123");
    expect(err.batchStatus).toBe("in_progress");
  });

  it("batchId and batchStatus are undefined by default", () => {
    const err = new BatchNotCompleteError();
    expect(err.batchId).toBeUndefined();
    expect(err.batchStatus).toBeUndefined();
  });

  it("is an instance of AnyLLMError", () => {
    const err = new BatchNotCompleteError();
    expect(err).toBeInstanceOf(AnyLLMError);
    expect(err).toBeInstanceOf(Error);
  });

  it("stores statusCode and providerName", () => {
    const err = new BatchNotCompleteError({
      statusCode: 409,
      providerName: "gateway",
      batchId: "batch_xyz",
    });
    expect(err.statusCode).toBe(409);
    expect(err.providerName).toBe("gateway");
  });
});
