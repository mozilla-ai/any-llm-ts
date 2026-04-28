/**
 * Exception hierarchy for otari gateway errors.
 *
 * Mirrors the Python SDK's exception classes used by the gateway provider.
 * In platform mode, OpenAI APIError status codes are mapped to these typed
 * errors so callers can handle specific failure modes.
 */

export interface OtariErrorOptions {
  message?: string;
  statusCode?: number;
  originalError?: Error;
  providerName?: string;
}

export class OtariError extends Error {
  static defaultMessage: string = "An error occurred";

  readonly statusCode?: number;
  readonly originalError?: Error;
  readonly providerName?: string;

  constructor(options: OtariErrorOptions = {}) {
    const message = options.message ?? (new.target as typeof OtariError).defaultMessage;
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
export class AuthenticationError extends OtariError {
  static override defaultMessage = "Authentication failed";
}

/** Raised when the requested model is not found (HTTP 404). */
export class ModelNotFoundError extends OtariError {
  static override defaultMessage = "Model not found";
}

/** Raised when the user's budget or credits are exhausted (HTTP 402). */
export class InsufficientFundsError extends OtariError {
  static override defaultMessage = "Insufficient funds or budget exceeded";
}

/** Raised when the API rate limit is exceeded (HTTP 429). */
export class RateLimitError extends OtariError {
  static override defaultMessage = "Rate limit exceeded";

  /** Value of the Retry-After header, when the server provides one. */
  readonly retryAfter?: string;

  constructor(options: OtariErrorOptions & { retryAfter?: string } = {}) {
    super(options);
    this.retryAfter = options.retryAfter;
  }
}

/** Raised when the upstream provider is unreachable or errors (HTTP 502). */
export class UpstreamProviderError extends OtariError {
  static override defaultMessage = "Upstream provider error";
}

/** Raised when the gateway times out waiting for the upstream provider (HTTP 504). */
export class GatewayTimeoutError extends OtariError {
  static override defaultMessage = "Gateway timeout waiting for upstream provider";
}

/** Raised when attempting to retrieve results for a batch that is not yet complete (HTTP 409). */
export class BatchNotCompleteError extends OtariError {
  static override defaultMessage = "Batch is not yet complete";
  readonly batchId?: string;
  readonly batchStatus?: string;

  constructor(options: OtariErrorOptions & { batchId?: string; batchStatus?: string } = {}) {
    super(options);
    this.batchId = options.batchId;
    this.batchStatus = options.batchStatus;
  }
}

/**
 * Raised when the gateway reports that the selected provider does not
 * support a requested capability (e.g. moderation).
 *
 * Detected by matching the gateway's 400 body detail against the
 * well-known phrasing `"does not support moderation"` (extended in the
 * future for other capabilities).
 */
export class UnsupportedCapabilityError extends OtariError {
  static override defaultMessage = "The selected provider does not support this capability";

  /** Capability that was requested (e.g. `"moderation"`, `"multimodal_moderation"`). */
  readonly capability: string;

  /** Provider name reported by the gateway (e.g. `"anthropic"`). */
  readonly provider: string;

  constructor(options: OtariErrorOptions & { capability: string; provider: string }) {
    super(options);
    this.capability = options.capability;
    this.provider = options.provider;
  }
}
