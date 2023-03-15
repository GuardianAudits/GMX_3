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

describe("Guardian.PPU-1", () => {
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

  it("CRITICAL: Incorrect Price Impact For Users", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // Increase $100,000 Short Order by User0
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5000, 6),
        sizeDeltaUsd: decimalToFloat(100_000),
        acceptablePrice: expandDecimals(4900, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
    const beforeImpactPoolAmt = await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken));

    const shortOI = await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, usdc.address, false));
    expect(shortOI).to.eq(decimalToFloat(100000));
    const longOI = await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true));
    expect(longOI).to.eq(0);

    // Increase $100,000 Long Order by User1 should have +PI as they balanced the short OI
    // However, User1 will experience 0 +PI
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(100_000),
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
    const afterImpactPoolAmt = await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken));

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    const positionKeys = await getPositionKeys(dataStore, 0, 2);
    const longPosition = await reader.getPositionInfo(dataStore.address, positionKeys[1], prices);
    // 0 PI was experienced so User1 gets size of 20 WNT tokens ($100,000 / $5,000)
    const sizeInTokens = longPosition.position.numbers.sizeInTokens;
    expect(sizeInTokens).to.be.eq(expandDecimals(20, 18));

    const impactPoolDiff = beforeImpactPoolAmt.sub(afterImpactPoolAmt);
    expect(ethers.utils.formatEther(beforeImpactPoolAmt)).to.eq("0.02");
    expect(ethers.utils.formatEther(afterImpactPoolAmt)).to.eq("0.02");
    // The impact pool experiences 0 change
    // This is because nextLongOpenInterest and nextShortOpenInterest are left uninitalized.
    // As a result, the pool goes from 0-100,000 -> 100,000-0
    expect(impactPoolDiff).to.eq(0);
  });
});
