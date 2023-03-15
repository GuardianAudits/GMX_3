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

describe("Guardian.POSU-1-old", () => {
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

  it("MEDIUM: Cannot liquidate a short with nearly 0 collateral in profit", async () => {
    const initialWNTBalance = expandDecimals(1, 18); // 1 WNT e.g. $5,000
    expect(await getOrderCount(dataStore)).eq(0);

    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(100000, 18),
        shortTokenAmount: expandDecimals(50_000_000, 6),
      },
      execute: {
        tokens: [wnt.address, usdc.address, solAddr],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 18, 8],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    const params = {
      account: user1,
      market: solUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(450 * 1000), // 90x leverage -- position size is 30000 SOL @ $15/SOL
      acceptablePrice: expandDecimals(14, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
      gasUsageLabel: "createOrder",
    };

    await handleOrder(fixture, {
      create: params,
      execute: {
        tokens: [wnt.address, usdc.address, solAddr],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 18, 8],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);
    await mine();

    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: solUsdMarket,
        collateralToken: wnt,
        isLong: false,
        tokens: [wnt.address, usdc.address, solAddr],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 18, 8],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(10, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(10, 4)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    // Notice that even though the collateral token value has halved, the position is in enough profit to keep it alive
    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: solUsdMarket,
        collateralToken: wnt,
        isLong: false,
        tokens: [wnt.address, usdc.address, solAddr],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 18, 8],
        minPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(10, 4)],
        maxPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(10, 4)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    // Position size 450k
    // 100x is 4.5k Collateral
    // But position is 150k in profit so even near 0 collateral it cannot be liquidated

    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: solUsdMarket,
        collateralToken: wnt,
        isLong: false,
        tokens: [wnt.address, usdc.address, solAddr],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 18, 8],
        minPrices: [expandDecimals(1, 4), expandDecimals(1, 6), expandDecimals(10, 4)], // ETH goes to $1
        maxPrices: [expandDecimals(1, 4), expandDecimals(1, 6), expandDecimals(10, 4)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);
  });
});
