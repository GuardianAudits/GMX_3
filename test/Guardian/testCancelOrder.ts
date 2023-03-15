import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { getBalanceOf } from "../../utils/token";
import { getClaimableFeeAmount } from "../../utils/fee";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../utils/market";
import { getDepositCount, getDepositKeys, createDeposit, executeDeposit, handleDeposit } from "../../utils/deposit";
import { printGasUsage } from "../../utils/gas";

import * as keys from "../../utils/keys";
import { TOKEN_ORACLE_TYPES } from "../../utils/oracle";
import { data } from "../../typechain-types/contracts";
import { OrderType, handleOrder, executeOrder, createOrder, getOrderKeys, getOrderCount } from "../../utils/order";
import { getPositionCount, getAccountPositionCount } from "../../utils/position";
import {
  getWithdrawalCount,
  getWithdrawalKeys,
  createWithdrawal,
  executeWithdrawal,
  handleWithdrawal,
} from "../../utils/withdrawal";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

describe("Guardian.CancelOrder", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2;
  let reader,
    dataStore,
    oracle,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    usdc,
    swapUtils,
    eventEmitter,
    exchangeRouter;
  let usdcPriceFeed;

  beforeEach(async () => {
    fixture = await deployFixture();

    ({ user0, user1, user2 } = fixture.accounts);
    ({
      reader,
      dataStore,
      oracle,
      depositVault,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      usdc,
      usdcPriceFeed,
      swapUtils,
      eventEmitter,
      exchangeRouter,
    } = fixture.contracts);
  });

  it("Users can't cancel long limit increase orders they don't own", async () => {
    // User1 creates a limit increase order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Users can't cancel short limit increase orders they don't own", async () => {
    // User1 creates a limit increase order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitIncrease,
      isLong: false,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Users can't cancel long limit decrease orders they don't own", async () => {
    // User1 creates a limit decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitDecrease,
      isLong: true,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Users can't cancel short limit decrease orders they don't own", async () => {
    // User1 creates a limit decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitDecrease,
      isLong: false,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Users can't cancel long stop loss decrease orders they don't own", async () => {
    // User1 creates a stop loss decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Users can't cancel short stop loss decrease orders they don't own", async () => {
    // User1 creates a stop loss decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.StopLossDecrease,
      isLong: false,
    });

    const orderKeys = await getOrderKeys(dataStore, 0, 1);

    // User0 tries to cancel the order user1 just created
    await expect(exchangeRouter.connect(user0).cancelOrder(orderKeys[0]))
      .to.be.revertedWithCustomError(exchangeRouter, "Unauthorized")
      .withArgs(user0.address, "account for cancelOrder");

    // Check that the order haven't been cancelled
    expect(await getOrderCount(dataStore)).eq(1);
  });

  it("Cancel long limit increase order", async () => {
    // User1 creates a limit increase order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitIncrease,
      executionFee: expandDecimals(1, 16),
      isLong: true,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);

    // Check that user got the wnt they sent back
    expect(await wnt.balanceOf(user1.address)).eq(expandDecimals(1, 18));
  });

  it("Cancel short limit increase order", async () => {
    // User1 creates a limit increase order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitIncrease,
      executionFee: expandDecimals(1, 16),
      isLong: false,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);

    // Check that user got the wnt they sent back
    expect(await wnt.balanceOf(user1.address)).eq(expandDecimals(1, 18));
  });

  it("Cancel long limit decrease order", async () => {
    // User1 creates a limit decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitDecrease,
      executionFee: expandDecimals(1, 16),
      isLong: true,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);
  });

  it("Cancel short limit decrease order", async () => {
    // User1 creates a limit decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.LimitDecrease,
      executionFee: expandDecimals(1, 16),
      isLong: false,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);
  });

  it("Cancel long stop loss decrease order", async () => {
    // User1 creates a stop loss decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.StopLossDecrease,
      executionFee: expandDecimals(1, 16),
      isLong: true,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);
  });

  it("Cancel short stop loss decrease order", async () => {
    // User1 creates a stop loss decrease order
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(4800, 12),
      triggerPrice: expandDecimals(4700, 12),
      orderType: OrderType.StopLossDecrease,
      executionFee: expandDecimals(1, 16),
      isLong: false,
    });

    // Check that the order has been created
    expect(await getOrderCount(dataStore)).eq(1);

    const orderKeys = await getOrderKeys(dataStore, 0, 1);
    const balanceBefore = await provider.getBalance(user1.address);

    // User1 cancelled the order
    await exchangeRouter.connect(user1).cancelOrder(orderKeys[0]);

    // Get the balance of user1 after the cancellations
    const balance = await provider.getBalance(user1.address);

    // Check that some of the execution fee was returned
    expect(balance.sub(balanceBefore)).to.gt(0);

    // Check that the order have been cancelled
    expect(await getOrderCount(dataStore)).eq(0);
  });
});
