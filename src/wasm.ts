/**
 * The full web-sdk module on both platforms: the browser entry re-exports every
 * WASM class, the Node entry exposes the array wrappers only through
 * `getWrappedSdk()`, so the SDK resolves them at runtime rather than importing
 * them as named exports.
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
