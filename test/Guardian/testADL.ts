import { expect } from "chai";

import { deployFixture } from "../../utils/fixture";
import { expandDecimals, decimalToFloat } from "../../utils/math";
import { handleDeposit } from "../../utils/deposit";
import { OrderType, handleOrder } from "../../utils/order";
import { getIsAdlEnabled, updateAdlState, executeAdl } from "../../utils/adl";
import { grantRole } from "../../utils/role";
import * as keys from "../../utils/keys";
import { getAccountPositionCount, getPositionKeys } from "../../utils/position";

describe("Guardian.AdlOrder", () => {
  let fixture;
  let wallet, user0, prices;
  let roleStore, dataStore, ethUsdMarket, solUsdMarket, wnt, usdc, oracleUtils, adlHandler, adlUtils, reader;

  beforeEach(async () => {
    fixture = await deployFixture();
    ({ wallet, user0 } = fixture.accounts);
    ({ prices } = fixture.props);
    ({ roleStore, dataStore, ethUsdMarket, solUsdMarket, wnt, usdc, oracleUtils, adlHandler, adlUtils, reader } =
      fixture.contracts);

    await handleDeposit(fixture, {
      create: {
        market: ethUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
    });

    await handleDeposit(fixture, {
      create: {
        market: solUsdMarket,
        longTokenAmount: expandDecimals(1000, 18),
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });
  });

  it("ADL cannot execute if block numbers for price are before latestAdlBlock", async () => {
    await handleOrder(fixture, {
      create: {
        market: ethUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(100, 18),
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    const maxPnlFactorForAdlKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR_FOR_ADL, ethUsdMarket.marketToken, true);
    const minPnlFactorAfterAdlKey = keys.maxPnlFactorKey(keys.MIN_PNL_FACTOR_AFTER_ADL, ethUsdMarket.marketToken, true);

    await dataStore.setUint(maxPnlFactorForAdlKey, decimalToFloat(10, 2)); // 10%
    await dataStore.setUint(minPnlFactorAfterAdlKey, decimalToFloat(2, 2)); // 2%
    await grantRole(roleStore, wallet.address, "ADL_KEEPER");

    await updateAdlState(fixture, {
      market: ethUsdMarket,
      isLong: true,
      tokens: [wnt.address, usdc.address],
      minPrices: [expandDecimals(10000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(10000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });

    expect(await getIsAdlEnabled(dataStore, ethUsdMarket.marketToken, true)).eq(true);
    const currBlockNum = (await ethers.provider.getBlock()).number;
    console.log("Curr block num:", currBlockNum);
    const prevBlock = await ethers.provider.getBlock(currBlockNum - 1);
    await expect(
      executeAdl(fixture, {
        account: user0.address,
        market: ethUsdMarket,
        collateralToken: wnt,
        isLong: true,
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        tokens: [wnt.address, usdc.address],
        minPrices: [expandDecimals(10000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(10000, 4), expandDecimals(1, 6)],
        block: prevBlock,
        gasUsageLabel: "executeAdl",
      })
    ).to.be.revertedWithCustomError(oracleUtils, "OracleBlockNumbersAreSmallerThanRequired");
  });

  it("ADL cannot execute when PnL to pool ratio not exceeded", async () => {
    await handleOrder(fixture, {
      create: {
        market: solUsdMarket,
        initialCollateralToken: wnt,
        initialCollateralDeltaAmount: expandDecimals(100, 18),
        sizeDeltaUsd: decimalToFloat(2000 * 1000),
        acceptablePrice: expandDecimals(5001, 12),
        orderType: OrderType.MarketIncrease,
        isLong: true,
      },
      execute: {
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      },
    });

    const maxPnlFactorKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR, solUsdMarket.marketToken, true);
    const maxPnlFactorForAdlKey = keys.maxPnlFactorKey(keys.MAX_PNL_FACTOR_FOR_ADL, solUsdMarket.marketToken, true);
    const minPnlFactorAfterAdlKey = keys.maxPnlFactorKey(keys.MIN_PNL_FACTOR_AFTER_ADL, solUsdMarket.marketToken, true);

    await dataStore.setUint(maxPnlFactorKey, decimalToFloat(10, 2)); // 10%
    await dataStore.setUint(maxPnlFactorForAdlKey, decimalToFloat(10, 2)); // 10%
    await dataStore.setUint(minPnlFactorAfterAdlKey, decimalToFloat(2, 2)); // 2%
    await grantRole(roleStore, wallet.address, "ADL_KEEPER");

    // Price hasn't moved -- ADL will not get enabled
    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).be.false;

    await expect(
      executeAdl(fixture, {
        account: user0.address,
        market: solUsdMarket,
        collateralToken: wnt,
        isLong: true,
        sizeDeltaUsd: decimalToFloat(100 * 1000),
        tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
        precisions: [8, 8, 18],
        minPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        maxPrices: [expandDecimals(20, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
        gasUsageLabel: "executeAdl",
      })
    ).to.be.revertedWithCustomError(adlUtils, "AdlNotEnabled");

    // Price increases by 10% -- not enough to trigger ADL
    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(22, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(22, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).be.false;

    // Price increases by 25%
    // $5 per token for 100,000 tokens puts profit at $500,000 which is 10% of the pool value.
    // Not enough to trigger ADL -- on the border
    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(25, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(25, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).be.false;

    expect(await getAccountPositionCount(dataStore, user0.address)).eq(1);
    await updateAdlState(fixture, {
      market: solUsdMarket,
      isLong: true,
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(26, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(26, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "updateAdlState",
    });
    expect(await getIsAdlEnabled(dataStore, solUsdMarket.marketToken, true)).be.true;

    await executeAdl(fixture, {
      account: user0.address,
      market: solUsdMarket,
      collateralToken: wnt,
      isLong: true,
      sizeDeltaUsd: decimalToFloat(2000 * 1000),
      tokens: [solUsdMarket.indexToken, wnt.address, usdc.address],
      precisions: [8, 8, 18],
      minPrices: [expandDecimals(26, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      maxPrices: [expandDecimals(26, 4), expandDecimals(5000, 4), expandDecimals(1, 6)],
      gasUsageLabel: "executeAdl",
    });
    // Position is now closed
    expect(await getAccountPositionCount(dataStore, user0.address)).eq(0);
  });
});
