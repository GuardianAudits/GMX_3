import hre from "hardhat";

import { expandDecimals } from "./math";
import { hashData } from "./hash";
import { getMarketTokenAddress } from "./market";
import { getSyntheticTokenAddress } from "./token";

export async function deployFixture() {
  await hre.deployments.fixture();
  const chainId = 31337; // hardhat chain id
  const accountList = await hre.ethers.getSigners();
  const [
    wallet,
    user0,
    user1,
    user2,
    user3,
    user4,
    user5,
    user6,
    user7,
    user8,
    signer0,
    signer1,
    signer2,
    signer3,
    signer4,
    signer5,
    signer6,
    signer7,
    signer8,
    signer9,
  ] = accountList;

  const wnt = await hre.ethers.getContract("WETH");
  const wntAccurate = await hre.ethers.getContract("AWETH");
  await wnt.deposit({ value: expandDecimals(50, 18) });

  const wbtc = await hre.ethers.getContract("WBTC");
  const usdc = await hre.ethers.getContract("USDC");
  const usdt = await hre.ethers.getContract("USDT");

  const usdcPriceFeed = await hre.ethers.getContract("USDCPriceFeed");
  await usdcPriceFeed.setAnswer(expandDecimals(1, 8));

  const usdtPriceFeed = await hre.ethers.getContract("USDTPriceFeed");
  await usdtPriceFeed.setAnswer(expandDecimals(1, 8));

  const oracleSalt = hashData(["uint256", "string"], [chainId, "xget-oracle-v1"]);

  const config = await hre.ethers.getContract("Config");
  const timelock = await hre.ethers.getContract("Timelock");
  const reader = await hre.ethers.getContract("Reader");
  const roleStore = await hre.ethers.getContract("RoleStore");
  const dataStore = await hre.ethers.getContract("DataStore");
  const depositVault = await hre.ethers.getContract("DepositVault");
  const withdrawalVault = await hre.ethers.getContract("WithdrawalVault");
  const eventEmitter = await hre.ethers.getContract("EventEmitter");
  const oracleStore = await hre.ethers.getContract("OracleStore");
  const orderVault = await hre.ethers.getContract("OrderVault");
  const marketFactory = await hre.ethers.getContract("MarketFactory");
  const depositHandler = await hre.ethers.getContract("DepositHandler");
  const withdrawalHandler = await hre.ethers.getContract("WithdrawalHandler");
  const orderHandler = await hre.ethers.getContract("OrderHandler");
  const liquidationHandler = await hre.ethers.getContract("LiquidationHandler");
  const adlHandler = await hre.ethers.getContract("AdlHandler");
  const router = await hre.ethers.getContract("Router");
  const exchangeRouter = await hre.ethers.getContract("ExchangeRouter");
  const oracle = await hre.ethers.getContract("Oracle");
  const marketStoreUtils = await hre.ethers.getContract("MarketStoreUtils");
  const depositStoreUtils = await hre.ethers.getContract("DepositStoreUtils");
  const withdrawalStoreUtils = await hre.ethers.getContract("WithdrawalStoreUtils");
  const positionStoreUtils = await hre.ethers.getContract("PositionStoreUtils");
  const orderStoreUtils = await hre.ethers.getContract("OrderStoreUtils");
  const decreasePositionUtils = await hre.ethers.getContract("DecreasePositionUtils");
  const marketUtils = await hre.ethers.getContract("MarketUtils");
  const withdrawalUtils = await hre.ethers.getContract("WithdrawalUtils");
  const attackContract = await hre.ethers.getContract("AttackContract");
  const gasGriefingRevertContract = await hre.ethers.getContract("GasGriefingRevertContract");
  const referralStorage = await hre.ethers.getContract("ReferralStorage");
  const baseOrderUtils = await hre.ethers.getContract("BaseOrderUtils");
  const oracleUtils = await hre.ethers.getContract("OracleUtils");
  const adlUtils = await hre.ethers.getContract("AdlUtils");
  const tokenUtils = await hre.ethers.getContract("TokenUtils");
  const positionUtils = await hre.ethers.getContract("PositionUtils");


  const ethUsdMarketAddress = getMarketTokenAddress(
    wnt.address,
    wnt.address,
    usdc.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const ethUsdMarket = await reader.getMarket(dataStore.address, ethUsdMarketAddress);

  const ethUsdtMarketAddress = getMarketTokenAddress(
    wnt.address,
    wnt.address,
    usdt.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const ethUsdtMarket = await reader.getMarket(dataStore.address, ethUsdtMarketAddress);

  const ethUsdSpotOnlyMarketAddress = getMarketTokenAddress(
    ethers.constants.AddressZero,
    wnt.address,
    usdc.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const ethUsdSpotOnlyMarket = await reader.getMarket(dataStore.address, ethUsdSpotOnlyMarketAddress);

  const solUsdMarketAddress = getMarketTokenAddress(
    getSyntheticTokenAddress("SOL"),
    wnt.address,
    usdc.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const solUsdMarket = await reader.getMarket(dataStore.address, solUsdMarketAddress);

  const ethUsdAccurateMarketAddress = getMarketTokenAddress(
    wntAccurate.address,
    wntAccurate.address,
    usdc.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address,
  );
  const ethUsdAccurateMarket = await reader.getMarket(dataStore.address, ethUsdAccurateMarketAddress);

  const ethEthMarketAddress = getMarketTokenAddress(
    wnt.address,
    wnt.address,
    wnt.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const ethEthMarket = await reader.getMarket(dataStore.address, ethEthMarketAddress);

  const solEthEthMarketAddress = getMarketTokenAddress(
    getSyntheticTokenAddress("SOL"),
    wnt.address,
    wnt.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const solEthEthMarket = await reader.getMarket(dataStore.address, solEthEthMarketAddress);

  const wbtcEthEthMarketAddress = getMarketTokenAddress(
    wbtc.address,
    wnt.address,
    wnt.address,
    marketFactory.address,
    roleStore.address,
    dataStore.address
  );
  const wbtcEthEthMarket = await reader.getMarket(dataStore.address, wbtcEthEthMarketAddress);

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

  return {
    accountList,
    accounts: {
      wallet,
      user0,
      user1,
      user2,
      user3,
      user4,
      user5,
      user6,
      user7,
      user8,
      signer0,
      signer1,
      signer2,
      signer3,
      signer4,
      signer5,
      signer6,
      signer7,
      signer8,
      signer9,
      signers: [signer0, signer1, signer2, signer3, signer4, signer5, signer6],
    },
    contracts: {
      config,
      timelock,
      reader,
      roleStore,
      dataStore,
      depositVault,
      eventEmitter,
      withdrawalVault,
      oracleStore,
      orderVault,
      marketFactory,
      depositHandler,
      withdrawalHandler,
      orderHandler,
      liquidationHandler,
      adlHandler,
      router,
      exchangeRouter,
      attackContract,
      gasGriefingRevertContract,
      oracle,
      marketStoreUtils,
      depositStoreUtils,
      withdrawalStoreUtils,
      positionStoreUtils,
      orderStoreUtils,
      decreasePositionUtils,
      usdcPriceFeed,
      wnt,
      wbtc,
      usdc,
      usdt,
      ethUsdMarket,
      ethUsdtMarket,
      ethUsdSpotOnlyMarket,
      solUsdMarket,
      ethEthMarket,
      solEthEthMarket,
      wbtcEthEthMarket,
      referralStorage,
      withdrawalUtils,
      baseOrderUtils,
      marketUtils,
      oracleUtils,
      positionUtils,
      tokenUtils,
      wntAccurate,
      ethUsdAccurateMarket,
      adlUtils
    },
    props: { oracleSalt, signerIndexes: [0, 1, 2, 3, 4, 5, 6], executionFee: "1000000000000000", prices: prices },

  };
}
