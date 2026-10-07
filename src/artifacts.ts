import { CONTRACT_ARTIFACTS, type ContractKind } from "./generated/contracts.js";
import { decodeBase64 } from "./utils/base64.js";

/**
 * Returns the raw compiled package bytes for a contract kind.
 *
 * The bytes are the serialised Miden package (`.masp`) produced by
 * `cargo miden build --release`. Feed them to the web SDK:
 *
 * - notes: `NoteScript.fromPackage(Package.deserialize(bytes))`
 * - pool component: `AccountComponent.fromPackage(Package.deserialize(bytes), slots)`
 */
export function contractPackageBytes(kind: ContractKind): Uint8Array {
  return decodeBase64(CONTRACT_ARTIFACTS[kind]);
}

/** Every contract kind the SDK ships as a compiled package. */
export const CONTRACT_KINDS: readonly ContractKind[] = [
  "pool",
  "admin",
  "mint",
  "burn",
  "swap",
  "collect",
] as const;
