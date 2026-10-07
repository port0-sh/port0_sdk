/**
 * Decodes a base64 string into bytes, in both the browser and Node.js.
 *
 * `atob` is the browser primitive; `Buffer` is the Node primitive. This helper
 * keeps the SDK independent of any particular host so the generated contract
 * artifacts can be deserialised in both environments.
 */
export function decodeBase64(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(input, "base64"));
  }
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
