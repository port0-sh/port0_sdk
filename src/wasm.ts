/**
 * Runtime access to the full web-sdk module.
 *
 * The browser entry re-exports every WASM class as a named export; the Node
 * entry re-exports a subset and exposes the rest (including the `FeltArray`,
 * `NoteArray`, and `StorageSlotArray` array wrappers) through `getWrappedSdk()`.
 * `wasmModule()` returns the complete module on both platforms so the SDK's
 * WASM-dependent layers never import the array wrappers as static named
 * exports.
 */
import * as sdk from "@miden-sdk/miden-sdk";

type WasmModule = typeof sdk & {
  getWrappedSdk?: () => typeof sdk;
};

let cached: typeof sdk | null = null;

export function wasmModule(): typeof sdk {
  if (cached) {
    return cached;
  }
  const anySdk = sdk as WasmModule;
  cached =
    typeof anySdk.getWrappedSdk === "function"
      ? anySdk.getWrappedSdk()
      : anySdk;
  return cached;
}
