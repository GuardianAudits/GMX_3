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
import { hashData, hashString } from "../../../utils/hash";

describe("Guardian.DPU-1", () => {
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
    solUsdMarket;
  let roleStore, decreasePositionUtils, executionFee, prices;
  let eventEmitter;

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

    await handleDeposit(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(100, 18), // $50k of ETH
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50k of USDC
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        precisions: [8, 18],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
  });

  it("HIGH: Borrowing Fees/Funding Fees are not accounted for in the isPositionLiquidatable check", async () => {
    // Turn funding fees on
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    const initialUSDCBalance = expandDecimals(150, 6);

    // User2 has a small short position open -- so that funding fees can accumulate
    const increaseShortParams = {
      account: user2,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(5_000), // $5,000 short position
      acceptablePrice: expandDecimals(4999, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseShortParams,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Now user1 opens a large long position
    const increaseLongParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(10_000), // Position 100% larger than the short side OI
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseLongParams,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);

    await time.increase(5 * 24 * 60 * 60); // 5 days pass
    await mine();

    let userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);
    const [shortPositionKey, longPositionKey] = await getPositionKeys(dataStore, 0, 2);

    const shortPosition = await reader.getPosition(dataStore.address, shortPositionKey);
    const longPosition = await reader.getPosition(dataStore.address, longPositionKey);

    expect(shortPosition.flags.isLong).to.be.false;
    expect(longPosition.flags.isLong).to.be.true;

    const positionInfo = await reader.getPositionInfo(dataStore.address, longPositionKey, fixture.props.prices);

    expect(positionInfo.pendingFundingFees.fundingFeeAmount).to.eq("144000000"); // $144.00 USDC

    // When funding fees are subtracted from collateral, the position will be left with ~$6 of collateral
    // and should therefore obviously be liquidated, otherwise it can easily become bad debt for the market.

    // However the liquidation cannot go through as these funding fees are not accounted for by the time
    // the isPositionLiquidatable check occurs.
    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        tokens: [wnt.address, usdc.address],
        precisions: [8, 18],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);

    // The position can only be liquidated once someone else updates the fundingFees
    const updateParams = {
      account: user2,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: 0,
      acceptablePrice: expandDecimals(4999, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: updateParams,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
      },
    });

    await executeLiquidation(fixture, {
      account: user1.address,
      market: ethUsdMarket,
      collateralToken: usdc,
      isLong: true,
      tokens: [wnt.address, usdc.address],
      precisions: [8, 18],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "liquidationHandler.executeLiquidation",
    });

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(0);
  });
});
