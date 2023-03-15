import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, getOrderCount, handleOrder, getAccountOrderCount } from "../../utils/order";
import { getAccountPositionCount } from "../../utils/position";
import { getPoolAmount } from "../../utils/market";
import * as keys from "../../utils/keys";
import { ethers } from "hardhat";
import { executeLiquidation } from "../../utils/liquidation";
import { grantRole } from "../../utils/role";

describe("Guardian.SpotOnlyMarkets", () => {
  let fixture;
  let user0, user1, wallet;
  let dataStore,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    solUsdMarket,
    wnt,
    usdc,
    wbtc,
    baseOrderUtils,
    roleStore,
    marketUtils;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1, wallet } = fixture.accounts);
    ({
      dataStore,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      usdc,
      wbtc,
      solUsdMarket,
      baseOrderUtils,
      roleStore,
      marketUtils,
    } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18),
        shortTokenAmount: expandDecimals(50_000, 6),
      },
    });
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18),
        shortTokenAmount: expandDecimals(50_000, 6),
      },
    });
  });

  it("Can swap in spot-only market regardless of swap path length", async () => {
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(
      ethers.utils.parseEther("10")
    );
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq("50000000000");

    await handleOrder(fixture, {
      create: {
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        acceptablePrice: 0,
        orderType: OrderType.MarketSwap,
        swapPath: [ethUsdSpotOnlyMarket.marketToken],
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await usdc.balanceOf(user0.address)).eq("50000000000");
    expect(await wnt.balanceOf(user0.address)).eq("0");
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(20, 18));
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(0);

    await handleOrder(fixture, {
      create: {
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50_000, 6),
        acceptablePrice: 0,
        orderType: OrderType.MarketSwap,
        swapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken, ethUsdSpotOnlyMarket.marketToken],
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    // Keep prior balance as test helpers just mint more tokens
    expect(await usdc.balanceOf(user0.address)).eq("50000000000");
    // Swapped 50,000 USDC for 10 ETH
    expect(await wnt.balanceOf(user0.address)).eq(expandDecimals(10, 18));
    // - 10 ETH twice leaves 0 ETH in the pool
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq("0");
    // + 50,000 USDC twice leaves 100,000 USDC in the pool
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq("100000000000");
  });

  it("Can't increase position in spot-only market", async () => {
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18));
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50_000, 6));

    await handleOrder(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        sizeDeltaUsd: decimalToFloat(25_000), // 5x position
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

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(0);
    expect(await getAccountOrderCount(dataStore, user0.address)).to.eq(0);

    await handleOrder(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18),
        sizeDeltaUsd: decimalToFloat(25_000), // 5x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.LimitIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).to.eq(0);
    expect(await getAccountOrderCount(dataStore, user0.address)).to.eq(1); // Frozen Order
  });

  it("Can't execute liquidation in spot-only market", async () => {
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18));
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50_000, 6));

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    // Spot-only market shouldn't ever have any open positions
    await expect(
      executeLiquidation(fixture, {
        account: user0.address,
        market: ethUsdSpotOnlyMarket,
        collateralToken: wnt,
        isLong: true,
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(marketUtils, "InvalidPositionMarket");
  });
});
