import { expect } from "chai";
import { deployFixture } from "../../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../../utils/math";
import { getSyntheticTokenAddress, getSupplyOf } from "../../../utils/token";
import { handleDeposit } from "../../../utils/deposit";
import * as keys from "../../../utils/keys";
import { grantRole } from "../../../utils/role";
import { getPoolAmount, getMarketTokenPrice } from "../../../utils/market";

describe("Guardian.GLOBAL-1", () => {
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
    ethEthMarket,
    tokenUtils,
    wntAccurate,
    ethUsdAccurateMarket,
    marketUtils,
    solUsdMarket;
  let roleStore, decreasePositionUtils, executionFee, prices;
  let eventEmitter;

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
      ethEthMarket,
      eventEmitter,
      wntAccurate,
      ethUsdAccurateMarket,
      solUsdMarket,
    } = fixture.contracts);

    await grantRole(roleStore, wallet.address, "LIQUIDATION_KEEPER");
    solAddr = getSyntheticTokenAddress("SOL");
  });

  it("CRITICAL: Markets that have the same long & short backing token double count poolValue", async () => {
    const wntPrice = {
      min: expandDecimals(5000, 4 + 8),
      max: expandDecimals(5000, 4 + 8),
    };

    const pnlFactorType = keys.MAX_PNL_FACTOR_FOR_TRADERS;

    // Pool value is initially 0
    let poolValue = await reader.getPoolValue(
      dataStore.address,
      ethEthMarket.marketToken,
      wntPrice,
      wntPrice,
      wntPrice,
      pnlFactorType,
      false
    );

    expect(poolValue).to.eq(0);

    // User deposits in a market where the long & short token are the same
    const initalWNTBalance = expandDecimals(10, 18); // 10 ETH deposit

    await handleDeposit(fixture, {
      create: {
        market: ethEthMarket,
        longTokenAmount: initalWNTBalance,
      },
    });

    // The pool now has 10 ETH
    const wntBalPool = await getPoolAmount(dataStore, ethEthMarket.marketToken, wnt.address);
    expect(wntBalPool).to.eq(initalWNTBalance);

    // The pool's 10 ETH should be worth roughly $50,000
    const expectedPoolValue = wntBalPool.mul(wntPrice.max);
    expect(expectedPoolValue).to.eq(decimalToFloat(50_000));

    poolValue = await reader.getPoolValue(
      dataStore.address,
      ethEthMarket.marketToken,
      wntPrice,
      wntPrice,
      wntPrice,
      pnlFactorType,
      false
    );

    // Instead the pool value is twice the expected amount, since we are double counting
    // the WNT amount for the short side as well as the long side.
    expect(poolValue).to.eq(expectedPoolValue.mul(2));
  });
});
