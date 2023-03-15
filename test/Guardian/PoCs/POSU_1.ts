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
import { createWithdrawal, executeWithdrawal, handleWithdrawal } from "../../../utils/withdrawal";
import { hashData, hashString, encodeData } from "../../../utils/hash";

describe("Guardian.POSU-1", () => {
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
    gasGriefingRevertContract,
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
      gasGriefingRevertContract,
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

  it("HIGH: Counting profit as collateral yields nearly infinite leverage", async () => {
    const initialUSDCAmount = expandDecimals(50_000, 6); // $50,000 USDC Collateral

    // The user opens an initial position
    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCAmount,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 40 ETH size
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, increaseParams);

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);

    await executeOrder(fixture, {
      tokens: [wnt.address],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
    });

    // Now the price of ether appreciates to $7,000 putting the position in $80,000 profit
    // The user can now withdraw most of their collateral and the position will still not be liquidated

    // The user opens an initial position
    const decreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCAmount.mul(80).div(100), // withdraw 80% of collateral
      swapPath: [],
      sizeDeltaUsd: 0, // Do not decrease size
      acceptablePrice: expandDecimals(6999, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, decreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    await executeOrder(fixture, {
      tokens: [wnt.address],
      minPrices: [expandDecimals(7000, 4)],
      maxPrices: [expandDecimals(7000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    let userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    let userPosition = userPositions[0];

    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCAmount.mul(20).div(100));

    // Not only can the user withdraw most of their collateral, but they can increase their position based on
    // the profit amount that they currently have, yielding leverage based on paper profits

    const increaseSizeParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: 0, // No extra collateral
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000), // 40 ETH size added
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, increaseSizeParams);

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    await executeOrder(fixture, {
      tokens: [wnt.address],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    userPosition = userPositions[0];

    // Position only has $10,000 of collateral but can support a size of $400,000 e.g. 400x
    expect(userPosition.numbers.collateralAmount).to.eq(initialUSDCAmount.mul(20).div(100));
    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(400 * 1000));
  });
});
