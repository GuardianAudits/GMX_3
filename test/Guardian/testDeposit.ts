import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { getBalanceOf } from "../../utils/token";
import { getClaimableFeeAmount } from "../../utils/fee";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../utils/market";
import { getDepositCount, getDepositKeys, createDeposit, executeDeposit, handleDeposit } from "../../utils/deposit";
import * as keys from "../../utils/keys";
import { TOKEN_ORACLE_TYPES } from "../../utils/oracle";
import { data } from "../../typechain-types/contracts";
import {
  getWithdrawalCount,
  getWithdrawalKeys,
  createWithdrawal,
  executeWithdrawal,
  handleWithdrawal,
} from "../../utils/withdrawal";

describe("Guardian.Deposit", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2;
  let reader, dataStore, oracle, depositVault, ethUsdMarket, ethUsdSpotOnlyMarket, wnt, usdc, swapUtils, eventEmitter;
  let usdcPriceFeed;

  beforeEach(async () => {
    fixture = await deployFixture();

    ({ user0, user1, user2 } = fixture.accounts);
    ({
      reader,
      dataStore,
      oracle,
      depositVault,
      ethUsdMarket,
      ethUsdSpotOnlyMarket,
      wnt,
      usdc,
      usdcPriceFeed,
      swapUtils,
      eventEmitter,
    } = fixture.contracts);
  });

  it("Deposit long token", async () => {
    // User0 creates a deposit for $50,000 worth of long token
    await createDeposit(fixture, {
      account: user0,
      receiver: user0,
      market: ethUsdMarket,
      longTokenAmount: expandDecimals(10, 18), // $50,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user0.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User1 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user0.address)).eq(expandDecimals(50000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18));
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(0);

    // Check that User0's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit short token", async () => {
    // User1 creates a deposit for $50,000 worth of short token
    await createDeposit(fixture, {
      account: user1,
      receiver: user1,
      market: ethUsdMarket,
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user1.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User1 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user1.address)).eq(expandDecimals(50000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(0);
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6));

    // Check that User1's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit both long and short token", async () => {
    // User2 creates a deposit for $25,000 worth of long token and $25,000 worth of short token
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      longTokenAmount: expandDecimals(5, 18), // $25,000
      shortTokenAmount: expandDecimals(25 * 1000, 6), // $25,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(5, 18));
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(25 * 1000, 6));

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit long token with swap path", async () => {
    // User0 adds liquidity for both tokens in both pools
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });

    // Check the pools before the deposit
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6)); // $50,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // User2 creates a deposit for $50,000 worth of long token and provides a long token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      initialLongToken: ethUsdMarket.longToken,
      longTokenAmount: expandDecimals(10, 18), // $50,000
      longTokenSwapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(100 * 1000, 6)); // $100,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(20, 18)); // $100,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit short token with swap path", async () => {
    // User0 adds liquidity for both tokens in both pools
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });

    // Check the pools before the deposit
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6)); // $50,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // User2 creates a deposit for $50,000 worth of short token and provides a short token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      initialShortToken: ethUsdMarket.shortToken,
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      shortTokenSwapPath: [ethUsdMarket.marketToken, ethUsdSpotOnlyMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(0); // $0
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(150 * 1000, 6)); // $150,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(20, 18)); // $100,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit both long token and short token with a swap path for both", async () => {
    // User0 adds liquidity for both tokens in both pools
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });

    // Check the pools before the deposit
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6)); // $50,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // User2 creates a deposit for $25,000 worth of long token and $25,000 worth of short token with swap paths for both
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      // Short token
      initialShortToken: ethUsdMarket.shortToken,
      shortTokenAmount: expandDecimals(25 * 1000, 6), // $25,000
      shortTokenSwapPath: [ethUsdMarket.marketToken, ethUsdSpotOnlyMarket.marketToken],
      // Long token
      initialLongToken: ethUsdMarket.longToken,
      longTokenAmount: expandDecimals(5, 18), // $25,000
      longTokenSwapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(5, 18)); // $25,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(125 * 1000, 6)); // $125,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(20, 18)); // $100,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit both long token and short token with a swap path for long", async () => {
    // User0 adds liquidity for both tokens in both pools
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });

    // Check the pools before the deposit
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6)); // $50,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // User2 creates a deposit for $25,000 worth of long token and $25,000 worth of short token provides a long token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      // Short token
      initialShortToken: ethUsdMarket.shortToken,
      shortTokenAmount: expandDecimals(25 * 1000, 6), // $25,000
      // Long token
      initialLongToken: ethUsdMarket.longToken,
      longTokenAmount: expandDecimals(5, 18), // $25,000
      longTokenSwapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token}
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(100 * 1000, 6)); // $100,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(15, 18)); // $75,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(25 * 1000, 6)
    ); // $25,000

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit both long token and short token with a swap path for short", async () => {
    // User0 adds liquidity for both tokens in both pools
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdSpotOnlyMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });
    await handleDeposit(fixture, {
      create: {
        account: user0,
        receiver: user0,
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(10, 18), // $50,000
        shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      },
    });

    // Check the pools before the deposit
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(50 * 1000, 6)); // $50,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // User2 creates a deposit for $25,000 worth of long token and $25,000 worth of short token and provides a short token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      // Short token
      initialShortToken: ethUsdMarket.shortToken,
      shortTokenAmount: expandDecimals(25 * 1000, 6), // $25,000
      shortTokenSwapPath: [ethUsdMarket.marketToken, ethUsdSpotOnlyMarket.marketToken],
      // Long token
      initialLongToken: ethUsdMarket.longToken,
      longTokenAmount: expandDecimals(5, 18), // $25,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture);

    // Check that User2 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdMarket.marketToken, user2.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(expandDecimals(100 * 1000, 6)); // $100,000

    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(15, 18)); // $75,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(25 * 1000, 6)
    ); // $25,000

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit short token with price feed", async () => {
    await dataStore.setAddress(keys.priceFeedKey(usdc.address), usdcPriceFeed.address);

    // User1 creates a deposit for $50,000 worth of short token with price feed
    await createDeposit(fixture, {
      account: user1,
      market: ethUsdSpotOnlyMarket,
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user1.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture, {
      tokens: [wnt.address],
      tokenOracleTypes: [TOKEN_ORACLE_TYPES.ONE_PERCENT_PER_MINUTE],
      precisions: [8],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      priceFeedTokens: [usdc.address],
    });

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(0); // $0
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(50 * 1000, 6)
    ); // $50,000

    // Check that User1 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdSpotOnlyMarket.marketToken, user1.address)).eq(expandDecimals(50000, 18));

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit long token and short token with price feed", async () => {
    await dataStore.setAddress(keys.priceFeedKey(usdc.address), usdcPriceFeed.address);

    // User1 creates a deposit for $25,000 worth of long token and $25,000 worth of short token with price feed
    await createDeposit(fixture, {
      account: user1,
      market: ethUsdSpotOnlyMarket,
      longTokenAmount: expandDecimals(5, 18), // $25,000
      shortTokenAmount: expandDecimals(25 * 1000, 6), // $50,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user1.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture, {
      tokens: [wnt.address],
      tokenOracleTypes: [TOKEN_ORACLE_TYPES.ONE_PERCENT_PER_MINUTE],
      precisions: [8],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      priceFeedTokens: [usdc.address],
    });

    // Check that User1 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdSpotOnlyMarket.marketToken, user1.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(5, 18)); // $25,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(
      expandDecimals(25 * 1000, 6)
    ); // $25,000

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("Deposit long token with price feed", async () => {
    await dataStore.setAddress(keys.priceFeedKey(usdc.address), usdcPriceFeed.address);

    // User1 creates a deposit for $50,000 worth of long token
    await createDeposit(fixture, {
      account: user1,
      market: ethUsdSpotOnlyMarket,
      longTokenAmount: expandDecimals(10, 18), // $50,000
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user1.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute the deposit
    await executeDeposit(fixture, {
      tokens: [wnt.address],
      tokenOracleTypes: [TOKEN_ORACLE_TYPES.ONE_PERCENT_PER_MINUTE],
      precisions: [8],
      minPrices: [expandDecimals(5000, 4)],
      maxPrices: [expandDecimals(5000, 4)],
      priceFeedTokens: [usdc.address],
    });

    // Check that User1 have $50,000 worth of market token
    expect(await getBalanceOf(ethUsdSpotOnlyMarket.marketToken, user1.address)).eq(expandDecimals(50000, 18));

    // Check the pools received the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, wnt.address)).eq(expandDecimals(10, 18)); // $50,000
    expect(await getPoolAmount(dataStore, ethUsdSpotOnlyMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("insufficient pool value due to long token swap path", async () => {
    // User0 adds liquidity for 1 market
    await createDeposit(fixture, {
      account: user0,
      receiver: user0,
      market: ethUsdSpotOnlyMarket,
      longTokenAmount: expandDecimals(10, 18), // $50,000
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
    });
    await executeDeposit(fixture);

    // User2 creates a deposit for $50,000 worth of long token and provides a long token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      initialLongToken: ethUsdMarket.longToken,
      longTokenAmount: expandDecimals(10, 18), // $50,000
      longTokenSwapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute deposit will get cancelled due to insufficient pool value
    expect(await executeDeposit(fixture)).to.emit(eventEmitter, "emitDepositCancelled");

    // Check the pools didn't receive the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(0); // $0
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got cancelled and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });

  it("insufficient pool value due to short token swap path", async () => {
    // User0 adds liquidity for 1 market
    await createDeposit(fixture, {
      account: user0,
      receiver: user0,
      market: ethUsdSpotOnlyMarket,
      longTokenAmount: expandDecimals(10, 18), // $50,000
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
    });
    await executeDeposit(fixture);

    // User2 creates a deposit for $50,000 worth of short token and provides a short token swap path
    await createDeposit(fixture, {
      account: user2,
      receiver: user2,
      market: ethUsdMarket,
      initialShortToken: ethUsdMarket.shortToken,
      shortTokenAmount: expandDecimals(50 * 1000, 6), // $50,000
      shortTokenSwapPath: [ethUsdSpotOnlyMarket.marketToken, ethUsdMarket.marketToken],
    });

    const depositKeys = await getDepositKeys(dataStore, 0, 1);
    let deposit = await reader.getDeposit(dataStore.address, depositKeys[0]);

    // Check that 1 deposit has been created
    expect(deposit.addresses.account).eq(user2.address);
    expect(await getDepositCount(dataStore)).eq(1);

    // Execute deposit will get cancelled due to insufficient pool value
    expect(await executeDeposit(fixture)).to.emit(eventEmitter, "emitDepositCancelled");

    // Check the pools didn't receive the deposited amount
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, wnt.address)).eq(0); // $0
    expect(await getPoolAmount(dataStore, ethUsdMarket.marketToken, usdc.address)).eq(0); // $0

    // Check that User2's deposit got cancelled and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });
});
