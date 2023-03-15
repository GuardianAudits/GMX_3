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

describe("Guardian.DPU-2", () => {
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

  it("MEDIUM: Drain Treasury Through Liquidations", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    await dataStore.setUint(keys.MIN_COLLATERAL_USD, decimalToFloat(10)); // Min $10

    let ntBalBeforeCreates = await ethers.provider.getBalance(wallet.address);
    await createOrder(fixture, {
      market: ethUsdMarket,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: expandDecimals(10, 6),
      sizeDeltaUsd: decimalToFloat(20),
      acceptablePrice: expandDecimals(5000, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
    });

    await createOrder(fixture, {
      market: ethUsdMarket,
      initialCollateralToken: usdc,
      sizeDeltaUsd: decimalToFloat(5),
      acceptablePrice: expandDecimals(5000, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
    });

    let ntBalAfterCreates = await ethers.provider.getBalance(wallet.address);
    const user0GasSpent = ntBalBeforeCreates.sub(ntBalAfterCreates);

    // Execute the MarketIncrease
    await executeOrder(fixture, {
      tokens: [wnt.address, usdc.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
    });

    // User0's position was increased, and DecreaseOrder hasn't been executed yet
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(1);

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");

    await expect(
      executeLiquidation(fixture, {
        account: user0.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: true,
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(decreasePositionUtils, "PositionShouldNotBeLiquidated");

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(1);

    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%

    // Execute decrease order so that collateral falls below min collateral
    await executeOrder(fixture, {
      tokens: [wnt.address, usdc.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
    });

    // User0's position was decreased (not fully)
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    await mine(1);

    const walletBalBeforeLiquidation = await ethers.provider.getBalance(wallet.address);

    // The position can be liquidated as it falls below min collateral threshold
    // Notice how it can be liquidated almost right after a user is able to decrease their order successfully
    // which may be unexpected from a user's perspective.
    await executeLiquidation(fixture, {
      account: user0.address,
      market: ethUsdMarket,
      collateralToken: usdc,
      isLong: true,
      minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "liquidationHandler.executeLiquidation",
    });

    const walletBalAfterLiquidation = await ethers.provider.getBalance(wallet.address);

    // After liquidation, no position for user0 is live.
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getOrderCount(dataStore)).eq(0);

    // Calculate how much ETH was spent by the keepers
    const ethLost = walletBalBeforeLiquidation.sub(walletBalAfterLiquidation);

    expect(walletBalAfterLiquidation).to.be.lessThan(walletBalBeforeLiquidation);
    // The USD value of the ETH lost is more than the $~10 collateral the pool absorbed post-liquidation.
    expect(ethLost.mul(expandDecimals(5000, 12))).to.be.gte(decimalToFloat(10));
    // User0 spent less on gas than the treasury spent solely on executing the liquidation.
    // Since the user can take more from the keeper than they spend on gas, there is potential for a griefing attack.
    expect(user0GasSpent).to.be.lessThan(ethLost.mul(7).div(10));
  });
});
