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

describe("Guardian.MKTU-4", () => {
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

  it("CRITICAL: Bricked pool due to 60 decimal precision", async () => {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));
    await dataStore.setUint(keys.BORROWING_FEE_RECEIVER_FACTOR, decimalToFloat(1, 3)); // 0.1%

    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5050, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getPositionCount(dataStore)).eq(1);

    // Increase time by 14 days
    await time.increase(14 * 24 * 60 * 60);

    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    let position0 = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    // Next Cumulative bf(longs) = 0 (current cum. bf) + (0.0000001 * (200,000) / 5,000,000) * (14 * 24 * 60 * 60) * 200,000 = 0.0048384
    // Borrowing Fees = 0.0048384 * $200,000 = $967.68

    // ~$967.68 slightly few more second may pass
    expect(position0.pendingBorrowingFees).to.be.within(
      "967680000000000000000000000000000",
      "967684000000000000000000000000000"
    );

    // Total Borrowing Fees = OI * cumulative borrowing factor - total borrowing
    // Total Borrowing Fees = 200,000 * 0 - 0 = 0
    // However, we have pending borrowing fees as per above which seems inaccurate.

    // Total borrowing should be 0 as positions are still stamped with 0 cumulative borrowing factor
    expect(await dataStore.getUint(keys.totalBorrowingKey(ethUsdMarket.marketToken, true))).to.eq(0);
    // Long OI should be $200,000
    expect(await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true))).to.eq(
      "200000000000000000000000000000000000"
    );
    // Cumulative borrowing factor still 0 as it hasn't been updated yet
    expect(await dataStore.getUint(keys.cumulativeBorrowingFactorKey(ethUsdMarket.marketToken, true))).to.eq(0);

    // Notice how we can currently grab the market token price since getTotalBorrowingFees returns 0
    expect(await getMarketTokenPrice(fixture, {})).to.eq(expandDecimals(1, 30));

    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5000, 12),
        executionFee: expandDecimals(1, 15),
        minOutputAmount: 0,
        orderType: OrderType.MarketIncrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });
    // Total borrowing should be non-zero now as cumulative borrowing factor was updated to non-zero value
    const totalBorrowing = await dataStore.getUint(keys.totalBorrowingKey(ethUsdMarket.marketToken, true));
    expect(totalBorrowing).to.eq("967683200000000000000000000000000000000000000000000000000000000");
    // $200,000 + $200,000
    const openInterestLong = await dataStore.getUint(keys.openInterestKey(ethUsdMarket.marketToken, wnt.address, true));
    expect(openInterestLong).to.eq(expandDecimals(400_000, 30));
    // Total Borrowing / $200,000 USDC
    const cumulativeBorrowingFactor = await dataStore.getUint(
      keys.cumulativeBorrowingFactorKey(ethUsdMarket.marketToken, true)
    );
    expect(cumulativeBorrowingFactor).to.eq("4838416000000000000000000000");

    // Calculation of getTotalBorrowingFees
    expect(openInterestLong.mul(cumulativeBorrowingFactor).sub(totalBorrowing)).to.eq(
      "967683200000000000000000000000000000000000000000000000000000000"
    );

    // OVERFLOW PANIC CODE in getPoolValue when performing applyFactor with the BORROWING_FEE_RECEIVER_FACTOR
    // since the value (first parameter) is 60 decimals instead of 30.
    await expect(getMarketTokenPrice(fixture, {})).to.be.revertedWithPanic("0x11");

    const marketTokensBefore = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    // Because of overflow, can't withdraw funds
    await handleWithdrawal(fixture, {
      create: {
        market: ethUsdMarket,
        marketTokenAmount: expandDecimals(1, 18),
      },
    });
    const marketTokensAfter = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    expect(marketTokensAfter).to.eq(marketTokensBefore);

    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).to.eq(expandDecimals(1000, 18));
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).to.eq(expandDecimals(500_000, 6));
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).to.eq(expandDecimals(5_500_000, 18));

    // Another effect is that the market tokens received after a deposit are practically non-existent.
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(500_000, 6),
      },
    });

    // 30 WEI of market tokens received by User1
    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).to.eq(30);
  });
});
