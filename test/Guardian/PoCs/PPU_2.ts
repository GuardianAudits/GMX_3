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

describe("Guardian.PPU-2", () => {
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

  it("HIGH: Price Impact For Trader != Position Price Impact Pool Accounting", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    // Increase $100,000 Short Order by User0 will have -PI
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5000, 6),
        sizeDeltaUsd: decimalToFloat(100_000),
        acceptablePrice: expandDecimals(4900, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);
    const beforeImpactPoolAmt = await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken));

    // Increase $10,000 Long Order by User1 will have +PI as they helped balance the short OI
    await createOrder(fixture, {
      account: user1,
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(1, 18),
      sizeDeltaUsd: decimalToFloat(10_000),
      acceptablePrice: expandDecimals(5100, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
    });
    // Limit order go to future block
    await mine(10);

    await executeOrder(fixture, {
      tokens: [wnt.address, usdc.address, wnt.address, usdc.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6), expandDecimals(5000, 4), expandDecimals(1, 6)],
      tokenOracleTypes: [
        TOKEN_ORACLE_TYPES.DEFAULT,
        TOKEN_ORACLE_TYPES.DEFAULT,
        TOKEN_ORACLE_TYPES.DEFAULT,
        TOKEN_ORACLE_TYPES.DEFAULT,
      ],
      precisions: [8, 18, 8, 18],
    });
    const afterImpactPoolAmt = await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken));

    expect(await getAccountPositionCount(dataStore, user1.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    const positionKeys = await getPositionKeys(dataStore, 0, 2);
    const longPosition = await reader.getPositionInfo(dataStore.address, positionKeys[1], prices);
    const unimpactedSizeInTokens = expandDecimals(2, 18);
    // Because we experienced +PI, our size in tokens should be greater than ($10,000 / $5,000)
    const sizeInTokens = longPosition.position.numbers.sizeInTokens;
    expect(sizeInTokens).to.be.greaterThan(unimpactedSizeInTokens);
    const traderPriceImpactAmount = sizeInTokens.sub(unimpactedSizeInTokens);

    const impactPoolDiff = beforeImpactPoolAmt.sub(afterImpactPoolAmt);
    expect(ethers.utils.formatEther(beforeImpactPoolAmt)).to.equal("0.02");
    expect(ethers.utils.formatEther(afterImpactPoolAmt)).to.equal("0.0002");
    expect(ethers.utils.formatEther(traderPriceImpactAmount)).to.equal("0.019997980002019997");
    expect(ethers.utils.formatEther(impactPoolDiff)).to.equal("0.0198");
    // The impact pool loses less tokens than the trader gains for their position.
    // The difference can add up over time and negatively influence the pool value.
    // Greater by ~1%
    expect(traderPriceImpactAmount).to.be.greaterThan(impactPoolDiff.mul(1009).div(1000));

    // The price impact the trader experiences differs from the price impact
    // calculated through PositionPricingUtils.getPriceImpactAmount. The discrepancy
    // is due to the fact the price impact usd is divided by the execution price
    // to get the amount the trader gains/loses, but the price impact usd is divided by the latest price
    // when calculating the delta amount for the impact pool. The disparity is maximized
    // when the difference between the latest price and execution price is maximized.
  });
});
