import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, getOrderCount, createOrder, handleOrder } from "../../utils/order";
import { handleDeposit } from "../../utils/deposit";
import { getPositionCount } from "../../utils/position";
import { expect } from "chai";
import { getSyntheticTokenAddress } from "../../utils/token";
import { TOKEN_ORACLE_TYPES } from "../../utils/oracle";

describe("Guardian.StopLossDecrease", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2, wallet;
  let reader,
    dataStore,
    oracle,
    solUsdMarket,
    solAddr,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    usdc,
    attackContract,
    roleStore,
    decreasePositionUtils,
    exchangeRouter,
    ethUsdtMarket,
    usdt,
    swapHandler;
  let executionFee;
  beforeEach(async () => {
    fixture = await deployFixture();

    ({ wallet, user0, user1, user2 } = fixture.accounts);
    ({
      reader,
      dataStore,
      oracle,
      solUsdMarket,
      depositVault,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      decreasePositionUtils,
      usdc,
      usdt,
      attackContract,
      exchangeRouter,
      roleStore,
      swapHandler,
      ethUsdtMarket,
    } = fixture.contracts);
    ({ executionFee } = fixture.props);

    solAddr = getSyntheticTokenAddress("SOL");

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10000000, 18),
        shortTokenAmount: expandDecimals(10000000 * 5000, 6),
      },
    });
    await handleDeposit(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10000000, 18),
        shortTokenAmount: expandDecimals(10000000 * 5000, 6),
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: ethUsdtMarket,
        longTokenAmount: expandDecimals(10000000, 18),
        shortTokenAmount: expandDecimals(10000000 * 5000, 6),
      },
      execute: {
        priceFeedTokens: [usdt.address],
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(10000000, 18), // ETH
        shortTokenAmount: expandDecimals(10000000 * 5000, 6), // USDC
      },
      execute: {
        tokens: [wnt.address, usdc.address, solAddr],
        precisions: [8, 18, 8],
        minPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        maxPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
      },
    });
  });

  it("Users can create a StopLossDecrease for their shorts & it executes successfully", async () => {
    const initialUSDCBalance = expandDecimals(50 * 1000, 6); // 50,000 USDC
    expect(await getOrderCount(dataStore)).eq(0);

    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 4x leverage -- position size is 40 ETH @ $5,000/ETH
      acceptablePrice: expandDecimals(4999, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    const userUSDCBalBefore = await usdc.balanceOf(user1.address);
    const userWNTBalBefore = await wnt.balanceOf(user1.address);

    let decreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance.div(2), // Decreases half collateral
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(100 * 1000), // Decreases half the size
      acceptablePrice: expandDecimals(5505, 12),
      triggerPrice: expandDecimals(5500, 12),
      orderType: OrderType.StopLossDecrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: decreaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(5490, 4), expandDecimals(5500, 4)], // ETH goes up 10%, a range is provided
        maxPrices: [expandDecimals(5490, 4), expandDecimals(5500, 4)],
        precisions: [8, 8],
        priceFeedTokens: [usdc.address],
      },
    });

    const userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    const userPosition = userPositions[0];

    // Losses are $500 per ETH
    // Position size in tokens is 40 ETH
    // Execution price will be the latest price from the range, e.g. 5500
    // Losses are $20,000 from collateral
    // Half of the losses are realized

    const collateralRemoved = initialUSDCBalance.div(2);
    const collateralLost = expandDecimals(10_000, 6);

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(100 * 1000)); // Half size is still there
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance.sub(collateralRemoved).sub(collateralLost)); // Half collateral removed

    expect((await usdc.balanceOf(user1.address)).sub(userUSDCBalBefore)).to.eq(initialUSDCBalance.div(2)); // User gets half collateral back
    expect((await wnt.balanceOf(user1.address)).sub(userWNTBalBefore)).to.eq(0); // User realizes no profits
  });

  it("Users can create a StopLossDecrease for their longs & it executes successfully", async () => {
    const initialUSDCBalance = expandDecimals(50 * 1000, 6); // 50,000 USDC
    expect(await getOrderCount(dataStore)).eq(0);

    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 4x leverage -- position size is 40 ETH @ $5,000/ETH
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
      gasUsageLabel: "createOrder",
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 18],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    const userUSDCBalBefore = await usdc.balanceOf(user1.address);
    const userWNTBalBefore = await wnt.balanceOf(user1.address);

    const decreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance.div(2), // Decreases half collateral
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(100 * 1000), // Decreases half the size
      acceptablePrice: expandDecimals(4495, 12),
      triggerPrice: expandDecimals(4500, 12),
      orderType: OrderType.StopLossDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
      gasUsageLabel: "createOrder",
    };

    await handleOrder(fixture, {
      create: decreaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(4510, 4), expandDecimals(4500, 4)], // ETH goes down 10%, a range is provided
        maxPrices: [expandDecimals(4510, 4), expandDecimals(4500, 4)],
        precisions: [8, 8],
        priceFeedTokens: [usdc.address],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    const userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    const userPosition = userPositions[0];

    // Losses are $500 per ETH
    // Position size in tokens is 40 ETH
    // Execution price will be the latest price from the range, e.g. 4500
    // Losses are $20,000 from collateral
    // Half of the losses are realized

    const collateralRemoved = initialUSDCBalance.div(2);
    const collateralLost = expandDecimals(10_000, 6);

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(100 * 1000)); // Half size is still there
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance.sub(collateralRemoved).sub(collateralLost)); // Half collateral removed

    expect((await usdc.balanceOf(user1.address)).sub(userUSDCBalBefore)).to.eq(initialUSDCBalance.div(2)); // User gets half collateral back
    expect((await wnt.balanceOf(user1.address)).sub(userWNTBalBefore)).to.eq(0); // User realizes no profits
  });
});
