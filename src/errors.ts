/**
 * Exception hierarchy for any-llm gateway errors.
 *
 * Mirrors the Python SDK's exception classes used by the gateway provider.
 * In platform mode, OpenAI APIError status codes are mapped to these typed
 * errors so callers can handle specific failure modes.
 */

export interface AnyLLMErrorOptions {
  message?: string;
  statusCode?: number;
  originalError?: Error;
  providerName?: string;
}

export class AnyLLMError extends Error {
  static defaultMessage: string = "An error occurred";

  readonly statusCode?: number;
  readonly originalError?: Error;
  readonly providerName?: string;

  constructor(options: AnyLLMErrorOptions = {}) {
    const message = options.message ?? (new.target as typeof AnyLLMError).defaultMessage;
    super(message);
    this.name = new.target.name;
    this.statusCode = options.statusCode;
    this.originalError = options.originalError;
    this.providerName = options.providerName;
  }

  override toString(): string {
    if (this.providerName) {
      return `[${this.providerName}] ${this.message}`;
    }
    return this.message;
  }
}

/** Raised when authentication with the gateway fails (HTTP 401, 403). */
export class AuthenticationError extends AnyLLMError {
  static override defaultMessage = "Authentication failed";
}

/** Raised when the requested model is not found (HTTP 404). */
export class ModelNotFoundError extends AnyLLMError {
  static override defaultMessage = "Model not found";
}

/** Raised when the user's budget or credits are exhausted (HTTP 402). */
export class InsufficientFundsError extends AnyLLMError {
  static override defaultMessage = "Insufficient funds or budget exceeded";
}

/** Raised when the API rate limit is exceeded (HTTP 429). */
export class RateLimitError extends AnyLLMError {
  static override defaultMessage = "Rate limit exceeded";

  /** Value of the Retry-After header, when the server provides one. */
  readonly retryAfter?: string;

  constructor(options: AnyLLMErrorOptions & { retryAfter?: string } = {}) {
    super(options);
    this.retryAfter = options.retryAfter;
  }
}

/** Raised when the upstream provider is unreachable or errors (HTTP 502). */
export class UpstreamProviderError extends AnyLLMError {
  static override defaultMessage = "Upstream provider error";
}

/** Raised when the gateway times out waiting for the upstream provider (HTTP 504). */
export class GatewayTimeoutError extends AnyLLMError {
  static override defaultMessage = "Gateway timeout waiting for upstream provider";
}
