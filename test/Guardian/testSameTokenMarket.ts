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
import { getSyntheticTokenAddress } from "../../utils/token";

describe("Guardian.Deposit", () => {
  const { provider } = ethers;

  let fixture;
  let user0, user1, user2;
  let reader,
    dataStore,
    oracle,
    depositVault,
    ethUsdMarket,
    ethUsdSpotOnlyMarket,
    wnt,
    wbtc,
    usdc,
    swapUtils,
    eventEmitter,
    ethEthMarket,
    solEthEthMarket,
    wbtcEthEthMarket;
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
      wbtc,
      usdc,
      usdcPriceFeed,
      swapUtils,
      eventEmitter,
      ethEthMarket,
      solEthEthMarket,
      wbtcEthEthMarket,
    } = fixture.contracts);
  });

  it("Long token == short token, deposit long token", async () => {
    // Check that long token and short token are the same
    expect(ethEthMarket.longToken).to.eq(ethEthMarket.shortToken);

    // User1 creates a deposit for $500,000 worth of long tokens
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethEthMarket,
        longTokenAmount: expandDecimals(100, 18), // $500,000
      },
      execute: {
        tokens: [wnt.address],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8],
        minPrices: [expandDecimals(5000, 4)],
        maxPrices: [expandDecimals(5000, 4)],
      },
    });

    // Check that User1 have $500,000 worth of market tokens
    expect(await getBalanceOf(ethEthMarket.marketToken, user1.address)).eq(expandDecimals(500000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethEthMarket.marketToken, wnt.address)).eq(expandDecimals(100, 18));
  });

  it("Long token == short token, deposit short token", async () => {
    // Check that long token and short token are the same
    expect(ethEthMarket.longToken).to.eq(ethEthMarket.shortToken);

    // User1 creates a deposit for $500,000 worth of short tokens
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethEthMarket,
        shortTokenAmount: expandDecimals(100, 18), // $500,000
      },
      execute: {
        tokens: [wnt.address],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8],
        minPrices: [expandDecimals(5000, 4)],
        maxPrices: [expandDecimals(5000, 4)],
      },
    });

    // Check that User1 have $500,000 worth of market tokens
    expect(await getBalanceOf(ethEthMarket.marketToken, user1.address)).eq(expandDecimals(500000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethEthMarket.marketToken, wnt.address)).eq(expandDecimals(100, 18));
  });

  it("Long token == short token, deposit short tokens and long tokens", async () => {
    // Check that long token and short token are the same
    expect(ethEthMarket.longToken).to.eq(ethEthMarket.shortToken);

    // User1 creates a deposit for $250,000 worth of long tokens and $250,000 worth of short tokens
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethEthMarket,
        longTokenAmount: expandDecimals(50, 18), // $250,000
        shortTokenAmount: expandDecimals(50, 18), // $250,000
      },
      execute: {
        tokens: [wnt.address],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8],
        minPrices: [expandDecimals(5000, 4)],
        maxPrices: [expandDecimals(5000, 4)],
      },
    });

    // Check that User1 have $500,000 worth of market token
    expect(await getBalanceOf(ethEthMarket.marketToken, user1.address)).eq(expandDecimals(500000, 18));

    // Check the pool received the deposited amount
    expect(await getPoolAmount(dataStore, ethEthMarket.marketToken, wnt.address)).eq(expandDecimals(100, 18));

    // Check that User0's deposit got executed and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });
});
