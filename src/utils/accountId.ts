/**
 * Account id normalisation for the public builder inputs.
 *
 * Callers hold ids as hex strings in configuration and as `AccountId` objects
 * from the client, and the WASM constructors require the object. One helper, so a
 * string reaching a builder is not an "expected instance of AccountId" surprise.
 */
import { AccountId } from "@miden-sdk/miden-sdk";

/** An account id from a parsed value, a hex string, or a bech32 address. */
export function asAccountId(value: AccountId | string): AccountId {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  try {
    return trimmed.startsWith("0x") || trimmed.startsWith("0X")
      ? AccountId.fromHex(trimmed)
      : AccountId.fromBech32(trimmed);
  } catch {
    throw new Error(
      `not an account id: expected 0x-prefixed hex or a bech32 address, got "${value}"`,
    );
  }
}
