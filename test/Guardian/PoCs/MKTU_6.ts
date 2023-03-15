import { expect } from "chai";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../../utils/market";
import { handleDeposit, getDepositCount } from "../../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, executeOrder, handleOrder } from "../../../utils/order";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../../utils/position";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as keys from "../../../utils/keys";
import { getWithdrawalCount, createWithdrawal, executeWithdrawal } from "../../../utils/withdrawal";
import { expectTokenBalanceIncrease, getBalanceOf, getSupplyOf } from "../../../utils/token";

describe("Guardian.MKTU-6", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2, user3;
  let reader,
    dataStore,
    oracle,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    wbtc,
    usdc,
    attackContract,
    exchangeRouter,
    eventEmitter,
    ethEthMarket,
    solEthEthMarket,
    wbtcEthEthMarket;
  let executionFee;
  beforeEach(async () => {
    fixture = await deployFixture();

    ({ user0, user1, user2, user3 } = fixture.accounts);
    ({
      reader,
      dataStore,
      oracle,
      depositVault,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      wbtc,
      usdc,
      attackContract,
      exchangeRouter,
      eventEmitter,
      ethEthMarket,
      solEthEthMarket,
      wbtcEthEthMarket,
    } = fixture.contracts);
    ({ executionFee } = fixture.props);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
        shortTokenAmount: expandDecimals(1000 * 5000, 6),
      },
    });
    await handleDeposit(fixture, {
      create: {
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10000000, 18),
        shortTokenAmount: expandDecimals(1000000 * 5000, 6),
      },
    });
  });

  it("HIGH: Rounding error leading to more claimable fees then being paid", async () => {
    await dataStore.setUint(keys.fundingFactorKey(ethUsdMarket.marketToken), decimalToFloat(1, 7));
    await dataStore.setUint(keys.fundingExponentFactorKey(ethUsdMarket.marketToken), decimalToFloat(1));

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await usdc.balanceOf(user0.address)).eq(0);
    expect(await usdc.balanceOf(user2.address)).eq(0);

    // Initial balance for users
    // User0
    const initialUser0USDCBalance = expandDecimals(50 * 1000, 6);

    // User2
    const initialUser2USDCBalance = expandDecimals(5 * 1000, 6);

    // Check that users have 0 claimable usdc funding fees
    // User0
    const user0InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user0.address)
    );
    expect(user0InitialClaimableAmount).to.eq("0");

    // User2
    const user2InitialClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2InitialClaimableAmount).to.eq("0");

    // User0 creates a long position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // $50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
    });

    // User2 creates a short position with short collateral
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketIncrease,
        isLong: false,
      },
    });

    // Check that both users created their positions
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(1);
    expect(await getPositionCount(dataStore)).to.eq(2);

    await time.increase(5 * 24 * 60 * 60); // 5 days

    const prices = {
      indexTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      longTokenPrice: {
        min: expandDecimals(5000, 12),
        max: expandDecimals(5000, 12),
      },
      shortTokenPrice: {
        min: expandDecimals(1, 24),
        max: expandDecimals(1, 24),
      },
    };

    const positionKeys = await getPositionKeys(dataStore, 0, 10);
    const user0Position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);

    // Total USDC funding fees paid by User0
    const totalUSDCFeesPaidByUser0 = await user0Position.pendingFundingFees.fundingFeeAmount;

    // User0 closes their position
    await handleOrder(fixture, {
      create: {
        account: user0,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(50 * 1000, 6), // 50,000
        sizeDeltaUsd: decimalToFloat(100 * 1000), // 2x position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: true,
      },
    });

    // User2 closes their position
    await handleOrder(fixture, {
      create: {
        account: user2,
        market: ethUsdMarket,
        initialCollateralToken: usdc,
        initialCollateralDeltaAmount: expandDecimals(5 * 1000, 6), // $5,000
        sizeDeltaUsd: decimalToFloat(10 * 1000), // 2x Position
        acceptablePrice: expandDecimals(5000, 12),
        orderType: OrderType.MarketDecrease,
        isLong: false,
      },
    });

    // Get User0 USDC balance
    const user0USDCBalance = await usdc.balanceOf(user0.address);

    // Check that the initial balance minus the funding fees is equal to the current balance
    expect(initialUser0USDCBalance.sub(totalUSDCFeesPaidByUser0)).to.eq(user0USDCBalance);

    // Check that all positions have been closed
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getAccountPositionCount(dataStore, user2.address)).eq(0);
    expect(await getPositionCount(dataStore)).to.eq(0);

    // Check the total funding fees paid by User0
    expect(totalUSDCFeesPaidByUser0).to.eq("3534500000");

    // Check the claimable funding fees for User2
    const user2ClaimableAmount = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmount).to.eq("3534560000");

    // Check that there is more claimable funding fees than getting paid
    expect(user2ClaimableAmount).to.gt(totalUSDCFeesPaidByUser0);

    // Check that User2 can claim their funding fees
    await expectTokenBalanceIncrease({
      token: usdc,
      account: user2,
      sendTxn: async () => {
        await exchangeRouter.connect(user2).claimFundingFees([ethUsdMarket.marketToken], [usdc.address], user2.address);
      },
      increaseAmount: "3534560000",
    });

    // Check that User2 has received the funding fees
    const user2USDCBalance = await usdc.balanceOf(user2.address);
    expect(initialUser2USDCBalance.add(user2ClaimableAmount)).eq(user2USDCBalance);

    // Check claimable funding fee amount is 0 after claiming
    const user2ClaimableAmountAfterReceived = await dataStore.getUint(
      keys.claimableFundingAmountKey(ethUsdMarket.marketToken, usdc.address, user2.address)
    );
    expect(user2ClaimableAmountAfterReceived).to.eq("0");

    // Check that amount the pool thinks it owns
    const poolUSDCAmount = await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address);
    expect(poolUSDCAmount).eq("5000000000000");

    // Check that amount the pool actually owns
    const actualPoolUSDCAmount = await usdc.balanceOf(ethUsdMarket.marketToken);
    expect(actualPoolUSDCAmount).to.eq("4999999940000");

    // The pool thinks it has more tokens than it actually does
    expect(poolUSDCAmount).to.gt(actualPoolUSDCAmount);

    // Get the total amount of market tokens
    const allMarketTokens = await getSupplyOf(ethUsdMarket.marketToken);
    expect(allMarketTokens).to.eq("10000000000000000000000000");

    // Get the difference
    const poolDiff = poolUSDCAmount.sub(actualPoolUSDCAmount);
    expect(poolDiff).to.eq("60000");

    // Check that User0 owns all of the market tokens
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(allMarketTokens);

    // User0 creates a withdrawal for all the market tokens they own
    await createWithdrawal(fixture, {
      account: user0,
      market: ethUsdMarket,
      marketTokenAmount: allMarketTokens,
    });

    // Check that the order have been created
    expect(await getWithdrawalCount(dataStore)).eq(1);

    // User0 will not be able to withdraw all of their funds because the accounting is off,
    // User0 will try to withdraw more funds than the pool has leading to the execution reverting with TokenTransferError and the withdrawal getting canceled
    await executeWithdrawal(fixture);

    // Check that the withdrawal has been canceled
    expect(await getWithdrawalCount(dataStore)).eq(0);

    // Check that User0 still owns all of the market tokens
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(allMarketTokens);
  });
});
