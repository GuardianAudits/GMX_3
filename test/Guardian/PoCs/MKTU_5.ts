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
import { createWithdrawal, executeWithdrawal, handleWithdrawal, getWithdrawalCount } from "../../../utils/withdrawal";
import { hashData, hashString, encodeData } from "../../../utils/hash";

describe("Guardian.MKTU-5", () => {
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

  it("HIGH: Borrowing fee receiver amount counted in pool value", async () => {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));
    await dataStore.setUint(keys.BORROWING_FEE_RECEIVER_FACTOR, 2);

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100, 6),
        sizeDeltaUsd: decimalToFloat(1000), // 10x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(1);

    await time.increase(1000);

    // Pool value hasn't changed yet because of out-of-date cumulative borrowing factor used for fees calculation
    expect(await getMarketTokenPrice(fixture)).eq(expandDecimals(1, 30));

    let marketTokenPrice = expandDecimals(1, 30);
    const poolValueBefore = marketTokenPrice
      .mul(await getSupplyOf(ethUsdMarket.marketToken))
      .div(expandDecimals(1, 18));

    // Make another increase to update total borrowing fees
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100, 6),
        sizeDeltaUsd: decimalToFloat(1000), // 10x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    const position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    expect(position.pendingBorrowingFees).eq("20080000000000000000000000");

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).to.eq(1);

    marketTokenPrice = await getMarketTokenPrice(fixture);
    const poolValueAfter = marketTokenPrice.mul(await getSupplyOf(ethUsdMarket.marketToken)).div(expandDecimals(1, 18));
    expect(poolValueBefore).to.eq("5500000000000000000000000000000000000");
    // Added value matches Precision.applyFactor(cache.totalBorrowingFees, cache.borrowingFeeReceiverFactor) with slight rounding.
    // 20080000000000000000000000 * 2 (borrowing fee receiver factor) = 40160000000000000000000000
    // This showcases that it isn't the pending borrowing fees which are included in the pool value,
    // but the pending borrowing fee receiver fees which won't actually go to the pool.
    expect(poolValueAfter).to.eq("5500000000040159999999999999999000000");
  });
});
