/**
 * Base class for all structured Friday domain errors.
 *
 * Provides a standard shape so the HTTP error mapper can derive
 * status codes and response bodies without inspecting free-form messages.
 */
export class FridayDomainError extends Error {
  override readonly name: string = "FridayDomainError";

  constructor(
    /** Machine-readable error code, e.g. "WORKFLOW_NOT_FOUND". */
    public readonly code: string,
    /** Human-readable description. */
    message: string,
    options?: {
      httpStatus?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.httpStatus = options?.httpStatus ?? 500;
    this.retryable = options?.retryable ?? false;
    this.details = options?.details ?? {};
  }

  /** HTTP status code to surface through the API layer. */
  readonly httpStatus: number;

  /** Whether the caller may retry this operation. */
  readonly retryable: boolean;

  /** Arbitrary structured context for debugging / logging. */
  readonly details: Record<string, unknown>;
}
