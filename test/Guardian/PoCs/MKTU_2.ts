import { expect } from "chai";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../../utils/market";
import { handleDeposit, getDepositCount } from "../../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, executeOrder, handleOrder } from "../../../utils/order";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../../utils/position";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as keys from "../../../utils/keys";

describe("Guardian.MKTU-2", () => {
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

  it("CRITICAL: More claimable funding fees then paid", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    // User0 MarketIncrease long position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000 in 10 ETH
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketIncrease short position with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketIncrease short position with long collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketIncrease long with short collateral for $100K
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Check that everyone has a position open
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(4);

    // 300 days later
    await time.increase(300 * 24 * 60 * 60);

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

    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    const user0Position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    const user3Position = await reader.getPositionInfo(dataStore.address, positionKeys[3], prices);

    // Total WNT FoundingFees paid by User0
    const totalWNTFeesPaidByUser0 = await user0Position.pendingFundingFees.fundingFeeAmount;

    // Total USDC FoundingFees paid by User3
    const totalUSDCFeesPaidByUser3 = await user3Position.pendingFundingFees.fundingFeeAmount;

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await wnt.balanceOf(user0.address)).to.eq(0);
    expect(await wnt.balanceOf(user1.address)).to.eq(0);
    expect(await wnt.balanceOf(user2.address)).to.eq(0);
    expect(await wnt.balanceOf(user3.address)).to.eq(0);
    expect(await usdc.balanceOf(user0.address)).to.eq(0);
    expect(await usdc.balanceOf(user1.address)).to.eq(0);
    expect(await usdc.balanceOf(user2.address)).to.eq(0);
    expect(await usdc.balanceOf(user3.address)).to.eq(0);

    // User0 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // User1 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User2 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18), // $50,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: false,
        shouldUnwrapNativeToken: false,
      },
    });

    // User3 MarketDecrease for the whole position size
    await handleOrder(fixture, {
      create: {
        account: user3,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(100 * 1000, 6), // $100,000
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Check total wnt funding fees paid by User0
    expect(totalWNTFeesPaidByUser0).eq("3455997333333400000");

    // Check total usdc funding fees paid by User3
    expect(totalUSDCFeesPaidByUser3).eq("69120000000");

    // Check User1's claimable funding fees
    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address))
    ).to.eq("5183999266666700000");
    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address))
    ).to.eq("51840000000");

    // Check User2's claimable funding fees
    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address))
    ).to.eq("5183999266666700000");
    expect(
      await dataStore.getUint(keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address))
    ).to.eq("51840000000");

    // Check User0 has less balance than initially, e.g. User0 paid funding fees in WNT
    expect(await wnt.balanceOf(user0.address)).to.lt(expandDecimals(10, 18));

    // Check User3 has less balance than initially, e.g. User3 paid funding fees in USDC
    expect(await usdc.balanceOf(user3.address)).to.lt(expandDecimals(1000 * 1000, 6));

    // First we'll showcase that there is more WNT funding fee to be claimed the being paid, under that test we'll showcase that there is more USDC funding fee to be claimed then being paid

    // TEST more claimable WNT funding fees then paid
    const totalFeeAmountPaidWNT = BigInt(totalWNTFeesPaidByUser0);

    // Get total of claimable funding fees from User1 and User2
    const claimableWNTUser1 = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    const claimableWNTUser2 = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, wnt.address, user2.address)
    );
    const totalClaimableFeesWNT = BigInt(claimableWNTUser1) + BigInt(claimableWNTUser2);

    // When funding fees are paid by the long side, each token per size value is divided amongst the total long open interest, but not every long position is capable of paying out the fees for either collateral tokens

    // Check that the total amount of fees claimable is more the total fees paid
    expect(totalClaimableFeesWNT).to.gt(totalFeeAmountPaidWNT);

    // TEST more claimable USDC funding fees then paid
    const totalFeeAmountPaidUSDC = BigInt(totalUSDCFeesPaidByUser3);

    // Get total of claimable funding fees from User1 and User2
    const claimableUSDCUser1 = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user1.address)
    );
    const claimableUSDCUser2 = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    const totalClaimableFeesUSDC = BigInt(claimableUSDCUser1) + BigInt(claimableUSDCUser2);

    // When funding fees are paid by the short side, each token per size value is divided amongst the total short open interest, but not every short position is capable of paying out the fees for either collateral tokens

    // Check that the total amount of fees claimable is more the the total fees paid
    expect(totalClaimableFeesUSDC).to.gt(totalFeeAmountPaidUSDC);

    // Check there is no open positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user1.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user3.address)).eq(0);
    expect(await getPositionCount(dataStore)).eq(0);
  });
});
