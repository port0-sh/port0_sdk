/**
 * Pool state reads.
 *
 * `decodePoolState` decodes the eleven storage slots plus the vault into a
 * typed `PoolState`. Reserves are the contract's stored accounting; the vault
 * is asserted to cover the reserves plus the protocol pot. A credit the
 * contract did not create is never a reserve.
 */
import {
  Account,
  AccountId,
  Felt,
  StorageView,
} from "@miden-sdk/miden-sdk";
import { POOL_SLOTS } from "../constants.js";
import { XykError } from "../errors.js";
import { fungibleAssetIdWord, type Word4 } from "../math/encoding.js";
import { word4FromWord } from "../notes/word.js";
import {
  assetKeyToFaucetIdFelts,
  decodeAccountIdWord,
  decodeFeesWord,
  decodeProtocolPotWord,
  decodeReservesWord,
  decodeScalarWord,
  decodeU128Word,
  isZeroWord4,
} from "./decoding.js";

const ZERO: Word4 = [0n, 0n, 0n, 0n];

export interface PoolFees {
  lpFeeBps: bigint;
  protocolFeeShareBps: bigint;
}

export interface PoolState {
  accountId: AccountId;
  token0Key: Word4;
  token1Key: Word4;
  token0FaucetId: AccountId;
  token1FaucetId: AccountId;
  lpSupply: bigint;
  fees: PoolFees;
  /** Registry the pool reads its protocol fee destination from. */
  registryId: AccountId;
  p2idRoot: Word4;
  protocolPot: { amount0: bigint; amount1: bigint };
  price0CumulativeLast: bigint;
  price1CumulativeLast: bigint;
  blockTimestampLast: bigint;
  reserve0: bigint;
  reserve1: bigint;
  /**
   * Asset key of every fungible asset the vault holds, token0 and token1
   * first when present. The contract cannot enumerate its own vault, so a
   * collect names the keys it sweeps; this is that list.
   */
  vaultAssetKeys: Word4[];
}

function readWord(storage: StorageView, name: string): Word4 | undefined {
  // 0.17: Account.storage() returns StorageView; getItem() returns a
  // StorageResult whose `.word` is the underlying Word (undefined if absent).
  const word = storage.getItem(name)?.word;
  return word ? word4FromWord(word) : undefined;
}

function accountIdFromFelts([prefix, suffix]: [bigint, bigint]): AccountId {
  return AccountId.fromPrefixSuffix(new Felt(prefix), new Felt(suffix));
}

/** Decodes a fetched public pool account into typed state. */
export function decodePoolState(account: Account): PoolState {
  // 0.17: Account.storage() is patched to return StorageView at runtime, but
  // the WASM class still declares the raw AccountStorage return type.
  const storage = account.storage() as unknown as StorageView;

  const token0Key = readWord(storage, POOL_SLOTS.token0AssetKey);
  const token1Key = readWord(storage, POOL_SLOTS.token1AssetKey);
  if (
    !token0Key ||
    isZeroWord4(token0Key) ||
    !token1Key ||
    isZeroWord4(token1Key)
  ) {
    throw new XykError(
      "NOT_A_POOL",
      `account ${account.id().toString()} has no token asset keys; not an XYK pool`,
    );
  }

  const lpSupply = decodeScalarWord(readWord(storage, POOL_SLOTS.lpSupply) ?? ZERO);
  const feesWord = readWord(storage, POOL_SLOTS.fees) ?? ZERO;
  const fees = decodeFeesWord(feesWord);
  const registryId = decodeAccountIdWord(
    readWord(storage, POOL_SLOTS.registryId) ?? ZERO,
  );
  const p2idRoot = readWord(storage, POOL_SLOTS.p2idRoot) ?? ZERO;
  const pot = decodeProtocolPotWord(
    readWord(storage, POOL_SLOTS.protocolPot) ?? ZERO,
  );
  const reservesWord = readWord(storage, POOL_SLOTS.reserves);
  if (!reservesWord) {
    // Without the slot, the reserves cannot be recovered from the vault
    // without misreading a stray credit. Report it instead of guessing.
    throw new XykError(
      "MISSING_SLOT",
      `account ${account.id().toString()} has no reserves slot; it is not a port0 pool`,
    );
  }
  const reserves = decodeReservesWord(reservesWord);
  const price0 = decodeU128Word(
    readWord(storage, POOL_SLOTS.price0CumulativeLast) ?? ZERO,
  );
  const price1 = decodeU128Word(
    readWord(storage, POOL_SLOTS.price1CumulativeLast) ?? ZERO,
  );
  const blockTimestampLast = decodeScalarWord(
    readWord(storage, POOL_SLOTS.blockTimestampLast) ?? ZERO,
  );

  const token0FaucetId = accountIdFromFelts(assetKeyToFaucetIdFelts(token0Key));
  const token1FaucetId = accountIdFromFelts(assetKeyToFaucetIdFelts(token1Key));

  const vault = account.vault();
  const vaultAssetKeys = vault
    .fungibleAssets()
    .map((asset) => fungibleAssetIdWord(asset.faucetId()));
  const vault0 = vault.getBalance(token0FaucetId);
  const vault1 = vault.getBalance(token1FaucetId);
  if (
    vault0 < reserves.reserve0 + pot.amount0 ||
    vault1 < reserves.reserve1 + pot.amount1
  ) {
    throw new XykError(
      "INVARIANT",
      "pool vault does not cover the recorded reserves and protocol pot",
    );
  }

  return {
    accountId: account.id(),
    token0Key,
    token1Key,
    token0FaucetId,
    token1FaucetId,
    lpSupply,
    fees: {
      lpFeeBps: fees.lpFeeBps,
      protocolFeeShareBps: fees.protocolFeeShareBps,
    },
    registryId: accountIdFromFelts(registryId),
    p2idRoot,
    protocolPot: pot,
    price0CumulativeLast: price0,
    price1CumulativeLast: price1,
    blockTimestampLast,
    reserve0: reserves.reserve0,
    reserve1: reserves.reserve1,
    vaultAssetKeys,
  };
}

/** Fetches a pool account and decodes it. */
export async function fetchPoolState(
  getAccount: (id: AccountId) => Promise<Account | null>,
  poolId: AccountId,
): Promise<PoolState> {
  const account = await getAccount(poolId);
  if (!account) {
    throw new XykError(
      "POOL_NOT_FOUND",
      `pool account ${poolId.toString()} not found`,
    );
  }
  return decodePoolState(account);
}
