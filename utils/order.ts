import { logGasUsage } from "./gas";
import { bigNumberify, expandDecimals } from "./math";
import { executeWithOracleParams } from "./exchange";
import { TOKEN_ORACLE_TYPES } from "./oracle";
import { mine } from "@nomicfoundation/hardhat-network-helpers";

import * as keys from "./keys";

export const OrderType = {
  MarketSwap: 0,
  LimitSwap: 1,
  MarketIncrease: 2,
  LimitIncrease: 3,
  MarketDecrease: 4,
  LimitDecrease: 5,
  StopLossDecrease: 6,
  Liquidation: 7,
};

export const DecreasePositionSwapType = {
  NoSwap: 0,
  SwapPnlTokenToCollateralToken: 1,
  SwapCollateralTokenToPnlToken: 2,
};

export function getOrderCount(dataStore) {
  return dataStore.getBytes32Count(keys.ORDER_LIST);
}

export function getOrderKeys(dataStore, start, end) {
  return dataStore.getBytes32ValuesAt(keys.ORDER_LIST, start, end);
}

export function getAccountOrderCount(dataStore, account) {
  return dataStore.getBytes32Count(keys.accountOrderListKey(account));
}

export function getAccountOrderKeys(dataStore, account, start, end) {
  return dataStore.getBytes32ValuesAt(keys.accountOrderListKey(account), start, end);
}

export async function createOrder(fixture, overrides) {
  const { initialCollateralToken, orderType, gasUsageLabel } = overrides;

  const { orderVault, orderHandler, wnt } = fixture.contracts;
  const { wallet, user0 } = fixture.accounts;

  const decreasePositionSwapType = overrides.decreasePositionSwapType || DecreasePositionSwapType.NoSwap;
  const account = overrides.account || user0;
  const receiver = overrides.receiver || account;
  const callbackContract = overrides.callbackContract || { address: ethers.constants.AddressZero };
  const market = overrides.market || { marketToken: ethers.constants.AddressZero };
  const sizeDeltaUsd = overrides.sizeDeltaUsd || "0";
  const initialCollateralDeltaAmount = overrides.initialCollateralDeltaAmount || "0";
  const swapPath = overrides.swapPath || [];
  const acceptablePrice = overrides.acceptablePrice || "0";
  const triggerPrice = overrides.triggerPrice || "0";
  const isLong = overrides.isLong || false;
  const executionFee = overrides.executionFee || fixture.props.executionFee;
  const callbackGasLimit = overrides.callbackGasLimit || bigNumberify(0);
  const minOutputAmount = overrides.minOutputAmount || 0;
  const shouldUnwrapNativeToken = overrides.shouldUnwrapNativeToken || false;
  const gasLimit = overrides.gasLimit;

  if (
    orderType === OrderType.MarketSwap ||
    orderType === OrderType.LimitSwap ||
    orderType === OrderType.MarketIncrease ||
    orderType === OrderType.LimitIncrease
  ) {
    await initialCollateralToken.mint(orderVault.address, initialCollateralDeltaAmount, { gasLimit });
  }

  await wnt.mint(orderVault.address, executionFee, { gasLimit });

  const params = {
    addresses: {
      receiver: receiver.address,
      callbackContract: callbackContract.address,
      market: market.marketToken,
      initialCollateralToken: initialCollateralToken.address,
      swapPath,
    },
    numbers: {
      sizeDeltaUsd,
      initialCollateralDeltaAmount,
      acceptablePrice,
      triggerPrice,
      executionFee,
      callbackGasLimit,
      minOutputAmount,
    },
    orderType,
    decreasePositionSwapType,
    isLong,
    shouldUnwrapNativeToken,
  };

  await logGasUsage({
    tx: orderHandler.connect(wallet).createOrder(account.address, params, { gasLimit }),
    label: gasUsageLabel,
  });
}

function isLimitOrder(order) {
  return order.numbers.orderType == OrderType.LimitDecrease || order.numbers.orderType == OrderType.LimitIncrease
      || order.numbers.orderType == OrderType.StopLossDecrease || order.numbers.orderType == OrderType.LimitSwap;
}

export async function executeOrder(fixture, overrides = {}) {
  const { wnt, usdc } = fixture.contracts;
  const { gasUsageLabel } = overrides;
  const { reader, dataStore, orderHandler } = fixture.contracts;
  const tokens = overrides.tokens || [wnt.address, usdc.address];
  const tokenOracleTypes = overrides.tokenOracleTypes || Array(tokens.length).fill(TOKEN_ORACLE_TYPES.DEFAULT);
  const precisions = overrides.precisions || [8, 18];
  const minPrices = overrides.minPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const maxPrices = overrides.maxPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const orderKeys = await getOrderKeys(dataStore, 0, 1);
  const key = overrides.key || orderKeys[0];
  const orderKeyIndex = overrides.orderKeyIndex;
  let order = await reader.getOrder(dataStore.address, key);
  if (orderKeyIndex) order = await reader.getOrder(dataStore.address, key);
  const priceFeedTokens = overrides.priceFeedTokens || [];
  let oracleBlockNumber = order.numbers.updatedAtBlock;
  if (isLimitOrder(order)) {
    oracleBlockNumber = oracleBlockNumber.add(1);
    await mine();
  }
  if (overrides.oracleBlockNumber) oracleBlockNumber = overrides.oracleBlockNumber;
  const gasLimit = overrides.gasLimit;

  const minOracleBlockNumbers = overrides.minOracleBlockNumbers;
  const maxOracleBlockNumbers = overrides.maxOracleBlockNumbers;

  const params = {
    key,
    oracleBlockNumber,
    key: orderKeyIndex != undefined ? orderKeys[orderKeyIndex] : key,
    tokens,
    tokenOracleTypes,
    precisions,
    minPrices,
    maxPrices,
    execute: orderHandler.executeOrder,
    gasUsageLabel,
    priceFeedTokens,
    minOracleBlockNumbers,
    maxOracleBlockNumbers,
    gasLimit,
  };

  await executeWithOracleParams(fixture, params);
}

export async function handleOrder(fixture, overrides = {}) {
  await createOrder(fixture, overrides.create);
  await executeOrder(fixture, overrides.execute);
}
