// SPDX-License-Identifier: BUSL-1.1

pragma solidity ^0.8.0;

import "../data/DataStore.sol";
import "../event/EventEmitter.sol";

import "../order/OrderStoreUtils.sol";
import "../order/OrderEventUtils.sol";
import "../position/PositionUtils.sol";
import "../position/PositionStoreUtils.sol";
import "../nonce/NonceUtils.sol";

// @title AdlUtils
// @dev Library to help with auto-deleveraging
// This is particularly for markets with an index token that is different from
// the long token
//
// For example, if there is a DOGE / USD perp market with ETH as the long token
// it would be possible for the price of DOGE to increase faster than the price of
// ETH
//
// In this scenario, profitable positions should be automatically closed to ensure
// that the system remains fully solvent
library AdlUtils {
    using SafeCast for int256;
    using Array for uint256[];
    using Market for Market.Props;
    using Position for Position.Props;

    using EventUtils for EventUtils.AddressItems;
    using EventUtils for EventUtils.UintItems;
    using EventUtils for EventUtils.IntItems;
    using EventUtils for EventUtils.BoolItems;
    using EventUtils for EventUtils.Bytes32Items;
    using EventUtils for EventUtils.BytesItems;
    using EventUtils for EventUtils.StringItems;

    // @dev CreateAdlOrderParams struct used in createAdlOrder to avoid stack
    // too deep errors
    //
    // @param dataStore DataStore
    // @param orderStore OrderStore
    // @param account the account to reduce the position for
    // @param market the position's market
    // @param collateralToken the position's collateralToken
    // @param isLong whether the position is long or short
    // @param sizeDeltaUsd the size to reduce the position by
    // @param updatedAtBlock the block to set the order's updatedAtBlock to
    struct CreateAdlOrderParams {
        DataStore dataStore;
        EventEmitter eventEmitter;
        address account;
        address market;
        address collateralToken;
        bool isLong;
        uint256 sizeDeltaUsd;
        uint256 updatedAtBlock;
    }

    error InvalidSizeDeltaForAdl(uint256 sizeDeltaUsd, uint256 positionSizeInUsd);
    error AdlNotEnabled();

    // @dev Multiple positions may need to be reduced to ensure that the pending
    // profits does not exceed the allowed thresholds
    //
    // This automatic reduction of positions can only be done if the pool is in a state
    // where auto-deleveraging is required
    //
    // This function checks the pending profit state and updates an isAdlEnabled
    // flag to avoid having to repeatedly validate whether auto-deleveraging is required
    //
    // Once the pending profit has been reduced below the threshold this function can
    // be called again to clear the flag
    //
    // The ADL check would be possible to do in AdlHandler.executeAdl as well
    // but with that order keepers could use stale oracle prices to prove that
    // an ADL state is possible
    //
    // Having this function allows any order keeper to disable ADL if prices
    // have updated such that ADL is no longer needed
    //
    // @param dataStore DataStore
    // @param eventEmitter EventEmitter
    // @param oracle Oracle
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    // @param maxOracleBlockNumbers the oracle block numbers for the prices stored in the oracle
    function updateAdlState(
        DataStore dataStore,
        EventEmitter eventEmitter,
        Oracle oracle,
        address market,
        bool isLong,
        uint256[] memory maxOracleBlockNumbers
    ) external {
        uint256 latestAdlBlock = getLatestAdlBlock(dataStore, market, isLong);

        if (!maxOracleBlockNumbers.areGreaterThanOrEqualTo(latestAdlBlock)) {
            OracleUtils.revertOracleBlockNumbersAreSmallerThanRequired(maxOracleBlockNumbers, latestAdlBlock);
        }

        Market.Props memory _market = MarketUtils.getEnabledMarket(dataStore, market);
        MarketUtils.MarketPrices memory prices = MarketUtils.getMarketPrices(oracle, _market);
        (bool shouldEnableAdl, int256 pnlToPoolFactor, uint256 maxPnlFactor) = MarketUtils.isPnlFactorExceeded(
            dataStore,
            _market,
            prices,
            isLong,
            Keys.MAX_PNL_FACTOR
        );

        setIsAdlEnabled(dataStore, market, isLong, shouldEnableAdl);
        setLatestAdlBlock(dataStore, market, isLong, block.number);

        emitAdlStateUpdated(eventEmitter, market, isLong, pnlToPoolFactor, maxPnlFactor, shouldEnableAdl);
    }

    // @dev Construct an ADL order
    //
    // A decrease order is used to reduce a profitable position
    //
    // @param params CreateAdlOrderParams
    // @return the key of the created order
    function createAdlOrder(CreateAdlOrderParams memory params) external returns (bytes32) {
        bytes32 positionKey = PositionUtils.getPositionKey(params.account, params.market, params.collateralToken, params.isLong);
        Position.Props memory position = PositionStoreUtils.get(params.dataStore, positionKey);

        if (params.sizeDeltaUsd > position.sizeInUsd()) {
            revert InvalidSizeDeltaForAdl(params.sizeDeltaUsd, position.sizeInUsd());
        }

        Order.Addresses memory addresses = Order.Addresses(
            params.account, // account
            params.account, // receiver
            address(0), // callbackContract
            params.market, // market
            position.collateralToken(), // initialCollateralToken
            new address[](0) // swapPath
        );

        Order.Numbers memory numbers = Order.Numbers(
            Order.OrderType.MarketDecrease, // orderType
            Order.DecreasePositionSwapType.NoSwap, // decreasePositionSwapType
            params.sizeDeltaUsd, // sizeDeltaUsd
            0, // initialCollateralDeltaAmount
            0, // triggerPrice
            position.isLong() ? 0 : type(uint256).max, // acceptablePrice
            0, // executionFee
            0, // callbackGasLimit
            0, // minOutputAmount
            params.updatedAtBlock // updatedAtBlock
        );

        Order.Flags memory flags = Order.Flags(
            position.isLong(), // isLong
            true, // shouldUnwrapNativeToken
            false // isFrozen
        );

        Order.Props memory order = Order.Props(
            addresses,
            numbers,
            flags
        );

        bytes32 key = NonceUtils.getNextKey(params.dataStore);
        OrderStoreUtils.set(params.dataStore, key, order);

        OrderEventUtils.emitOrderCreated(params.eventEmitter, key, order);

        return key;
    }

    // @dev validate if the requested ADL can be executed
    //
    // @param dataStore DataStore
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    // @param maxOracleBlockNumbers the oracle block numbers for the prices stored in the oracle
    function validateAdl(
        DataStore dataStore,
        address market,
        bool isLong,
        uint256[] memory maxOracleBlockNumbers
    ) external view {
        bool isAdlEnabled = AdlUtils.getIsAdlEnabled(dataStore, market, isLong);
        if (!isAdlEnabled) {
            revert AdlNotEnabled();
        }

        uint256 latestAdlBlock = AdlUtils.getLatestAdlBlock(dataStore, market, isLong);
        if (!maxOracleBlockNumbers.areGreaterThanOrEqualTo(latestAdlBlock)) {
            OracleUtils.revertOracleBlockNumbersAreSmallerThanRequired(maxOracleBlockNumbers, latestAdlBlock);
        }
    }

    // @dev get the latest block at which the ADL flag was updated
    //
    // @param dataStore DataStore
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    //
    // @return the latest block at which the ADL flag was updated
    function getLatestAdlBlock(DataStore dataStore, address market, bool isLong) internal view returns (uint256) {
        return dataStore.getUint(Keys.latestAdlBlockKey(market, isLong));
    }

    // @dev set the latest block at which the ADL flag was updated
    //
    // @param dataStore DataStore
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    // @param value the latest block value
    //
    // @return the latest block value
    function setLatestAdlBlock(DataStore dataStore, address market, bool isLong, uint256 value) internal returns (uint256) {
        return dataStore.setUint(Keys.latestAdlBlockKey(market, isLong), value);
    }

    // @dev get whether ADL is enabled
    //
    // @param dataStore DataStore
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    //
    // @return whether ADL is enabled
    function getIsAdlEnabled(DataStore dataStore, address market, bool isLong) internal view returns (bool) {
        return dataStore.getBool(Keys.isAdlEnabledKey(market, isLong));
    }

    // @dev set whether ADL is enabled
    //
    // @param dataStore DataStore
    // @param market address of the market to check
    // @param isLong indicates whether to check the long or short side of the market
    // @param value whether ADL is enabled
    //
    // @return whether ADL is enabled
    function setIsAdlEnabled(DataStore dataStore, address market, bool isLong, bool value) internal returns (bool) {
        return dataStore.setBool(Keys.isAdlEnabledKey(market, isLong), value);
    }

    function emitAdlStateUpdated(
        EventEmitter eventEmitter,
        address market,
        bool isLong,
        int256 pnlToPoolFactor,
        uint256 maxPnlFactor,
        bool shouldEnableAdl
    ) internal {
        EventUtils.EventLogData memory eventData;

        eventData.intItems.initItems(1);
        eventData.intItems.setItem(0, "pnlToPoolFactor", pnlToPoolFactor);

        eventData.uintItems.initItems(1);
        eventData.uintItems.setItem(0, "maxPnlFactor", maxPnlFactor);

        eventData.boolItems.initItems(2);
        eventData.boolItems.setItem(0, "isLong", isLong);
        eventData.boolItems.setItem(1, "shouldEnableAdl", shouldEnableAdl);

        eventEmitter.emitEventLog1(
            "AdlStateUpdated",
            Cast.toBytes32(market),
            eventData
        );
    }
}
