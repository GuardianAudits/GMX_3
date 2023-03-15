import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../utils/market";

import { handleDeposit } from "../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, executeOrder, handleOrder } from "../../utils/order";
import { handleDeposit } from "../../utils/deposit";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../utils/position";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import * as keys from "../../utils/keys";
import { expectTokenBalanceIncrease, getBalanceOf } from "../../utils/token";
import {
  getWithdrawalCount,
  getWithdrawalKeys,
  createWithdrawal,
  executeWithdrawal,
  handleWithdrawal,
} from "../../utils/withdrawal";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Guardian.FundingFees", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2, user3;
  let reader,
    dataStore,
    oracle,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    usdc,
    attackContract,
    exchangeRouter,
    swapHandler;
  let executionFee;
  beforeEach(async () => {
    fixture = await deployFixture();

    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({
      reader,
      dataStore,
      oracle,
      depositVault,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      usdc,
      attackContract,
      exchangeRouter,
      swapHandler,
    } = fixture.contracts);
    ({ executionFee } = fixture.props);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000 * 5000, 6),
      },
    });
  });

  it("Long positions with short collateral pays short positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2USDCBalance = expandDecimals(5 * 1000, 6);

    // Check that the users doesn't have any claimable found fees
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable usdc funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("780000");

    // User2 claims their funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780000",
    });

    // Check that User2 has received the funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(initialUser2USDCBalance.add(user2ClaimableAmount)).eq(user2USDCBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("Long positions with long collateral pays short positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable funding fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("157091142830000");

    // User2 claims their funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157091142830000",
    });

    // Check that User2 has received the funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(initialUser2WNTBalance.add(user2ClaimableAmount)).eq(user2WNTBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("Long positions with long collateral and short collateral pays shorts positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get the initial wnt balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable funding fees
    // User0
    const user0InitialClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableUSDCAmount).to.eq("0");
    const user0InitialClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user0.address)
    );
    expect(user0InitialClaimableWNTAmount).to.eq("0");

    // User2
    const user2InitialClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableUSDCAmount).to.eq("0");
    const user2InitialClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2InitialClaimableWNTAmount).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(2);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(3);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User0 closes their long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes their position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get the claimable wnt funding fees for User2
    const user2ClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount).to.eq("78545571410000");

    // Get the claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount).to.eq("390000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78545571410000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(initialUser2WNTBalance.add(user2ClaimableWNTAmount)).eq(user2WNTBalance);

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount).eq(user2USDCBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("short positions with short collateral pays long positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2USDCBalance = expandDecimals(5 * 1000, 6);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("780000");

    // User2 claims their funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780000",
    });

    // Check that User2 has received the funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(initialUser2USDCBalance.add(user2ClaimableAmount)).eq(user2USDCBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("short positions with long collateral pays long positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("157091142830000");

    // User2 claims their funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157091142830000",
    });

    // Check that User2 has received the funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(initialUser2WNTBalance.add(user2ClaimableAmount)).eq(user2WNTBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("short positions with long collateral and short collateral pays long positions", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get the initial wnt balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableUSDCAmount).to.eq("0");
    const user0InitialClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user0.address)
    );
    expect(user0InitialClaimableWNTAmount).to.eq("0");

    // User2
    const user2InitialClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableUSDCAmount).to.eq("0");
    const user2InitialClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2InitialClaimableWNTAmount).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(2);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(3);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User0 closes their short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get the claimable wnt funding fees for User2
    const user2ClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount).to.eq("78545571410000");

    // Get the claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount).to.eq("390000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78545571410000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(initialUser2WNTBalance.add(user2ClaimableWNTAmount)).eq(user2WNTBalance);

    // User2 claims their funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount).eq(user2USDCBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("longs pays shorts, claim usdc funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2USDCBalance = expandDecimals(5 * 1001, 6);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5, 6), // $5
        sizeDeltaUsd: decimalToFloat(10), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable usdc funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("780000");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableAmount).eq(user2USDCBalance);

    // Check claimable usdc funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5005, 6), // $5
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable usdc funding fees for User2
    const user2ClaimableAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount2nd).to.eq("780780");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780780",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDNewBalance = await usdc.balanceOf(user2.address);
    expect(user2USDCBalance.add(user2ClaimableAmount2nd)).eq(user2USDNewBalance.sub(initialUser2USDCBalance));

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("longs pays shorts, claim wnt funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(0, 18), // $0
        sizeDeltaUsd: decimalToFloat(10), // add $10 to the position size
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable wnt funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("157091142830000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157091142830000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(user2ClaimableAmount).eq(user2WNTBalance);

    // Check claimable wnt funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their long position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position + $10
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable wnt funding fees for User2
    const user2ClaimableAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount2nd).to.eq("157076863113170");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157076863113170",
    });

    // Check that User2 has received the wnt funding fees
    const user2USDNewBalance = await wnt.balanceOf(user2.address);
    expect(user2WNTBalance.add(user2ClaimableAmount2nd)).eq(user2USDNewBalance.sub(initialUser2WNTBalance));

    // Check claimable wnt funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("longs pays shorts, claim wnt and usdc funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(2);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(3);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User0 closes their long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(0, 18), // $0
        sizeDeltaUsd: decimalToFloat(10), // add $10 to the position size
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable wnt funding fees for User2
    const user2ClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount).to.eq("78545571410000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78545571410000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(user2ClaimableWNTAmount).eq(user2WNTBalance);

    // Check claimable wnt funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // Get claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount).to.eq("390000");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount).eq(user2USDCBalance);

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User0 closes their long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position + $10
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable wnt funding fees for User2
    const user2ClaimableWNTAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount2nd).to.eq("78538498198160");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78538498198160",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTNewBalance = await wnt.balanceOf(user2.address);
    expect(user2WNTBalance.add(user2ClaimableWNTAmount2nd)).eq(user2WNTNewBalance.sub(initialUser2WNTBalance));

    // Check claimable wnt funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // Get claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount2nd).to.eq("390390");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390390",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCNewBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount2nd).eq(user2USDCNewBalance.sub(user2USDCBalance));

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("shorts pays longs, claim usdc funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2USDCBalance = expandDecimals(5 * 1001, 6);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5, 6), // $5
        sizeDeltaUsd: decimalToFloat(10), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable usdc funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("780000");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableAmount).eq(user2USDCBalance);

    // Check claimable usdc funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5005, 6), // $5
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable usdc funding fees for User2
    const user2ClaimableAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount2nd).to.eq("780780");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "780780",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDNewBalance = await usdc.balanceOf(user2.address);
    expect(user2USDCBalance.add(user2ClaimableAmount2nd)).eq(user2USDNewBalance.sub(initialUser2USDCBalance));

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("shorts pays longs, claim wnt funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(0, 18), // $0
        sizeDeltaUsd: decimalToFloat(10), // add $10 to the position size
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable wnt funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("157091142830000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157091142830000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(user2ClaimableAmount).eq(user2WNTBalance);

    // Check claimable wnt funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their short position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position + $10
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable wnt funding fees for User2
    const user2ClaimableAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmount2nd).to.eq("157076863113170");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "157076863113170",
    });

    // Check that User2 has received the wnt funding fees
    const user2USDNewBalance = await wnt.balanceOf(user2.address);
    expect(user2WNTBalance.add(user2ClaimableAmount2nd)).eq(user2USDNewBalance.sub(initialUser2WNTBalance));

    // Check claimable wnt funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });

  it("shorts pays longs, claim wnt and usdc funding fees then accumulate more and claim again", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);

    // Get initial balance of user2
    const initialUser2WNTBalance = expandDecimals(1, 18);

    // Check that the users doesn't have any claimable found fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User2 creates a long position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that both users created their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(2);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(3);

    await time.increase(100 * 24 * 60 * 60); // 100 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    // User0 closes their short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User0 closes their short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 creates a small Increase order to be able to claim the funding fees
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(0, 18), // $0
        sizeDeltaUsd: decimalToFloat(10), // add $10 to the position size
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0 has closed out of all their positions and User2 still got a position
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Get claimable wnt funding fees for User2
    const user2ClaimableWNTAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount).to.eq("78545571410000");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78545571410000",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTBalance = await wnt.balanceOf(user2.address);
    expect(user2ClaimableWNTAmount).eq(user2WNTBalance);

    // Check claimable wnt funding fee amount is 0 after claiming
    let user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // Get claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount).to.eq("390000");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390000",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount).eq(user2USDCBalance);

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // User0 creates a short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // User0 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    await time.increase(100 * 24 * 60 * 60); // 100 days

    // User0 closes their short position with long collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5, 18), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User0 closes their short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(25 * 1000, 6), // $25,000
        sizeDeltaUsd: decimalToFloat(50 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // User2 closes out their whole position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(5000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10010), // 2x Position + $10
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // Check that both users have closed out of all their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Get claimable wnt funding fees for User2
    const user2ClaimableWNTAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableWNTAmount2nd).to.eq("78538498198160");

    // User2 claims their wnt funding fees
    await expectTokenBalanceIncrease({
      token: wnt,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [wnt.address], user2.address);
      },
      increaseAmount: "78538498198160",
    });

    // Check that User2 has received the wnt funding fees
    const user2WNTNewBalance = await wnt.balanceOf(user2.address);
    expect(user2WNTBalance.add(user2ClaimableWNTAmount2nd)).eq(user2WNTNewBalance.sub(initialUser2WNTBalance));

    // Check claimable wnt funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // Get claimable usdc funding fees for User2
    const user2ClaimableUSDCAmount2nd = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableUSDCAmount2nd).to.eq("390390");

    // User2 claims their usdc funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "390390",
    });

    // Check that User2 has received the usdc funding fees
    const user2USDCNewBalance = await usdc.balanceOf(user2.address);
    expect(user2ClaimableUSDCAmount2nd).eq(user2USDCNewBalance.sub(user2USDCBalance));

    // Check claimable usdc funding fee amount is 0 after claiming
    user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");
  });
});
