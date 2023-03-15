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

describe("Guardian.GLOBAL-9", () => {
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

  it("MEDIUM: Range between withdrawal PnL/Pool Factor and ADL PnL/Pool Factor can brick withdrawals", async () => {
    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(50, 18), // $2,500,000 worth of ETH
        shortTokenAmount: expandDecimals(100 * 5000, 6), // USDC
      },
      execute: {
        tokens: [wnt.address, usdc.address, solAddr],
        precisions: [8, 18, 8],
        minPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
        maxPrices: [expandDecimals(2500, 4), expandDecimals(1, 6), expandDecimals(15, 4)],
      },
    });

    await handleOrder(fixture, {
      create: {
        market: solUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(50, 18),
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    const maxPnlFactorKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR, solUsdMarket.marketToken, true);
    const maxPnlFactorForAdlKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR_FOR_ADL, solUsdMarket.marketToken, true);
    const minPnlFactorAfterAdlKey = keys.maxPnlFactorKey(keys.MIN_PNL_FACTOR_AFTER_ADL, solUsdMarket.marketToken, true);
    const maxPnlFactorForWithdrawalKey = keys.maxPnlFactorKey(
      keys.MAX_PNL_FACTOR_FOR_WITHDRAWALS,
      solUsdMarket.marketToken,
      true
    );

    await dataStore.setUint(maxPnlFactorKey, decimalToFloat(40, 2)); // 40%
    await dataStore.setUint(maxPnlFactorForAdlKey, decimalToFloat(40, 2)); // 40%
    await dataStore.setUint(minPnlFactorAfterAdlKey, decimalToFloat(30, 2)); // 30%
    await dataStore.setUint(maxPnlFactorForWithdrawalKey, decimalToFloat(20, 2)); // 20%

    await grantRole(roleStore, wallet.address, "ADL_KEEPER");

    // Price increases $8 per SOL token
    // $8 per token for 100,000 tokens puts profit at $800,000 which is 32% of the pool value.
    // Not enough to trigger ADL but enough to prevent withdrawals
    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(28, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(28, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).be.false;

    await expect(
      executeAdl(fixture, {
        account: user0.address,
        market: solUsdMarket,
        collateralToken: wnt,
        isLong: true,
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(28, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(28, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "executeAdl",
      })
    ).to.be.revertedWithCustomError(adlUtils, "AdlNotEnabled");

    // LPers can't pull out funds till profit decreases or pool value increases
    const marketTokenBalanceBefore = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    await handleWithdrawal(fixture, {
      create: {
        market: solUsdMarket,
        marketTokenAmount: marketTokenBalanceBefore,
      },
    });
    const marketTokenBalanceAfter = await getBalanceOf(ethUsdMarket.marketToken, user0.address);
    expect(marketTokenBalanceBefore).to.eq(marketTokenBalanceAfter);
  });
});
