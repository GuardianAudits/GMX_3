import { expect } from "chai";

import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getPoolAmount, getSwapImpactPoolAmount, getMarketTokenPrice } from "../../../utils/market";
import { handleDeposit, getDepositCount } from "../../../utils/deposit";
import { OrderType, getOrderCount, getOrderKeys, createOrder, executeOrder, handleOrder } from "../../../utils/order";
import { getPositionCount, getAccountPositionCount, getPositionKeys } from "../../../utils/position";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as keys from "../../../utils/keys";
import { TOKEN_ORACLE_TYPES } from "../../../utils/oracle";
import { getBalanceOf, getSyntheticTokenAddress } from "../../../utils/token";

describe("Guardian.EDPU-1", () => {
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

  it("CRITICAL: Users are unable to provide a swap path when short token == long token", async () => {
    const solAddr = getSyntheticTokenAddress("SOL");

    // Check that long token and short token are the same
    expect(ethEthMarket.longToken).to.eq(ethEthMarket.shortToken);

    // User2 adds liquidity
    await handleDeposit(fixture, {
      create: {
        account: user2,
        market: ethEthMarket,
        longTokenAmount: expandDecimals(1000, 18), // $5,000,000
        shortTokenAmount: expandDecimals(1000, 18), // $5,000,000
      },
      execute: {
        tokens: [wnt.address],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8],
        minPrices: [expandDecimals(5000, 4)],
        maxPrices: [expandDecimals(5000, 4)],
      },
    });

    // User1 creates a deposit for $500,000 worth of long token and provides a swap path
    await handleDeposit(fixture, {
      create: {
        account: user1,
        market: ethEthMarket,
        initialLongToken: ethEthMarket.longToken,
        longTokenAmount: expandDecimals(100, 18), // $500,000
        longTokenSwapPath: [ethEthMarket.marketToken, solEthEthMarket.marketToken, wbtcEthEthMarket.marketToken],
      },
      execute: {
        tokens: [wnt.address, wbtc.address, solAddr],
        tokenOracleTypes: [TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT, TOKEN_ORACLE_TYPES.DEFAULT],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(5000, 4), expandDecimals(60000, 4), expandDecimals(100, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(60000, 4), expandDecimals(100, 6)],
      },
    });

    // User1 will not be able to deposit because getAdjustedLongAndShortTokenAmounts reverts due to
    // adjustedLongTokenAmount underflowing. User1's deposit will get canceled.

    // Check that User1 didn't receive any market tokens
    expect(await getBalanceOf(ethEthMarket.marketToken, user1.address)).eq(0);

    // Check the pool hasn't received anything
    expect(await getPoolAmount(dataStore, ethEthMarket.marketToken, wnt.address)).eq(expandDecimals(2000, 18));

    // Check that User0's deposit got canceled and there is 0 deposits waiting to get executed
    expect(await getDepositCount(dataStore)).eq(0);
  });
});
