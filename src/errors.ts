/**
 * SDK error types.
 *
 * The pure math layer throws `PoolMathError` (mirroring the contract's
 * `PoolMathError`). Everything above it throws `XykError`, whose `code` is a
 * stable string the application can switch on.
 */

/** Stable error codes for SDK-level failures. */
export type XykErrorCode =
  | "NOT_A_POOL"
  | "POOL_NOT_FOUND"
  | "POOL_NOT_CONFIGURED"
  | "MISSING_SLOT"
  | "INVARIANT"
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_OPERATION";

export class XykError extends Error {
  readonly code: XykErrorCode;

  constructor(code: XykErrorCode, message: string) {
    super(message);
    this.name = "XykError";
    this.code = code;
  }
}
