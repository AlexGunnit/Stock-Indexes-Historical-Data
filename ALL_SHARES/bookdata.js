// Name: bookdata.js
// Desc: Class to manage book data across markets
//
// Data is stored by venue/level and once all processed for a venue's update,
// the data is sorted into the correct display order.
//

/* Directives for JSLint */
/*global $ */

function BookData()
{
    // Constants
    this.BUY_SIDE = 1;
    this.SELL_SIDE = 2;

    // Maps to store the changed market data
    // Use an object with the key a json string of venue/level.
    // Don't use a map or vector, they won't work.
    this.buySide = {};
    this.sellSide = {};

    this.sortedBuy = [];
    this.sortedSell = [];

    // Events
    this.OnRedisplay = new MarketViewerNS.Event();

    // Set data from venue and level
    this.updateBook = function(level, side, qty, price, venue)
    {
        // Get the correct side
        var sideData = (side == this.BUY_SIDE) ? this.buySide : this.sellSide;

        // Create new data
        var newRow = this._createRow(price, qty, venue, level);

        // Set the data
        this._setSideData(sideData, newRow);
    }

    // Return the data
    // Get the values of the object as an array, and sort into correct display
    // order
    this.redisplay = function(callback, consolidated)
    {
        // Get values as sorted arrays
        this.sortedBuy  = this._sortValues(consolidated ? this._aggregate(this.buySide) : this.buySide, this._compareBuy);
        this.sortedSell = this._sortValues(consolidated ? this._aggregate(this.sellSide) : this.sellSide, this._compareSell);

        // Ensure only 10 levels in public view
        this.sortedBuy.length  = (consolidated && this.sortedBuy.length  > 5) ? 5 : this.sortedBuy.length;
        this.sortedSell.length = (consolidated && this.sortedSell.length > 5) ? 5 : this.sortedSell.length;

        // Recalculate VBBO
        this._calculateVBBO(this.buySide, this.sortedBuy);
        this._calculateVBBO(this.sellSide, this.sortedSell);

        // Ensure enough rows for the data
        var rows = (this.sortedBuy.length > this.sortedSell.length)
                 ? this.sortedBuy.length
                 : this.sortedSell.length;
        callback.resetWithCount(rows);

        // Display each side via callback
        this._redisplaySide(this.sortedBuy,  this.BUY_SIDE,  callback);
        this._redisplaySide(this.sortedSell, this.SELL_SIDE, callback);

        // Update to account for scroll-bars etc
        MarketViewerNS.Event.trigger(this, this.OnRedisplay);
    }

    this._aggregate = function(side)
    {
        const byPriceMap = {};

        // Create map keyed by price
        for (var key in side)
        {
            let value = side[key];

            // BUGZID:114236 - Ensure we round the price before doing the aggregation
            let roundedPrice = Converter.toFloat(value.price).toFixed(4);

            if (!byPriceMap[roundedPrice])
            {
                byPriceMap[roundedPrice] = value;

                // Ensure an integer
                let byPriceValue = byPriceMap[roundedPrice];
                byPriceValue.qty = parseInt(byPriceValue.qty)
            }
            else
            {
                let byPriceValue = byPriceMap[roundedPrice];

                byPriceValue.qty += parseInt(value.qty);
                byPriceValue.cumQty += value.cumQty;

                // Prefer aggregated key to ALP key in final aggregated data
                if (byPriceValue.venue == '')
                {
                    byPriceValue.key = value.key;
                }
            }
        }

        // Transpose back to key/value structure
        const result = {};
        for (var key in byPriceMap)
        {
            let byPriceValue = byPriceMap[key];
            byPriceValue.venue = '';
            result[byPriceValue.key] = byPriceValue;
        }

        return result;
    }

    this.resetData = function()
    {
        this.buySide = {};
        this.sellSide = {};
        this.sortedBuy = [];
        this.sortedSell = [];
    }

    this.getVwapUpdate = function(vwapName, qty)
    {
        // Calculate the vwaps
        var buyVwap  = this._calculateVwapForQty(qty, this.sortedBuy);
        var sellVwap = this._calculateVwapForQty(qty, this.sortedSell);

        // Return the data
        return {
            vwap      : vwapName,
            qty       : qty,
            buyQty    : buyVwap.qty,
            buyPrice  : buyVwap.price,
            buyLevel  : buyVwap.level,
            sellQty   : sellVwap.qty,
            sellPrice : sellVwap.price,
            sellLevel : sellVwap.level
        };
    }

    this.getVwapUpdateAsString = function(vwapName, qty)
    {
        var update = this.getVwapUpdate(vwapName, qty);

        return {
            vwap      : vwapName,
            qty       : '' + qty,
            buyQty    : '' + update.buyQty,
            buyPrice  : Number(update.buyPrice).toFixed(4),
            buyLevel  : update.buyLevel,
            sellQty   : '' + update.sellQty,
            sellPrice : Number(update.sellPrice).toFixed(4),
            sellLevel : update.sellLevel
        };
    }

    ////////////////////////////////////////////////////////////////////////////
    // Private

    // Set data for the side (or remove if zero)
    this._setSideData = function(sideData, newRow)
    {
        // Set new entry (or delete zero quantity
        // but keep zero price (mkt order) during an auction or the open cross)
        if (newRow.qty == 0)
        {
            delete sideData[newRow.key];
        }
        else
        {
            sideData[newRow.key] = newRow;
        }
    }

    // Create key data object for JSON
    this._createKeyData = function(venue, level)
    {
        var data = {};
        data[venue] = level;
        return data;
    }

    // Create row - what will be displayed
    this._createRow = function(price, qty, venue, level)
    {
        // Create key as JSON string
        var data = this._createKeyData(venue, level);
        var key = JSON.stringify(data);

        return { price  : price,
                 qty    : qty,
                 venue  : venue,
                 vbbo   : 0,
                 cumQty : 0,
                 key    : key};
    }

    // Sort the values of an object.
    // Create an array of the values, then sort them.
    this._sortValues = function(dataObject, compare)
    {
        // Create array of values
        var values = Object.keys(dataObject).map(function(key) {
            return dataObject[key];
        });

        // Do sort
        return values.sort(compare);
    }

    // Functor for buy side
    this._compareBuy = function(lhs, rhs)
    {
        // Check for market orders with zero price
        // (Note market orders with a price of 999999.0000 will be sorted correctly so no need for special attention)
        if (0 == lhs.price && 0 == rhs.price)
        {
            result = BookData.compareCommon(lhs, rhs);
        }
        else if (0 == lhs.price)
        {
            result = -1;
        }
        else if (0 == rhs.price)
        {
            result = 1;
        }
        else
        {
            // Non-market orders

            // Price first
            var result = rhs.price - lhs.price;

            // If same do common (Qty / Venue etc)
            if (0 == result)
            {
                result = BookData.compareCommon(lhs, rhs);
            }
        }

        return result;
    }

    // Functor for sell side
    this._compareSell = function(lhs, rhs)
    {
        // No need for special attention of market orders, they will always be sorted first

        // Price first
        var result = lhs.price - rhs.price;

        // If same do common (Qty / Venue etc)
        if (0 == result)
        {
            result = BookData.compareCommon(lhs, rhs);
        }

        return result;
    }

    // Recalculate the VBBO
    this._calculateVBBO = function (side, sortedArray)
    {
        var value = 0;
        var cumQty  = 0;

        // Special consideration when market orders
        var marketOrderChecker = new this.VBBOMarkerOrderChecker();

        // Loop through the price levels
        sortedArray.forEach(function(row)
        {
            var price    = Converter.toFloat(row.price);
            var quantity = Converter.toInt(row.qty);

            // Check if market order
            marketOrderChecker.checkMarketOrder(price);

            // Calculate the new data
            cumQty += quantity;
            value += (price * quantity);

            // Set the new data
            row.cumQty = cumQty;
            row.vbbo   = marketOrderChecker.calculateRowPrice(price, value, cumQty);
        });
    }

    // Call callback for each row
    this._redisplaySide = function(sortedArray, side, callback)
    {
        var rowCount = 0;

        // Loop through the price levels
        sortedArray.forEach(function(row)
        {
            // Ensure price correct
            var price = Number(row.price).toFixed(4);

            // Create data
            var bookUpdate = BookData.createUpdateObj(rowCount,
                                                      side,
                                                      row.qty,
                                                      price,
                                                      row.venue,
                                                      row.cumQty,
                                                      row.vbbo);

            // Send data
            callback.updateBook(bookUpdate);

            ++rowCount;
        });
    }

    // Calculate the vwap for the given quantity
    this._calculateVwapForQty = function(qty, sortedArray)
    {
        var remaining = qty;
        var used = 0;
        var value = 0;
        var level = -1;
        var rowQty = 0;
        var rowPrice = 0.0;

        // Special consideration when market orders
        var marketOrderChecker = new this.VBBOMarkerOrderChecker();

        // Loop through the price levels, calculating the price
        for (index = 0; index < sortedArray.length; index++)
        {
            var row = sortedArray[index];

            rowQty = Converter.toInt(row.qty);
            rowPrice = Converter.toFloat(row.price);

            // Check if market order
            marketOrderChecker.checkMarketOrder(rowPrice);

            if ((remaining > 0) && (rowQty > 0 && rowPrice !== NaN))
            {
                // What's the adjustment?
                var qtyAdjust = (remaining > rowQty ? rowQty : remaining);

                // Work out the new values
                remaining -= qtyAdjust;
                used += qtyAdjust;
                value += qtyAdjust * rowPrice;

                // Set that this level contributed
                level = index;
            }
        }

        return { qty   : used,
                 price : marketOrderChecker.calculatePrice(value, used),
                 level : level };
    }

    ////////////////////////////////////////////////////////////////////////////
    // VBBOMarkerOrderChecker - internal class to manage scenarios where market
    // orders are present

    this.VBBOMarkerOrderChecker = function()
    {
        // Is the current value a market order (and a buy or sell)
        this.isMarkerOrder    = false;
        this.isBidMarkerOrder = false;
        // Has there been a market order previously
        this.hasMarkerOrder   = false;

        this.checkMarketOrder = function(price)
        {
            switch (price)
            {
                case Formatter_MarketPrices.BID:
                    this.isMarkerOrder    = true;
                    this.isBidMarkerOrder = true;
                    this.hasMarkerOrder   = true;
                    break;

                case Formatter_MarketPrices.OFFER:
                    this.isMarkerOrder    = true;
                    this.isBidMarkerOrder = false;
                    this.hasMarkerOrder   = true;
                    break;

                default:
                    this.isMarkerOrder = false;
                    break;
            }
        }

        // Determine the price to return:
        // 1) If the current row is a market order, return the price (so it display as Mkt)
        // 2) If there has been a market order, return the bid/offer 'unknown' value
        // 3) Otherwise calculate the volume weighted price
        this.calculateRowPrice = function(price, numerator, denominator)
        {
            // There was/is a market order
            if (this.hasMarkerOrder)
            {
                // If this value is the market order, return the price
                if (this.isMarkerOrder)
                {
                    return price;
                }
                // Return the unknown bid or offer value
                else
                {
                    return (this.isBidMarkerOrder)
                        ? Formatter_MarketPrices.UNKNOWN_BID
                        : Formatter_MarketPrices.UNKNOWN_OFFER;
                }
            }
            // Calculate the volume weighted price
            else
            {
                return (denominator > 0) ? Number(numerator / denominator) : 0.0;
            }
        }

        // Determine the price to return:
        // 1) If there has been a market order, return the bid/offer market value
        // 2) Otherwise calculate the volume weighted price
        this.calculatePrice = function(numerator, denominator)
        {
            // There was/is a market order
            if (this.hasMarkerOrder)
            {
                return (this.isBidMarkerOrder)
                    ? Formatter_MarketPrices.BID
                    : Formatter_MarketPrices.OFFER;
            }
            else
            {
                return (denominator > 0) ? Number(numerator / denominator) : 0.0;
            }
        }

    }

}

////////////////////////////////////////////////////////////////////////////////
// Statics

// Get the instance
var bookData_instance = new BookData();
BookData.instance = function()
{
    return bookData_instance;
}

// This is called in the context of the sort so no "this"
BookData.compareCommon = function(lhs, rhs)
{
    // Larger quantity first
    var result = rhs.qty - lhs.qty;

    if (0 == result)
    {
        // If same price and quantity, sort Equiduct first, otherwise alphabetic
        if (lhs.venue == 'XEQT')
        {
            result = -1;
        }
        else if (rhs.venue == 'XEQT')
        {
            result = 1;
        }
        else
        {
            result = lhs.venue < rhs.venue;
        }
    }

    return result;
}

// Create update object
BookData.createUpdateObj = function(level, side, qty, price, venue, cumQty, vbbo)
{
    return {
                level  : level,
                side   : side,
                qty    : qty,
                price  : Number(price).toFixed(4),
                venue  : venue,
                cumQty : cumQty,
                vbbo   : Number(vbbo).toFixed(4)
           };
}
