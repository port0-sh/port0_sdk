import { CONTRACT_ARTIFACTS, type ContractKind } from "./generated/contracts.js";
import { decodeBase64 } from "./utils/base64.js";

/**
 * Compiled package bytes per contract kind, ready for `Package.deserialize`.
 * Account components become `AccountComponent`, note packages `NoteScript`.
 */
export function contractPackageBytes(kind: ContractKind): Uint8Array {
  return decodeBase64(CONTRACT_ARTIFACTS[kind]);
}

/** Every contract kind the SDK ships as a compiled package. */
export const CONTRACT_KINDS: readonly ContractKind[] = [
  "pool",
  "registry",
  "mint",
  "burn",
  "swap",
  "collect",
  "registry-collect",
  "register",
  "registry-config",
  "network-faucet",
  "launch",
] as const;
