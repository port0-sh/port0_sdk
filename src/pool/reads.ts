/**
 * Pool state reads.
 *
 * `decodePoolState` decodes the eleven storage slots plus the vault into a
 * typed `PoolState`. Reserves are the vault balances of token0 and token1
 * minus the protocol pot, matching the contract's `get_reserves`.
 */
import {
  Account,
  AccountId,
  Felt,
  StorageView,
} from "@miden-sdk/miden-sdk";
import { POOL_SLOTS } from "../constants.js";
import { XykError } from "../errors.js";
import type { Word4 } from "../math/encoding.js";
import { word4FromWord } from "../notes/word.js";
import {
  assetKeyToFaucetIdFelts,
  decodeAdminWord,
  decodeFeesWord,
  decodeProtocolPotWord,
  decodeScalarWord,
  decodeU128Word,
  isZeroWord4,
} from "./decoding.js";

const ZERO: Word4 = [0n, 0n, 0n, 0n];

export interface PoolFees {
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  feeTo: AccountId;
}

export interface PoolState {
  accountId: AccountId;
  /** True once `configure` has set the LP token key. */
  configured: boolean;
  token0Key: Word4;
  token1Key: Word4;
  lpKey: Word4;
  token0FaucetId: AccountId;
  token1FaucetId: AccountId;
  lpSupply: bigint;
  fees: PoolFees;
  admin: AccountId;
  p2idRoot: Word4;
  protocolPot: { amount0: bigint; amount1: bigint };
  price0CumulativeLast: bigint;
  price1CumulativeLast: bigint;
  blockTimestampLast: bigint;
  reserve0: bigint;
  reserve1: bigint;
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

  const lpKey = readWord(storage, POOL_SLOTS.tokenlpAssetKey) ?? ZERO;
  const lpSupply = decodeScalarWord(readWord(storage, POOL_SLOTS.lpSupply) ?? ZERO);
  const fees = decodeFeesWord(readWord(storage, POOL_SLOTS.fees) ?? ZERO);
  const admin = decodeAdminWord(readWord(storage, POOL_SLOTS.admin) ?? ZERO);
  const p2idRoot = readWord(storage, POOL_SLOTS.p2idRoot) ?? ZERO;
  const pot = decodeProtocolPotWord(
    readWord(storage, POOL_SLOTS.protocolPot) ?? ZERO,
  );
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
  const vault0 = vault.getBalance(token0FaucetId);
  const vault1 = vault.getBalance(token1FaucetId);
  if (vault0 < pot.amount0 || vault1 < pot.amount1) {
    throw new XykError(
      "INVARIANT",
      "pool vault balance is below the recorded protocol pot",
    );
  }

  return {
    accountId: account.id(),
    configured: !isZeroWord4(lpKey),
    token0Key,
    token1Key,
    lpKey,
    token0FaucetId,
    token1FaucetId,
    lpSupply,
    fees: {
      lpFeeBps: fees.lpFeeBps,
      protocolFeeBps: fees.protocolFeeBps,
      feeTo: accountIdFromFelts(fees.feeTo),
    },
    admin: accountIdFromFelts(admin),
    p2idRoot,
    protocolPot: pot,
    price0CumulativeLast: price0,
    price1CumulativeLast: price1,
    blockTimestampLast,
    reserve0: vault0 - pot.amount0,
    reserve1: vault1 - pot.amount1,
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
