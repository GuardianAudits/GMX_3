import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, getOrderCount, handleOrder } from "../../utils/order";
import { getAccountPositionCount, getPositionKeys } from "../../utils/position";
import * as keys from "../../utils/keys";
import { ethers } from "hardhat";
import { getBalanceOf } from "../../utils/token";

describe("Guardian.Referrals", () => {
  let fixture;
  let user0, user1;
  let dataStore, ethUsdMarket, wnt, usdc, referralStorage, reader, prices, exchangeRouter;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ user0, user1 } = fixture.accounts);
    ({ prices } = fixture.props);
    ({ dataStore, ethUsdMarket, wnt, usdc, referralStorage, reader, exchangeRouter } = fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
    });
  });

  it("Increment referral reward and claim", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%
    await referralStorage.setTier(0, 5000, 1000); // 50% rebate, 10% discount
    await referralStorage.connect(user1).registerCode(ethers.utils.formatBytes32String("code123"));
    await referralStorage.connect(user0).setTraderReferralCodeByUser(ethers.utils.formatBytes32String("code123"));

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    // Ensure referral rewards were properly incremented
    let user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    const positionKeys = await getPositionKeys(dataStore, 0, 1);
    let position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    // Position fee amount: ($200,000 / $5,000) * 0.10 = 4 ETH
    // Rebate amount: 4 ETH * 0.5 = 2 ETH
    // Discount amount: 2 ETH * 0.1 = 0.2 ETH
    // Affiliate reward amount = 2 ETH - 0.2 ETH = 1.8 ETH
    expect(user1Rewards).to.eq(ethers.utils.parseEther("1.8"));
    // 10 ETH - 4 ETH position fee + 0.2 ETH Discount Amount
    expect(position.position.numbers.collateralAmount).to.eq(ethers.utils.parseEther("6.2"));

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getOrderCount(dataStore)).eq(0);
    // Another 3.8 ETH lost
    // 6.2 ETH - 3.8 ETH = 2.4 ETH
    expect(await getBalanceOf(wnt.address, user0.address)).to.eq(ethers.utils.parseEther("2.4"));

    // Ensure affiliate rewards are accurate
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    // Affiliate reward doubled
    expect(user1Rewards).to.eq(ethers.utils.parseEther("3.6"));

    // Claim Rewards
    await exchangeRouter.connect(user1).claimAffiliateRewards([ethUsdMarket.marketToken], [wnt.address], user1.address);
    // Ensure affiliate reward is reset after claim
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    expect(user1Rewards).to.eq(0);
    expect(await getBalanceOf(wnt.address, user1.address)).to.eq(ethers.utils.parseEther("3.6"));
  });

  it("Update referral tier between orders for affiliate", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%
    await referralStorage.setTier(0, 5000, 1000); // 50% rebate, 10% discount
    await referralStorage.connect(user1).registerCode(ethers.utils.formatBytes32String("code123"));
    await referralStorage.connect(user0).setTraderReferralCodeByUser(ethers.utils.formatBytes32String("code123"));

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    // Ensure referral rewards were properly incremented
    let user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    const positionKeys = await getPositionKeys(dataStore, 0, 1);
    let position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    // Position fee amount: ($200,000 / $5,000) * 0.10 = 4 ETH
    // Rebate amount: 4 ETH * 0.5 = 2 ETH
    // Discount amount: 2 ETH * 0.1 = 0.2 ETH
    // Affiliate reward amount = 2 ETH - 0.2 ETH = 1.8 ETH
    expect(user1Rewards).to.eq(ethers.utils.parseEther("1.8"));
    // 10 ETH - 4 ETH position fee + 0.2 ETH Discount Amount
    expect(position.position.numbers.collateralAmount).to.eq(ethers.utils.parseEther("6.2"));

    // Now Governance can update the tier
    await referralStorage.setTier(0, 5000, 5000); // 50% rebate, 50% discount

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getOrderCount(dataStore)).eq(0);
    // 6.2 ETH - 4 ETH (position fee) + 1 ETH (discount) = 3.2 ETH
    expect(await getBalanceOf(wnt.address, user0.address)).to.eq(ethers.utils.parseEther("3.2"));

    // Ensure affiliate rewards are accurate
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    // Affiliate reward increases by 1 ETH
    // 2 ETH (rebate amount) - 1 ETH (trader discount)
    expect(user1Rewards).to.eq(ethers.utils.parseEther("2.8"));

    // Claim Rewards
    await exchangeRouter.connect(user1).claimAffiliateRewards([ethUsdMarket.marketToken], [wnt.address], user1.address);
    // Ensure affiliate reward is reset after claim
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    expect(user1Rewards).to.eq(0);
    expect(await getBalanceOf(wnt.address, user1.address)).to.eq(ethers.utils.parseEther("2.8"));
  });

  it("Update referral code between orders", async () => {
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    await dataStore.setUint(keys.positionFeeFactorKey(ethUsdMarket.marketToken), expandDecimals(1, 29)); // 10%
    await referralStorage.setTier(0, 5000, 1000); // 50% rebate, 10% discount
    await referralStorage.connect(user1).registerCode(ethers.utils.formatBytes32String("code123"));
    await referralStorage.connect(user0).setTraderReferralCodeByUser(ethers.utils.formatBytes32String("code123"));

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(10, 18),
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    expect(await getOrderCount(dataStore)).eq(0);

    // Ensure referral rewards were properly incremented
    let user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    const positionKeys = await getPositionKeys(dataStore, 0, 1);
    let position = await reader.getPositionInfo(dataStore.address, positionKeys[0], prices);
    // Position fee amount: ($200,000 / $5,000) * 0.10 = 4 ETH
    // Rebate amount: 4 ETH * 0.5 = 2 ETH
    // Discount amount: 2 ETH * 0.1 = 0.2 ETH
    // Affiliate reward amount = 2 ETH - 0.2 ETH = 1.8 ETH
    expect(user1Rewards).to.eq(ethers.utils.parseEther("1.8"));
    // 10 ETH - 4 ETH position fee + 0.2 ETH Discount Amount
    expect(position.position.numbers.collateralAmount).to.eq(ethers.utils.parseEther("6.2"));

    // Set referral code to a non-registered one. As a result, trader will experience entire position fee.
    await referralStorage.connect(user0).setTraderReferralCodeByUser(ethers.utils.formatBytes32String("unregistered"));

    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: 0,
        sizeDeltaUsd: decimalToFloat(200 * 1000),
        acceptablePrice: 0,
        orderType: OrderType.MarketDecrease,
        isLong: true,
        gasUsageLabel: "orderHandler.createOrder",
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        prices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "orderHandler.executeOrder",
      },
    });

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
    expect(await getOrderCount(dataStore)).eq(0);
    // 6.2 ETH - 4 ETH (position fee) + 0.2 ETH (trader discount)
    expect(await getBalanceOf(wnt.address, user0.address)).to.eq(ethers.utils.parseEther("2.4"));

    // Ensure affiliate rewards are accurate
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    // Affiliate reward does not increase for user1
    expect(user1Rewards).to.eq(ethers.utils.parseEther("1.8"));
    // 1.8 ETH gets sent to zero address
    const burnedRewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, ethers.constants.AddressZero)
    );
    expect(burnedRewards).to.eq(ethers.utils.parseEther("1.8"));

    // Claim Rewards
    await exchangeRouter.connect(user1).claimAffiliateRewards([ethUsdMarket.marketToken], [wnt.address], user1.address);
    // Ensure affiliate reward is reset after claim
    user1Rewards = await dataStore.getUint(
      keys.affiliateRewardKey(ethUsdMarket.marketToken, wnt.address, user1.address)
    );
    expect(user1Rewards).to.eq(0);
    expect(await getBalanceOf(wnt.address, user1.address)).to.eq(ethers.utils.parseEther("1.8"));
  });
});
