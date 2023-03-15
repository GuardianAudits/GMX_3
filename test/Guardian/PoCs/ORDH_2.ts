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

describe("Guardian.ORDH-2", () => {
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

  it("MEDIUM: Simulation doesn't work for frozen orders", async () => {
    const initialWNTAmount = expandDecimals(20, 18);

    // User1 makes a position of size 20 WNT
    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTAmount,
      sizeDeltaUsd: decimalToFloat(500 * 1000 * 1000), // Position size too large, order gets frozen
      acceptablePrice: expandDecimals(5000, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, increaseParams);
    const orderKey = (await getOrderKeys(dataStore, 0, 1))[0];
    let order = await reader.getOrder(dataStore.address, orderKey);

    expect(order.flags.isFrozen).to.be.false;

    await executeOrder(fixture, {
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
      precisions: [8, 8],
    });

    order = await reader.getOrder(dataStore.address, orderKey);

    expect(order.flags.isFrozen).to.be.true;

    const simulatedPrimaryPrices = [
      {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    ];

    const simulatedSecondaryPrices = [
      {
        min: expandDecimals(4990, 12),
        max: expandDecimals(4990, 12),
      },
      {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    ];

    await expect(
      exchangeRouter.connect(user1).simulateExecuteOrder(orderKey, {
        primaryTokens: [wnt.address, usdc.address],
        primaryPrices: simulatedPrimaryPrices,
        secondaryTokens: [wnt.address, usdc.address],
        secondaryPrices: simulatedSecondaryPrices,
      })
    ).to.be.revertedWithCustomError(orderHandler, "InvalidKeeperForFrozenOrder");
  });
});
