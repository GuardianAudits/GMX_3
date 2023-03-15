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

describe("Guardian.GLOBAL-2", () => {
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

  it("CRITICAL: Blacklisted addresses cannot be liquidated", async () => {
    const initialWNTBalance = expandDecimals(41, 17); // 4.1 ETH E.g. $20,500 of ETH
    // User1 is blacklisted for usdc
    await usdc.blacklist(user1.address);

    expect(usdc.connect(user1).transfer(user2.address, expandDecimals(10, 6))).to.be.revertedWithCustomError(
      usdc,
      "BlackListed"
    );

    // User 1 opens a short position
    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: wnt,
      initialCollateralDeltaAmount: initialWNTBalance,
      swapPath: [ethUsdMarket.marketToken], // User1 swaps to get usdc as their collateral
      sizeDeltaUsd: decimalToFloat(100 * 1000), // Position size of 20 ETH
      acceptablePrice: expandDecimals(4999, 12),
      orderType: OrderType.MarketIncrease,
      isLong: false,
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

    // User 1 cannot be liquidated unless their PnL losses become greater in magnitude than their collateral
    // since they are blacklisted for their collateral token and the liquidation will send it back to them

    // ETH increases to $6,000 => -$1,000 per ETH
    // PnL = -$20,000
    // Collateral left after PnL applied = $500
    // Making the position liquidatable because it is now 200x leverage
    await mine();

    await expect(
      executeLiquidation(fixture, {
        account: user1.address,
        market: ethUsdMarket,
        collateralToken: usdc,
        isLong: false,
        minPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(6000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "liquidationHandler.executeLiquidation",
      })
    ).to.be.revertedWithCustomError(tokenUtils, "TokenTransferError");

    // *Notice that blacklisted addresses can be used to levy a number of attacks on the exchange
    // Including a risk-free trade where a MarketIncrease order cannot be cancelled since it attempts to
    // Send blacklisted tokens back to the blacklisted address.
    // (An unblacklisted contract/EOA could have sent those tokens to the vault for the blacklisted address when creating the order)
  });
});
