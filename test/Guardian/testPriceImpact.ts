import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, getOrderCount, handleOrder } from "../../utils/order";
import { getAccountPositionCount, getPositionCount, getPositionKeys } from "../../utils/position";
import { getPoolAmount, getSwapImpactPoolAmount } from "../../utils/market";
import { handleDeposit, getDepositCount } from "../../utils/deposit";
import * as keys from "../../utils/keys";
import { expectTokenBalanceIncrease, getBalanceOf, getSupplyOf } from "../../utils/token";

describe("Guardian.PriceImpact", () => {
  let fixture;
  let user0, user1;
  let dataStore, ethUsdMarket, wnt, usdc, reader;
  let prices;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1 } = fixture.accounts);
    ({ dataStore, ethUsdMarket, wnt, usdc, reader } = fixture.contracts);
    ({ prices } = fixture.props);

    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000 * 5000, 6),
      },
    });
  });

  it("Long position receiving positive price impact", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);

    // User1 creates a market increase unbalancing the pool
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that User1's order got filled
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);

    // User0 creates a long market increase to balance the pool
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0's order got filled
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);

    const positionKeys = await getPositionKeys(dataStore, 0, 2);
    const longPosition = await reader.getPositionInfo(dataStore.address, positionKeys[1], prices);

    const initialSizeInTokens = expandDecimals(2, 18);

    // Because we experienced +PI, our size in tokens should be greater than ($10,000 / $5,000)
    const sizeInTokens = longPosition.position.numbers.sizeInTokens;
    expect(sizeInTokens).to.be.greaterThan(initialSizeInTokens);
    expect(sizeInTokens).to.eq("2019997980002019997");
  });

  it("Long position receiving negative price impact", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);

    // User1 creates a market increase unbalancing the pool
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5005, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0's order got filled
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);

    const positionKeys = await getPositionKeys(dataStore, 0, 2);
    const longPosition = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);

    const initialSizeInTokens = expandDecimals(2, 18);

    // Because we experienced -PI, our size in tokens should be less than ($10,000 / $5,000)
    const sizeInTokens = longPosition.position.numbers.sizeInTokens;
    expect(sizeInTokens).to.be.lessThan(initialSizeInTokens);
    expect(sizeInTokens).to.eq("1999800019998000599");
  });

  it("Short position receiving negative price impact", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);

    // User0 creates a market increase unbalancing the pool
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(1, 18), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x position
        acceptablePrice: expandDecimals(5005, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // Check that User0's order got filled
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);

    const positionKeys = await getPositionKeys(dataStore, 0, 2);
    const shortPosition = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);

    const initialSizeInTokens = expandDecimals(2, 18);

    // Because we experienced -PI, our size in tokens should be less than ($10,000 / $5,000)
    const sizeInTokens = shortPosition.position.numbers.sizeInTokens;
    expect(sizeInTokens).to.be.lessThan(initialSizeInTokens);
    expect(sizeInTokens).to.eq("1999800019998000599");
  });

  it("negative price impact for deposit", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 8));
    await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User0 creates a deposit unbalancing the market
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(100, 18), // $500,000
      },
    });

    // Check that User0 got negative PI
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq("497500000000000000040000"); // $497,500

    // Check that the pool impact pool got the negative PI
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq("499999999999999992");
  });

  it("Positive price impact for deposit", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 8));
    await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User1 creates a deposit unbalancing the market
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        shortTokenAmount: expandDecimals(500 * 1000, 6), // $500,000
      },
    });

    // Check that the price impact pools received tokens from the negative PI
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq("2500000000");

    // User0 creates a deposit to balance the market
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(20, 18), // $100,000
      },
    });

    // Check that User0 got Positive PI
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq("100447499999000000000000"); // $100,447

    // Check that the price impact pools didn't receive anything
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq("0");

    // Check that the impact pool got decreased
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq("2052500001");
  });

  it("0 price impact for deposit", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 8));
    await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User0 creates a deposit keeping the market balanced
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(50, 18), // $250,000
        shortTokenAmount: expandDecimals(250 * 1000, 6), // $250,000
      },
    });

    // Check that User0 did not get any PI
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq("500000000000000000000000"); // $500,000

    // Check that the price impact pools didn't receive anything
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq("0");
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq("0");
  });

  it("Deposit both tokens, negative price impact for deposit", async () => {
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.swapImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 8));
    await dataStore.setUint(keys.swapImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // User0 creates a deposit unbalancing the market
    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(25, 18), // $125,000
        shortTokenAmount: expandDecimals(250 * 1000, 6), // $250,000
      },
    });

    // Check that User0 got negative PI
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq("374843749999666666665000"); // $374,843

    // Check that the pool impact pool got the negative PI
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq("10416666666666667");
    expect(await getSwapImpactPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq("104166667");
  });
});
