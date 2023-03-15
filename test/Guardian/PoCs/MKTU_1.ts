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

describe("Guardian.MKTU-1", () => {
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

  it("CRITICAL: Price impact experienced twice in pool value", async () => {
    // Note that this test shows price impact being counted twice in the case
    // that it increases pool value since current position PI logic is broken. TODO due to POSU-X
    // It can also be used the other way around to detract the PI from the pool value twice.

    // set price impact to 0.1% for every $50,000 of token imbalance
    // 0.1% => 0.001
    // 0.001 / 50,000 => 2 * (10 ** -8)
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, true), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactFactorKey(ethUsdMarket.marketToken, false), decimalToFloat(2, 8));
    await dataStore.setUint(keys.positionImpactExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(2, 0));

    expect(await getOrderCount(dataStore)).eq(0);

    const params = {
      market: ethUsdMarket,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: expandDecimals(10, 18),
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(400 * 1000), // Position is 80 ETH
      acceptablePrice: expandDecimals(5050, 12),
      executionFee: expandDecimals(1, 15),
      minOutputAmount: expandDecimals(50000, 6),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, params);

    expect(await getOrderCount(dataStore)).eq(1);
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getPositionCount(dataStore)).eq(0);

    expect(await getMarketTokenPrice(fixture, {})).to.eq(expandDecimals(1, 30));

    await executeOrder(fixture, {
      gasUsageLabel: "executeOrder",
    });

    // 0.1% for every $50,000. With $400,000, use 0.8%.
    // ($400,000 * 0.8% / 2) / 5000 = ~0.32 ETH ($1,600) sent to impact pool
    const impactPoolETH = "319999999999984000";
    const impactPoolValue = BigNumber.from(impactPoolETH).mul(expandDecimals(5000, 12));
    expect(await dataStore.getUint(keys.positionImpactPoolAmountKey(ethUsdMarket.marketToken))).to.eq(impactPoolETH);

    const marketTokenPrice = await getMarketTokenPrice(fixture, {});
    const poolValue = marketTokenPrice.mul(await getSupplyOf(ethUsdMarket.marketToken)).div(expandDecimals(1, 18));
    const tokenValues = decimalToFloat(1000 * 5000 + 500_000 * 1); // pool amounts * prices

    const positionKeys = await getPositionKeys(dataStore, 0, 1);
    const position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    const sizeInTokens = position.position.numbers.sizeInTokens;
    const expectedPositionSizeWithoutNegativeImpact = expandDecimals(80, 18); // 80 ETH
    const immediateTraderLoss = expectedPositionSizeWithoutNegativeImpact
      .sub(sizeInTokens)
      .mul(expandDecimals(5000, 12));
    expect(immediateTraderLoss).to.eq("1593625498007888765000000000000000"); // ~$1593

    // This ~$1593 value is also accounted for in the impact pool
    expect(impactPoolValue).to.lt(immediateTraderLoss.mul(101).div(100));
    expect(impactPoolValue).to.gt(immediateTraderLoss.mul(99).div(100));

    // Pool amount values + impact amount value + immediate loss due to inferior execution price = net pool value
    // Notice how the price impact has a "doubling" effect - it affects the pool value through the impact pool
    // and it affects the PnL through the execution price.
    expect(tokenValues.add(impactPoolValue).add(immediateTraderLoss)).to.eq(poolValue);
    // Market token price increases
    expect(await getMarketTokenPrice(fixture, {})).to.eq("1000580659181455965230000000000");

    const marketTokensOwnedBefore = await getBalanceOf(ethUsdMarket.marketToken, user0.address);

    // Reverts with "Invalid state, negative poolAmount"
    // Since pool-value is over-inflated, user can't withdraw funds.
    await handleWithdrawal(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        marketTokenAmount: marketTokensOwnedBefore,
      },
    });

    // Withdrawal was not able to go through
    const marketTokensOwnedAfter = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    expect(marketTokensOwnedBefore).to.eq(marketTokensOwnedAfter);
  });
});
