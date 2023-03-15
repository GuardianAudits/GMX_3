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

describe("Guardian.ORDH-1", () => {
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

  it("HIGH: Gas refund does not include gas spent setting oracle prices", async () => {
    await dataStore.setUint(keys.singleSwapGasLimitKey(), 10_000);
    await dataStore.setUint(keys.depositGasLimitKey(false), 10_000);
    await dataStore.setUint(keys.depositGasLimitKey(true), 10_000);
    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR, expandDecimals(1, 30));
    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_BASE_AMOUNT, 10_000);

    const swapPath = [ethUsdMarket.marketToken, ethUsdSpotOnlyMarket.marketToken];
    const executionFee = ethers.utils.parseEther("0.00002000000016"); // Min execution fee to pass create
    // Create a deposit with a swap path
    await createDeposit(fixture, {
      longTokenAmount: expandDecimals(1000, 18),
      shortTokenAmount: expandDecimals(500_000, 6),
      longTokenSwapPath: swapPath,
      shortTokenSwapPath: swapPath,
      executionFee: executionFee,
    });
    // Trader was able to pass execution fee validation
    expect(await getDepositCount(dataStore)).to.eq(1);

    const ethBalBeforeExecute = await ethers.provider.getBalance(wallet.address);
    // Keeper will get entire execution fee as refund
    await executeDeposit(fixture, {});
    expect(await getWithdrawalCount(dataStore)).to.eq(0);
    const ethBalAfterExecute = await ethers.provider.getBalance(wallet.address);

    const gasUsedOnExecute = ethBalBeforeExecute.sub(ethBalAfterExecute).add(executionFee);

    // The amount of gas the keeper expends on execution is MUCH greater than the execution fee refund.
    // This is partially due to the fact that setting oracle prices isn't included
    // in gas expenditure estimation.

    // Gas keeper uses is over 50x greater than the execution fee user sent in!
    expect(gasUsedOnExecute).to.be.greaterThan(executionFee.mul(50));
  });
});
