import { bigNumberify, expandDecimals } from "./math";
import { executeWithOracleParams } from "./exchange";
import { TOKEN_ORACLE_TYPES } from "./oracle";
import * as keys from "./keys";

export async function getIsAdlEnabled(dataStore, market, isLong) {
  return await dataStore.getBool(keys.isAdlEnabledKey(market, isLong));
}

export async function getLatestAdlBlock(dataStore, market, isLong) {
  return await dataStore.getUint(keys.latestAdlBlockKey(market, isLong));
}

export async function updateAdlState(fixture, overrides = {}) {
  const { adlHandler } = fixture.contracts;
  const { market, isLong, gasUsageLabel } = overrides;
  const { wnt, usdc } = fixture.contracts;
  const tokens = overrides.tokens || [wnt.address, usdc.address];
  const tokenOracleTypes = overrides.tokenOracleTypes || Array(tokens.length).fill(TOKEN_ORACLE_TYPES.DEFAULT);
  const precisions = overrides.precisions || [8, 18];
  const minPrices = overrides.minPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const maxPrices = overrides.maxPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const priceFeedTokens = overrides.priceFeedTokens || [];
  const block = await ethers.provider.getBlock();

  const params = {
    oracleBlockNumber: bigNumberify(block.number),
    tokens,
    tokenOracleTypes,
    precisions,
    minPrices,
    maxPrices,
    execute: async (key, oracleParams) => {
      return await adlHandler.updateAdlState(market.marketToken, isLong, oracleParams);
    },
    gasUsageLabel,
    priceFeedTokens,
  };

  await executeWithOracleParams(fixture, params);
}

export async function executeAdl(fixture, overrides = {}) {
  const { adlHandler } = fixture.contracts;
  const { account, market, collateralToken, isLong, sizeDeltaUsd, gasUsageLabel } = overrides;
  const { wnt, usdc } = fixture.contracts;
  const tokens = overrides.tokens || [wnt.address, usdc.address];
  const tokenOracleTypes = overrides.tokenOracleTypes || Array(tokens.length).fill(TOKEN_ORACLE_TYPES.DEFAULT);
  const precisions = overrides.precisions || [8, 18];
  const minPrices = overrides.minPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const maxPrices = overrides.maxPrices || [expandDecimals(5000, 4), expandDecimals(1, 6)];
  const priceFeedTokens = overrides.priceFeedTokens || [];
  const block = overrides.block || await ethers.provider.getBlock();
  

  const params = {
    oracleBlockNumber: bigNumberify(block.number),
    tokens,
    tokenOracleTypes,
    precisions,
    minPrices,
    maxPrices,
    execute: async (key, oracleParams) => {
      return await adlHandler.executeAdl(
        account,
        market.marketToken,
        collateralToken.address,
        isLong,
        sizeDeltaUsd,
        oracleParams
      );
    },
    gasUsageLabel,
    priceFeedTokens,
  };

  await executeWithOracleParams(fixture, params);
}
