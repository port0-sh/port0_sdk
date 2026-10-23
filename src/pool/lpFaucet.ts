/**
 * LP token metadata for the pool's own faucet.
 *
 * The pool account is its own LP faucet: the contract derives the LP asset id
 * from the pool's account id, and the kernel lets an account mint assets whose
 * faucet id is its own. Without the standard fungible-faucet component the
 * account carries no name, symbol, or decimals, and a wallet shows the LP token
 * as "Unknown", because the account interface exposes no faucet procedures to
 * read them from.
 *
 * This module compiles that standard component from its vendored MASM and gives
 * it the standards' storage layout, so the pool account reports as a fungible
 * faucet with metadata every wallet can read. The metadata is fixed when the
 * pool account is built; changing it means a new pool.
 *
 * Decimals are 0, matching how the app displays LP amounts (raw units), and the
 * max supply is the protocol's own maximum fungible amount: the pool mints
 * through the kernel, which bounds the amount but does not consult the faucet
 * config, so the value is the representable maximum rather than a policy cap.
 */
import {
  AccountComponent,
  StorageSlot,
  type MidenClient,
} from "@miden-sdk/miden-sdk";
import type { Word4 } from "../math/encoding.js";
import { wordFromWord4 } from "../notes/word.js";
import type { PoolInitSlotDefinition } from "./slots.js";

/** LP token decimals: raw units, as the app displays LP amounts. */
export const LP_FAUCET_DECIMALS = 0;

/**
 * `AssetAmount::MAX` from `miden-protocol` 0.17.1: `2^63 - 2^31`. No fungible
 * amount may exceed it, so no pool can mint past it.
 */
export const LP_FAUCET_MAX_SUPPLY = 2n ** 63n - 2n ** 31n;

/** Longest `TokenSymbol` the protocol accepts. */
const MAX_SYMBOL_LENGTH = 12;
/** Letters taken from each side, so two long symbols still fit the limit. */
const SYMBOL_SLICE = 5;
/** `TokenSymbol` alphabet, in the order the felt encoding uses. */
const SYMBOL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Bytes per felt in the standards' string encoding. */
const BYTES_PER_FELT = 7;
/** Storage slot name prefix shared by both components. */
const SLOT_PREFIX = "miden::standards::faucets";
/** Component namespace: procedure identity depends on this exact path. */
const LP_FAUCET_NAMESPACE =
  "miden::standards::components::faucets::fungible_faucet";

/**
 * The standard fungible-faucet account component, from
 * `miden-standards` 0.17.1 `asm/components/faucets/fungible_faucet/fungible_faucet.masm`.
 *
 * Compiling this exact source under the namespace above yields the same
 * procedure roots as the standards' own compiled artifact, which is what makes
 * a wallet recognize the pool account as a fungible faucet.
 */
const LP_FAUCET_MASM = `# Fungible token minting and burning
pub use {mint_and_send} from miden::standards::faucets::fungible
pub use {receive_and_burn} from miden::standards::faucets::fungible

# Fungible token configuration
pub use {get_decimals} from miden::standards::faucets::fungible
pub use {get_token_symbol} from miden::standards::faucets::fungible
pub use {get_token_supply} from miden::standards::faucets::fungible
pub use {get_max_supply} from miden::standards::faucets::fungible
pub use {set_max_supply} from miden::standards::faucets::fungible
pub use {is_max_supply_mutable} from miden::standards::faucets::fungible
pub use {get_token_config} from miden::standards::faucets::fungible

# Code inspection
pub use {has_procedure} from miden::standards::inspection::code_inspection

# Token metadata: mandatory name + optional description, logo, external link.
pub use {get_name} from miden::standards::faucets
pub use {get_mutability_config} from miden::standards::faucets
pub use {is_description_mutable} from miden::standards::faucets
pub use {is_logo_uri_mutable} from miden::standards::faucets
pub use {is_external_link_mutable} from miden::standards::faucets
pub use {set_description} from miden::standards::faucets
pub use {set_logo_uri} from miden::standards::faucets
pub use {set_external_link} from miden::standards::faucets`;

/** Letters a token symbol contributes to the LP symbol. */
function symbolSlice(symbol: string): string {
  return [...symbol.toUpperCase()]
    .filter((character) => SYMBOL_ALPHABET.includes(character))
    .slice(0, SYMBOL_SLICE)
    .join("");
}

/**
 * The LP token symbol for a pool: `PO` plus up to five letters of each side.
 * `TokenSymbol` allows uppercase ASCII letters only, 1 to 12 characters, so a
 * digit prefix such as `P0` is rejected by the protocol itself.
 *
 * Throws when a side contributes no letters: the derived symbol would not name
 * the pool.
 */
export function lpTokenSymbol(
  token0Symbol: string,
  token1Symbol: string,
): string {
  const symbol = `PO${symbolSlice(token0Symbol)}${symbolSlice(token1Symbol)}`;
  if (symbol.length > MAX_SYMBOL_LENGTH) {
    // Unreachable while SYMBOL_SLICE holds the invariant.
    throw new Error(`LP token symbol ${symbol} exceeds ${MAX_SYMBOL_LENGTH}`);
  }
  if (symbol.length === 2) {
    throw new Error(
      `Cannot derive an LP token symbol: neither ${token0Symbol} nor ${token1Symbol} has an A-Z letter.`,
    );
  }
  return symbol;
}

/** The LP token display name: `port0 LP <token0>/<token1>`, capped at 32 bytes. */
export function lpTokenName(
  token0Symbol: string,
  token1Symbol: string,
): string {
  const name = `port0 LP ${token0Symbol.trim()}/${token1Symbol.trim()}`;
  const bytes = new TextEncoder().encode(name);
  return bytes.length <= 32 ? name : name.slice(0, 32);
}

/** The standards' `ShortCapitalString` felt encoding: base 26, length-suffixed. */
export function symbolFelt(symbol: string): bigint {
  let encoded = 0n;
  for (const character of symbol) {
    const digit = SYMBOL_ALPHABET.indexOf(character);
    if (digit < 0) {
      throw new Error(`Token symbol ${symbol} contains a non A-Z character.`);
    }
    encoded = encoded * 26n + BigInt(digit);
  }
  return encoded * 26n + BigInt(symbol.length);
}

/**
 * The standards' `FixedWidthString` encoding: 7 bytes per felt, length-prefixed
 * and zero-padded, one word per four felts.
 */
export function encodeStringWords(value: string, wordCount: number): Word4[] {
  const bytes = new TextEncoder().encode(value);
  const feltCount = wordCount * 4;
  const buffer = new Uint8Array(feltCount * BYTES_PER_FELT);
  if (bytes.length + 1 > buffer.length) {
    throw new Error(
      `String of ${bytes.length} bytes does not fit ${wordCount} words.`,
    );
  }
  buffer[0] = bytes.length;
  buffer.set(bytes, 1);
  const words: Word4[] = [];
  for (let word = 0; word < wordCount; word += 1) {
    const felts: bigint[] = [];
    for (let felt = 0; felt < 4; felt += 1) {
      const start = (word * 4 + felt) * BYTES_PER_FELT;
      let value = 0n;
      for (let index = BYTES_PER_FELT - 1; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(buffer[start + index] ?? 0);
      }
      felts.push(value);
    }
    words.push(felts as unknown as Word4);
  }
  return words;
}

/**
 * Every storage slot the standard faucet component writes, in the standards'
 * layout: the token config word `[token_supply, max_supply, decimals, symbol]`,
 * the name in two words, the mutability config, and the (empty) description,
 * logo URI, and external link fields, seven words each.
 *
 * The standard writes the optional fields as empty strings rather than omitting
 * their slots, so this does too.
 */
export function lpFaucetSlots(
  symbol: string,
  name: string,
): PoolInitSlotDefinition[] {
  const empty: Word4 = [0n, 0n, 0n, 0n];
  const [nameWord0 = empty, nameWord1 = empty] = encodeStringWords(name, 2);
  const slots: PoolInitSlotDefinition[] = [
    {
      name: `${SLOT_PREFIX}::fungible::token_config`,
      value: [
        0n,
        LP_FAUCET_MAX_SUPPLY,
        BigInt(LP_FAUCET_DECIMALS),
        symbolFelt(symbol),
      ],
    },
    { name: `${SLOT_PREFIX}::token_name_0`, value: nameWord0 },
    { name: `${SLOT_PREFIX}::token_name_1`, value: nameWord1 },
    // Nothing mutable: an immutable max supply cannot be inflated later.
    { name: `${SLOT_PREFIX}::mutability_config`, value: empty },
  ];
  for (const field of ["token_description", "logo_uri", "external_link"]) {
    for (let index = 0; index < 7; index += 1) {
      slots.push({ name: `${SLOT_PREFIX}::${field}_${index}`, value: empty });
    }
  }
  return slots;
}

/** Builds the faucet slots as web-sdk storage slots. */
function toStorageSlots(slots: PoolInitSlotDefinition[]): StorageSlot[] {
  return slots.map((slot) =>
    StorageSlot.fromValue(slot.name, wordFromWord4(slot.value as Word4)),
  );
}

/**
 * Compiles the standard fungible-faucet component for the LP token of a pool
 * whose tokens carry `token0Symbol` and `token1Symbol`.
 */
export function lpFaucetComponent(
  client: MidenClient,
  params: { token0Symbol: string; token1Symbol: string },
): Promise<AccountComponent> {
  const symbol = lpTokenSymbol(params.token0Symbol, params.token1Symbol);
  const name = lpTokenName(params.token0Symbol, params.token1Symbol);
  return client.compile.component({
    code: LP_FAUCET_MASM,
    namespace: LP_FAUCET_NAMESPACE,
    slots: toStorageSlots(lpFaucetSlots(symbol, name)),
  });
}
