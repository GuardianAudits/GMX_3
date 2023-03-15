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

describe("Guardian.MKTU-7", () => {
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

  it("HIGH: Pending Borrowing Fees Not Up-To-Date In Pool Value", async () => {
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1, 7));
    await dataStore.setUint(keys.borrowingFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 7));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(1));
    await dataStore.setUint(keys.borrowingExponentFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(1));

    // $1 per market token
    const initialMarketTokenPrice = await getMarketTokenPrice(fixture, {});
    expect(initialMarketTokenPrice).to.eq(expandDecimals(1, 30));

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
    expect(position0.pendingBorrowingFees).to.be.lte("967684000000000000000000000000000");
    expect(position0.pendingBorrowingFees).to.be.gte("967680000000000000000000000000000");

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

    // $1 per market token which is the price of each market token at User0's deposit
    // This shows the pending borrowing fees are not included in the pool value
    // and LPer(s) that withdraw will not get the proper output amount
    expect(await getMarketTokenPrice(fixture, {})).to.eq(initialMarketTokenPrice);

    // Out-of-date borrowing fees in pool value open pool up to risk-free arbitrage opportunities

    // Deposit at cheaper pool value
    await handleDeposit(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(500 * 1000, 6),
      },
    });

    // User1 closes position which adds the borrowing fees to the pool
    await handleOrder(fixture, {
      create: {
        account: user1,
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        swapPath: [],
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        orderType: OrderType.MarketDecrease,
        isLong: true,
        shouldUnwrapNativeToken: false,
      },
    });

    // Withdraw after borrowing fees included in pool value
    await handleWithdrawal(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        marketTokenAmount: expandDecimals(5_500_000, 18),
      },
    });

    // User2 gains more WNT than put in
    expect(await getBalanceOf(wnt.address, user2.address)).to.be.gt(expandDecimals(1000, 18));
    expect(await getBalanceOf(usdc.address, user2.address)).to.eq(expandDecimals(500 * 1000, 6));
  });
});
