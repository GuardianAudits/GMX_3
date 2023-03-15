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

describe("Guardian.DPCU-2", () => {
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

  it("CRITICAL: EmptyPositionError can be used to game LimitDecreases", async () => {
    const initialWNTAmount = expandDecimals(20, 18);

    // User1 makes a position of size 20 WNT
    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTAmount,
      sizeDeltaUsd: decimalToFloat(100 * 1000), // Position size of 20 ETH
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
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

    // Price increases to ~$6,000 per ETH & User1 wants to lock in these prices so that
    // he can exit at them in the future, but only if he wants to.
    // Now User1 can wait to see if more profits will come & rest easy knowing that he has an out at $6,000 per ETH
    // User1 creates a LimitDecrease where he attempts to withdraw all collateral
    // and reduce his position size by 15 WNT
    const limitDecreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTAmount, // Attempts to withdraw all collateral
      sizeDeltaUsd: decimalToFloat(75 * 1000), // Decrease by 3/4
      acceptablePrice: expandDecimals(6000, 12),
      triggerPrice: expandDecimals(6000, 12),
      orderType: OrderType.LimitDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getPositionCount(dataStore)).to.eq(1);
    expect(await getOrderCount(dataStore)).to.eq(0);

    await createOrder(fixture, limitDecreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(1);

    const limitDecreaseOrderKey = (await getOrderKeys(dataStore, 0, 1))[0];

    await expect(
      executeOrder(fixture, {
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(5995, 4), expandDecimals(6005, 4)],
        maxPrices: [expandDecimals(5995, 4), expandDecimals(6005, 4)],
        precisions: [8, 8],
        priceFeedTokens: [usdc.address],
      })
    ).to.be.revertedWithCustomError(positionUtils, "EmptyPosition");

    expect(await getPositionCount(dataStore)).to.eq(1);
    expect(await getOrderCount(dataStore)).to.eq(1); // Order still exists in the store

    // Now wait some time, see that price moves in the user's favor

    // Now the user submits a MarketDecrease to reduce his position size to 15 WNT
    const marketDecreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: 0, // Withdraws no collateral
      sizeDeltaUsd: decimalToFloat(25 * 1000), // Decrease by 1/4
      acceptablePrice: expandDecimals(6000, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, marketDecreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(2);

    const orderKeys = await getOrderKeys(dataStore, 0, 5);
    const marketDecreaseKey = orderKeys[1];

    await executeOrder(fixture, {
      key: marketDecreaseKey,
      tokens: [wnt.address],
      minPrices: [expandDecimals(6000, 4)],
      maxPrices: [expandDecimals(6000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
    });

    expect(await getPositionCount(dataStore)).to.eq(1);
    expect(await getOrderCount(dataStore)).to.eq(1); // Original LimitDecrease Order still exists in the store

    const userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    const userPosition = userPositions[0];

    // Position size is now 15 ETH, it can now be closed when the limitDecrease is executed
    // Therefore bypassing the validatePosition check & closing the position
    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(75 * 1000));

    const userWNTBalBefore = await wnt.balanceOf(user1.address);
    const userUSDCBalBefore = await usdc.balanceOf(user1.address);

    // The user has now allowed their limitDecrease order to be executed
    // This can be gamed in the event that price action does the following
    //
    // $ |       ___    ____/\
    //   |     _/   \__/      \
    // t |----/----------------\-------
    //   | __/                  \_
    //   |                        \
    //   +----Y-------------------X---- time
    //
    // t - triggerPrice

    // The valid range must include the triggerPrice, and the user can leverage
    // The acceptable price to always get a price that enables a risk-free trade
    // When this scenario has played out.

    // We are now at time X where price << t
    // For example at time Y in the chart above the price is $6,000
    // Now at time X price is $4,000
    // The keeper now attempts to execute the LimitDecrease with a valid increasing range including the triggerPrice
    // No matter the range, as long as it is valid and includes the triggerPrice the user is able to get that price
    // Through their acceptablePrice (not accounting for impact).

    // Now the user is able to have their LimitDecrease executed at a $6,000 price while the current price is $4,000
    // Even if the range provided includes the current price of $4,000, User1 will still receive the triggerPrice or
    // Better due to the acceptablePrice.
    // *And the range must include the triggerPrice or better
    await executeOrder(fixture, {
      key: limitDecreaseOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(4000, 4), expandDecimals(6000, 4)],
      maxPrices: [expandDecimals(4000, 4), expandDecimals(6000, 4)],
      precisions: [8, 8],
      priceFeedTokens: [usdc.address],
    });

    // User receives $6,000 as an execution price
    // Profit of $1,000 per ETH for a position size of 15 ETH
    // $15,000 profit gets paid out in ETH
    // $15,000 / $6,000 = 2.5 ETH
    const profitAmount = ethers.utils.parseEther("2.5");

    expect((await wnt.balanceOf(user1.address)).sub(userWNTBalBefore)).to.eq(profitAmount.add(initialWNTAmount));
    expect((await usdc.balanceOf(user1.address)).sub(userUSDCBalBefore)).to.eq(0);

    expect(await getPositionCount(dataStore)).to.eq(0);
    expect(await getOrderCount(dataStore)).to.eq(0);
  });
});
