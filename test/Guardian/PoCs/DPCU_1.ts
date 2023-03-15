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

describe("Guardian.DPCU-1", () => {
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

  it("CRITICAL: Wrong tokens are subtracted in getLiquidationValues", async () => {
    // Turn on borrowing fees
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));

    const initialUSDCBalance = expandDecimals(5_000, 6); // 5,000 USDC
    expect(await getOrderCount(dataStore)).eq(0);

    const params = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(450 * 1000), // 90x leverage // Position size is 90 ETH
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
      gasUsageLabel: "createOrder",
    };

    await handleOrder(fixture, {
      create: params,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    const minMaxPrices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(10000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(10000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    const positionKeys = await getPositionKeys(dataStore, 0, 10);

    let position = await reader.getPositionInfo(dataStore.address, positionKeys[0], minMaxPrices);
    expect(position.pendingBorrowingFees).eq("0");

    await time.increase(10 * 24 * 60 * 60); // 10 days goes by
    await mine();

    position = await reader.getPositionInfo(dataStore.address, positionKeys[0], minMaxPrices);
    expect(position.pendingBorrowingFees).eq("6998408100000000000000000000000000"); // ~ $7,000 in borrowing fees

    const userWNTBalBefore = await wnt.balanceOf(user1.address);
    const userNativeBalBefore = await ethers.provider.getBalance(user1.address);
    const userUSDCBalBefore = await usdc.balanceOf(user1.address);
    const poolWNTBalBefore = await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address);
    const poolUSDCBalBefore = await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address);

    await executeLiquidation(fixture, {
      account: user1.address,
      market: ethUsdMarket,
      collateralToken: usdc,
      isLong: true,
      tokens: [wnt.address, usdc.address],
      precisions: [8, 18],
      minPrices: [expandDecimals(5001, 4), expandDecimals(2, 5)], // ETH goes to $5001 & USDC goes to $0.20
      maxPrices: [expandDecimals(5001, 4), expandDecimals(2, 5)],
      gasUsageLabel: "liquidationHandler.executeLiquidation",
    });

    // The user loses their 5,000 USDC collateral but it is instead accounted for as WNT
    const poolWNTBalAfter = await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address);
    const poolUSDCBalAfter = await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address);

    expect(poolWNTBalAfter.sub(poolWNTBalBefore)).to.eq(initialUSDCBalance);
    expect(poolUSDCBalBefore.sub(poolUSDCBalAfter)).to.eq(0);

    const userWNTBalAfter = await wnt.balanceOf(user1.address);
    const userNativeBalAfter = await ethers.provider.getBalance(user1.address);
    const userUSDCBalAfter = await usdc.balanceOf(user1.address);

    // User didn't receive anything
    expect(userWNTBalAfter.sub(userWNTBalBefore)).to.eq(0);
    expect(userNativeBalAfter.sub(userNativeBalBefore)).to.eq(0);
    expect(userUSDCBalAfter.sub(userUSDCBalBefore)).to.eq(0);
  });
});
