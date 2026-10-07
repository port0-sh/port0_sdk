import { Word } from "@miden-sdk/miden-sdk";
import type { Word4 } from "../math/encoding.js";

/** Converts a web-sdk `Word` into the SDK's four-limb bigint tuple. */
export function word4FromWord(word: Word): Word4 {
  return Array.from(word.toU64s()) as unknown as Word4;
}

/** Converts the SDK's four-limb bigint tuple into a web-sdk `Word`. */
export function wordFromWord4(word: Word4): Word {
  return new Word(new BigUint64Array([word[0], word[1], word[2], word[3]]));
}
