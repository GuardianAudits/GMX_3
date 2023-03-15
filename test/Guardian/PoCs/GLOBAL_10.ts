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

describe("Guardian.GLOBAL_10", () => {
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

  it("MEDIUM: Double Fee Leads to Position Liquidatable So Can't Decrease", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    await dataStore.setUint(keys.minCollateralFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%

    // User0 creates a position
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5, 6),
        sizeDeltaUsd: decimalToFloat(50), // 10x position
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

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    await expect(
      executeLiquidation(fixture, {
        account: user0.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%
    // 10% of order size is taken away
    // Fees should be 10% of the delta E.g. $25 * .10 = $2.5
    // Collateral = $5 - $2.5 = $2.5
    // Position Size = $50 - $25 = $25
    // Liquidation ratio should still be good at 10x
    // Execution does not go through due to LiquidatablePosition
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        sizeDeltaUsd: decimalToFloat(25), // Take 50% as we practice proper risk management over here
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
    const positionKeys = await getPositionKeys(dataStore, 0, 1);
    const position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    // Size is still 50 as Decrease did not go through due to the extra fee performed in isPositionLiquidatable
    expect(position.position.numbers.sizeInUsd).to.eq(decimalToFloat(50));
  });
});
