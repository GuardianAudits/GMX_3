import { expect } from "chai";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getBalanceOf, getSyntheticTokenAddress, getSupplyOf } from "../../../utils/token";
import { getDepositCount, getDepositKeys, createDeposit, executeDeposit, handleDeposit } from "../../../utils/deposit";
import * as keys from "../../../utils/keys";
import { getAccountPositionCount, getPositionCount, getPositionKeys } from "../../../utils/position";
import {
  OrderType,
  getOrderCount,
  handleOrder,
  createOrder,
  executeOrder,
  getOrderKeys,
  DecreasePositionSwapType,
} from "../../../utils/order";
import { expectTokenBalanceIncrease } from "../../../utils/token";
import { grantRole } from "../../../utils/role";
import { executeLiquidation } from "../../../utils/liquidation";
import { ethers } from "hardhat";
import { TOKEN_ORACLE_TYPES } from "../../../utils/oracle";
import { BigNumber } from "ethers";
import { getIsAdlEnabled, updateAdlState, executeAdl } from "../../../utils/adl";
import { getPoolAmount, getMarketTokenPrice } from "../../../utils/market";
import { claimableCollateralAmountKey } from "../../../utils/keys";
import { createWithdrawal, executeWithdrawal, handleWithdrawal } from "../../../utils/withdrawal";
import { hashData, hashString, encodeData } from "../../../utils/hash";

describe("Guardian.ORDH-3", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2, wallet;
  let reader,
    dataStore,
    oracle,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    usdc,
    exchangeRouter,
    orderHandler,
    referralStorage,
    orderVault,
    positionUtils,
    solAddr,
    positionStoreUtils,
    tokenUtils,
    wntAccurate,
    ethUsdAccurateMarket,
    marketUtils,
    solUsdMarket,
    config;
  let roleStore, decreasePositionUtils, executionFee, prices;
  let eventEmitter, adlUtils;

  beforeEach(async () => {
    fixture = await deployFixture();

    ({ wallet, user0, user1, user2 } = fixture.accounts);
    ({ executionFee, prices } = fixture.props);
    ({
      reader,
      dataStore,
      orderHandler,
      oracle,
      depositVault,
      ethUsdMarket,
      orderVault,
      ethUsdSpotOnlyMarket,
      tokenUtils,
      wnt,
      marketUtils,
      referralStorage,
      positionUtils,
      usdc,
      exchangeRouter,
      positionStoreUtils,
      roleStore,
      decreasePositionUtils,
      eventEmitter,
      wntAccurate,
      ethUsdAccurateMarket,
      solUsdMarket,
      config,
      adlUtils,
    } = fixture.contracts);

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");
    solAddr = getSyntheticTokenAddress("SOL");

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(500 * 1000, 6),
      },
    });
  });

  it("MEDIUM: Short-term risk free trade due to order update or cancellation", async () => {
    const initialCollateralDelta = expandDecimals(10, 18);
    // Create Limit Order For $1,000,000
    await createOrder(fixture, {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialCollateralDelta,
      sizeDeltaUsd: decimalToFloat(1_000_000), // 20x leverage
      acceptablePrice: expandDecimals(5100, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
    });
    expect(await getOrderCount(dataStore)).to.eq(1);

    await mine(5);

    // At this point the limit order has not been executed yet
    // Trader can check current prices and see if price moved favorably
    // If so, create a MarketDecrease and realize a risk-free profit.
    // Otherwise, update or cancel the order.

    // If prices have gone down to $4,900, cancel the order.
    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    await exchangeRouter.connect(user0).cancelOrder(orderKeys[0]);

    expect(await getOrderCount(dataStore)).to.eq(0);

    // Create Limit Order For $1,000,000
    await createOrder(fixture, {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialCollateralDelta,
      sizeDeltaUsd: decimalToFloat(1_000_000), // 20x leverage
      acceptablePrice: expandDecimals(5050, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
    });
    expect(await getOrderCount(dataStore)).to.eq(1);

    await mine(5);

    // If price of ETH has gone up to $5,100, create MarketDecrease and secure this price
    await createOrder(fixture, {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      sizeDeltaUsd: decimalToFloat(1_000_000),
      orderType: OrderType.MarketDecrease,
      isLong: true,
    });
    expect(await getOrderCount(dataStore)).to.eq(2);

    // Execute LimitIncrease
    await executeOrder(fixture, {
      tokens: [wnt.address, usdc.address, wnt.address, usdc.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(5000, 4), expandDecimals(1, 6)],
      precisions: [8, 18, 8, 18],
    });
    // Execute MarketDecrease with increased prices
    await executeOrder(fixture, {
      minPrices: [expandDecimals(5100, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5100, 4), expandDecimals(1, 6)],
    });

    expect(await getOrderCount(dataStore)).to.eq(0);

    const wntBalanceAfter = await getBalanceOf(wnt.address, user0.address);
    // Profit $100 per token for 200 tokens
    // $20,000 / 5100 = 3.92156862745 ETH
    const profit = "3921568627450980392";
    const expectedBalance = initialCollateralDelta.mul(2).add(profit);
    // Get back initial collateral from both orders + profit
    expect(wntBalanceAfter).to.eq(expectedBalance);
  });
});
