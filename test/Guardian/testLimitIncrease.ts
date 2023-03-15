import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { OrderType, getOrderCount, createOrder, handleOrder } from "../../utils/order";
import { handleDeposit } from "../../utils/deposit";
import { getPositionCount } from "../../utils/position";
import { expect } from "chai";
import { getSyntheticTokenAddress } from "../../utils/token";

describe("Guardian.LimitIncrease", () => {
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
  });

  it("Users cannot use LimitIncrease to open their short position when price goes down", async () => {
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
      acceptablePrice: expandDecimals(5490, 12),
      triggerPrice: expandDecimals(5500, 12),
      orderType: OrderType.LimitIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    // Order reverts because of InvalidOrderPrices
    await expect(
      handleOrder(fixture, {
        create: increaseParams,
        execute: {
          tokens: [wnt.address, wnt.address],
          minPrices: [expandDecimals(5510, 4), expandDecimals(5490, 4)],
          maxPrices: [expandDecimals(5510, 4), expandDecimals(5490, 4)],
          priceFeedTokens: [usdc.address],
          precisions: [8, 8],
        },
      })
    ).to.be.reverted;

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);
  });

  it("Users cannot use LimitIncrease to open their long position when price goes up", async () => {
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
      acceptablePrice: expandDecimals(4510, 12),
      triggerPrice: expandDecimals(4500, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await expect(
      handleOrder(fixture, {
        create: increaseParams,
        execute: {
          tokens: [wnt.address, wnt.address],
          minPrices: [expandDecimals(4490, 4), expandDecimals(4510, 4)],
          maxPrices: [expandDecimals(4490, 4), expandDecimals(4510, 4)],
          priceFeedTokens: [usdc.address],
          precisions: [8, 8],
        },
      })
    ).to.be.reverted;

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);
  });

  it("Users can use LimitIncrease to open & add to their long position when price goes down", async () => {
    const initialUSDCBalance = expandDecimals(50 * 1000, 6); // 50,000 USDC
    expect(await getOrderCount(dataStore)).eq(0);

    let increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 4x leverage -- position size is 40 ETH @ $5,000/ETH
      acceptablePrice: expandDecimals(4500, 12),
      triggerPrice: expandDecimals(4500, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(4510, 4), expandDecimals(4490, 4)],
        maxPrices: [expandDecimals(4510, 4), expandDecimals(4490, 4)],
        priceFeedTokens: [usdc.address],
        precisions: [8, 8],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    let userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    let userPosition = userPositions[0];

    // Size in tokens = $200,000 / 4,500 => 44.4444444444 ETH
    let sizeInTokens = ethers.utils.parseEther("44.444444444444444444");

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(200 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(sizeInTokens);
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance);

    increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // Double position size
      acceptablePrice: expandDecimals(4000, 12),
      triggerPrice: expandDecimals(4000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(4010, 4), expandDecimals(3990, 4)],
        maxPrices: [expandDecimals(4010, 4), expandDecimals(3990, 4)],
        priceFeedTokens: [usdc.address],
        precisions: [8, 8],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    userPosition = userPositions[0];

    // Size in tokens = $200,000 / 4,000 => 50 ETH
    const sizeDeltaInTokens = ethers.utils.parseEther("50");
    sizeInTokens = sizeInTokens.add(sizeDeltaInTokens);

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(400 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(sizeInTokens);
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance.mul(2));
  });

  it("Users can use LimitIncrease to open & add to their short position when price goes up", async () => {
    const initialUSDCBalance = expandDecimals(50 * 1000, 6); // 50,000 USDC
    expect(await getOrderCount(dataStore)).eq(0);

    let increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 4x leverage -- position size is 40 ETH @ $5,000/ETH
      acceptablePrice: expandDecimals(5500, 12),
      triggerPrice: expandDecimals(5500, 12),
      orderType: OrderType.LimitIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(5490, 4), expandDecimals(5510, 4)],
        maxPrices: [expandDecimals(5490, 4), expandDecimals(5510, 4)],
        priceFeedTokens: [usdc.address],
        precisions: [8, 8],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    let userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    let userPosition = userPositions[0];

    // Size in tokens = $200,000 / 5,500 => 36.3636363636 ETH
    let sizeInTokens = ethers.utils.parseEther("36.363636363636363637");

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(200 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(sizeInTokens);
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance);

    increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // Double position size
      acceptablePrice: expandDecimals(6000, 12),
      triggerPrice: expandDecimals(6000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: false,
      shouldUnwrapNativeToken: false,
    };

    await handleOrder(fixture, {
      create: increaseParams,
      execute: {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(5990, 4), expandDecimals(6010, 4)],
        maxPrices: [expandDecimals(5990, 4), expandDecimals(6010, 4)],
        priceFeedTokens: [usdc.address],
        precisions: [8, 8],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    userPosition = userPositions[0];

    // Size in tokens = $200,000 / 6,000 => 33.3333333333 ETH
    const sizeDeltaInTokens = ethers.utils.parseEther("33.333333333333333334");
    sizeInTokens = sizeInTokens.add(sizeDeltaInTokens);

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(400 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(sizeInTokens);
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCBalance.mul(2));
  });
});
