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

describe("Guardian.GSU-1", () => {
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

  it("CRITICAL: Swaps are not part of withdrawal gas estimation", async () => {
    // Exagerate single swap gas limit to showcase it is not being included in execution feeestimation
    await dataStore.setUint(keys.singleSwapGasLimitKey(), decimalToFloat(10_000_000));
    await dataStore.setUint(keys.withdrawalGasLimitKey(false), 10_000);
    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_MULTIPLIER_FACTOR, expandDecimals(1, 30));
    await dataStore.setUint(keys.ESTIMATED_GAS_FEE_BASE_AMOUNT, 10_000);

    const ethBalBeforeCreate = await ethers.provider.getBalance(wallet.address);

    const swapPath = Array(4)
      .fill(0)
      .map((x, index) => (index % 2 == 0 ? ethUsdMarket.marketToken : ethUsdSpotOnlyMarket.marketToken));
    const executionFee = ethers.utils.parseEther("0.0001");
    // Create a withdrawal with a swap path
    await createWithdrawal(fixture, {
      marketTokenAmount: await getBalanceOf(ethUsdMarket.marketToken, user0.address),
      longTokenSwapPath: swapPath,
      shortTokenSwapPath: swapPath,
      executionFee: executionFee,
    });
    expect(await getWithdrawalCount(dataStore)).to.eq(1);
    const ethBalAfterCreate = await ethers.provider.getBalance(wallet.address);

    // Keeper will get entire execution fee as refund because more gas was used
    // than expected.
    await executeWithdrawal(fixture, {});
    expect(await getWithdrawalCount(dataStore)).to.eq(0);
    const ethBalAfterExecute = await ethers.provider.getBalance(wallet.address);

    // This is the amount the user expended
    const gasUsedOnCreate = ethBalBeforeCreate.sub(ethBalAfterCreate);
    // This is the amount the keeper expended
    const gasUsedOnExecute = ethBalAfterCreate.sub(ethBalAfterExecute).add(executionFee);

    // The amount of gas the keeper expends on execution
    // is greater than the amount the user spent on creating a withdrawal by over 50%.
    // This amount will build over time and drain the treasury. Users do not have to be malicious
    // to carry out this drainage as it will happen with typical user functionality.
    expect(gasUsedOnExecute).to.be.greaterThan(gasUsedOnCreate.mul(50).div(100));
  });
});
