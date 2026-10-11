/**
 * Pool identification and a local registry.
 *
 * The node RPC has no account-listing-by-code-root endpoint, so chain-wide
 * discovery stays with the product's indexer. The SDK ships what a client can
 * check locally: whether a fetched account is an XYK pool, by verifying it is
 * a network account whose note-script allowlist contains every XYK note root.
 */
import type { Account, AccountId } from "@miden-sdk/miden-sdk";
import { POOL_NOTE_KINDS, noteScript } from "../notes/scripts.js";

/** The XYK note script roots, keyed by kind, as lowercase hex. */
export function xykNoteScriptRoots(): Record<
  (typeof POOL_NOTE_KINDS)[number],
  string
> {
  return Object.fromEntries(
    POOL_NOTE_KINDS.map((kind) => [kind, noteScript(kind).root().toHex()]),
  ) as Record<(typeof POOL_NOTE_KINDS)[number], string>;
}

/** True when `account` is a network account allowlisting all five XYK notes. */
export function isXykPool(account: Account): boolean {
  if (!account.isNetworkAccount()) {
    return false;
  }
  const allowlist = new Set(
    (account.networkNoteAllowlist() ?? []).map((root) => root.toHex()),
  );
  return POOL_NOTE_KINDS.every((kind) => allowlist.has(noteScript(kind).root().toHex()));
}

/** A local, caller-maintained pool id registry. */
export class PoolRegistry {
  private readonly pools = new Map<string, AccountId>();

  register(poolId: AccountId): void {
    this.pools.set(poolId.toString(), poolId);
  }

  get(canonicalId: string): AccountId | undefined {
    return this.pools.get(canonicalId);
  }

  list(): AccountId[] {
    return [...this.pools.values()];
  }
}
