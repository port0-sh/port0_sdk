/**
 * Lazy loader for the compiled XYK note scripts.
 *
 * Each generated package is deserialised once and cached for the process
 * lifetime. Requires the WASM module from `@miden-sdk/miden-sdk` to be
 * initialised (the eager entry point does this at import time).
 */
import { NoteScript, Package } from "@miden-sdk/miden-sdk";
import { contractPackageBytes } from "../artifacts.js";

/** The five note packages shipped by the SDK. */
export type NoteKind = "admin" | "mint" | "burn" | "swap" | "collect";

/** Every note kind, in a stable order. */
export const NOTE_KINDS: readonly NoteKind[] = [
  "admin",
  "mint",
  "burn",
  "swap",
  "collect",
] as const;

const cache = new Map<NoteKind, NoteScript>();

/** Deserialises and caches the note script for a note kind. */
export function noteScript(kind: NoteKind): NoteScript {
  const cached = cache.get(kind);
  if (cached) {
    return cached;
  }
  const pkg = Package.deserialize(contractPackageBytes(kind));
  const script = NoteScript.fromPackage(pkg);
  cache.set(kind, script);
  return script;
}
