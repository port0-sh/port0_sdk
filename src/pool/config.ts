import type { AccountId } from "@miden-sdk/miden-sdk";
import type { PoolNoteKind } from "../notes/scripts.js";
import type { PoolNoteFees } from "./create.js";

/**
 * Per-pool configuration the SDK needs to build operations: the pool id, the
 * network-note fee faucet, and the per-note-kind consumption fee schedule set
 * at pool creation.
 */
export interface PoolConfig {
  poolId: AccountId;
  feeFaucetId: AccountId;
  noteFees: PoolNoteFees;
  /** Default margin for deadline computation; only used by `XykClient`. */
  deadlineMarginSeconds?: bigint;
}

export const DEFAULT_DEADLINE_MARGIN_SECONDS = 3600n;

/** The consumption fee for a note kind, defaulting to zero. */
export function noteFee(noteFees: PoolNoteFees, kind: PoolNoteKind): bigint {
  return noteFees[kind] ?? 0n;
}
