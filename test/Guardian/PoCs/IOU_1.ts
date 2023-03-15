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

describe("Guardian.IOU-1", () => {
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

  it("LOW: LimitIncreases with swapPaths can be griefed", async () => {
    // Innocent user has a limitIncrease in place to buy ether when it crosses the $4,000 threshold
    const initialWNTAmount = expandDecimals(10, 18);

    const increaseParamsUser2 = {
      account: user2,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTAmount,
      swapPath: [ethUsdSpotOnlyMarket.marketToken],
      sizeDeltaUsd: decimalToFloat(50 * 1000),
      acceptablePrice: expandDecimals(4000, 12),
      triggerPrice: expandDecimals(4000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(0);

    await createOrder(fixture, increaseParamsUser2);

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);

    await createOrder(fixture, {
      account: user1,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [ethUsdSpotOnlyMarket.marketToken],
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketSwap,
      shouldUnwrapNativeToken: false,
    });

    expect(await getOrderCount(dataStore)).to.eq(2);
    const [user2LimitIncreaseOrderKey, user1MarketSwapOrderKey] = await getOrderKeys(dataStore, 0, 2);

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).to.eq(
      expandDecimals(50_000, 6)
    );

    // A malicious user1 observes user2's trigger price approaching and kills the liquidity
    // on the usdc side of the ethUsdSpotOnlyMarket by swapping with eth to withdraw the usdc
    await executeOrder(fixture, {
      key: user1MarketSwapOrderKey,
      tokens: [wnt.address, usdc.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      precisions: [8, 18],
    });

    // Now there is no liquidity in the ethUsdSpotOnlyMarket for unsuspecting user2 to have their order executed.
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).to.eq(0);

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Now when user2's LimitIncrease is attempted to be executed, it gets frozen
    await executeOrder(fixture, {
      key: user2LimitIncreaseOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(4010, 4), expandDecimals(3990, 4)],
      maxPrices: [expandDecimals(4010, 4), expandDecimals(3990, 4)],
      precisions: [8, 8],
      priceFeedTokens: [usdc.address],
    });

    expect(await getPositionCount(dataStore)).to.eq(0);
    expect(await getOrderCount(dataStore)).to.eq(1);

    const user2LimitIncreaseOrder = await reader.getOrder(dataStore.address, user2LimitIncreaseOrderKey);

    expect(user2LimitIncreaseOrder.numbers.orderType).to.eq(OrderType.LimitIncrease);
    expect(user2LimitIncreaseOrder.flags.isFrozen).to.be.true;

    // Notice that this doesn't have to be as drastic as removing all liquidity but simply making the liquidity
    // just small enough to where the user's swapPath cannot be executed.
    // A malicious user could also simply remove enough liquidity so that the increase would invalidate validateReserve
  });
});
