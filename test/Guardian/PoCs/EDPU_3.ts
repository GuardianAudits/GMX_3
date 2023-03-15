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

describe("Guardian.EDPU-3", () => {
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

  it("MEDIUM: Market token price can decrease after deposit pause due to PnL factor", async () => {
    expect(await getPoolAmount(dataStore, solUsdMarket.marketToken, wnt.address)).eq(ethers.utils.parseEther("0"));

    // Deposit ETH into SOLUSD market
    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
    expect(await getPoolAmount(dataStore, solUsdMarket.marketToken, wnt.address)).eq(ethers.utils.parseEther("1000"));

    // Create long order for $2,000,000 at $20/SOL
    await handleOrder(fixture, {
      create: {
        market: solUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(100, 18),
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        precisions: [8, 8, 18],
      },
    });
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);

    const maxPnlFactorForAdlKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR_FOR_ADL, ethUsdMarket.marketToken, true);
    const minPnlFactorAfterAdlKey = keys.maxPnlFactorKey(keys.MIN_PNL_FACTOR_AFTER_ADL, ethUsdMarket.marketToken, true);

    await dataStore.setUint(maxPnlFactorForAdlKey, decimalToFloat(10, 2)); // 10%
    await dataStore.setUint(minPnlFactorAfterAdlKey, decimalToFloat(2, 2)); // 2%
    await grantRole(roleStore, wallet.address, "ADL_KEEPER");

    // Deposit does not go through as MAX_PNL_FACTOR_FOR_DEPOSTS is exceeded
    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(60, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(60, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
    // Notice how amount of ETH in pool does not change
    expect(await getPoolAmount(dataStore, solUsdMarket.marketToken, wnt.address)).eq(ethers.utils.parseEther("1000"));

    // Price rose to $60/SOL, so ADL can be enabled
    const updateAdlSolPrice = expandDecimals(60, 4);
    const updateAdlWntPrice = expandDecimals(12000, 4);

    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      minPrices: [updateAdlSolPrice, updateAdlWntPrice, expandDecimals(1, 6)],
      maxPrices: [updateAdlSolPrice, updateAdlWntPrice, expandDecimals(1, 6)],
      precisions: [8, 8, 18],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).eq(true);

    const marketTokenPriceBefore = await getMarketTokenPrice(fixture, {
      market: solUsdMarket,
      indexTokenPrice: {
        min: updateAdlSolPrice.mul(10 ** 8),
        max: updateAdlSolPrice.mul(10 ** 8),
      },
      longTokenPrice: {
        min: updateAdlWntPrice.mul(10 ** 8),
        max: updateAdlWntPrice.mul(10 ** 8),
      },
    });
    expect(ethers.utils.formatUnits(marketTokenPriceBefore, 30)).to.eq("1.6");

    // Price rose to $60/SOL, so ADL can be enabled
    const executeAdlSolPrice = expandDecimals(100, 4);
    const executeAdlWntPrice = expandDecimals(15000, 4);

    await executeAdl(fixture, {
      account: user0.address,
      market: solUsdMarket,
      collateralToken: wnt,
      isLong: true,
      sizeDeltaUsd: decimalToFloat(1000 * 1000),
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      minPrices: [executeAdlSolPrice, executeAdlWntPrice, expandDecimals(1, 6)],
      maxPrices: [executeAdlSolPrice, executeAdlWntPrice, expandDecimals(1, 6)],
      precisions: [8, 8, 18],
      gasUsageLabel: "executeAdl",
    });

    const marketTokenPriceAfter = await getMarketTokenPrice(fixture, {
      market: solUsdMarket,
      indexTokenPrice: {
        min: executeAdlSolPrice.mul(10 ** 8),
        max: executeAdlSolPrice.mul(10 ** 8),
      },
      longTokenPrice: {
        min: executeAdlWntPrice.mul(10 ** 8),
        max: executeAdlWntPrice.mul(10 ** 8),
      },
    });
    expect(ethers.utils.formatUnits(marketTokenPriceAfter, 30)).to.eq("1.45");

    // Value of market token price dropped, showcasing that tokens can still be acquired at
    // a cheaper price ("price of the market token decreasing below the allowed amount")
    // than the protocol may desire despite preventing deposits when MAX_PNL_FACTOR_FOR_DEPOSTS was exceeded
    expect(marketTokenPriceAfter.mul(110).div(100)).to.be.lessThan(marketTokenPriceBefore);

    expect(await getPoolAmount(dataStore, solUsdMarket.marketToken, wnt.address)).eq(ethers.utils.parseEther("750"));
    // Deposits can go through again after ADL
    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [executeAdlSolPrice, executeAdlWntPrice, expandDecimals(1, 6)], // Using same prices as ADL
        maxPrices: [executeAdlSolPrice, executeAdlWntPrice, expandDecimals(1, 6)],
      },
    });
    // Pool amount increases accurately
    expect(await getPoolAmount(dataStore, solUsdMarket.marketToken, wnt.address)).eq(ethers.utils.parseEther("1750"));
  });
});
