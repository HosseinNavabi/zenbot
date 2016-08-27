var n = require('numbro')
  , colors = require('colors')
  , parallel = require('run-parallel')
  , tb = require('timebucket')
  , o = require('object-get')

module.exports = function container (get, set, clear) {
  var get_tick_str = get('utils.get_tick_str')
  var get_timestamp = get('utils.get_timestamp')
  var z = get('utils.zero_fill')
  var start = new Date().getTime()
  return function tick_reducer (g, cb) {
    var c = get('config')
    var options = get('options')
    var tick = g.tick, sub_tick = g.sub_tick
    if (sub_tick.data.rsi_backfill) {
      tick.data.rsi_backfill = true
    }
    // only process specific tick sizes
    if (c.rsi_sizes.indexOf(tick.size) === -1) return cb()
    if (tick.time < start && !sub_tick.data.rsi_backfill) return cb()
    //console.error('computing RSI', tick.id)
    var bucket = tb(tick.time).resize(tick.size)
    var d = tick.data.trades
    get('ticks').select({
      query: {
        app: get('app_name'),
        size: tick.size,
        time: {
          $lt: bucket.toMilliseconds()
        }
      },
      limit: c.rsi_query_limit,
      sort: {
        time: -1
      }
    }, function (err, lookback) {
      if (err) return cb(err)
      withLookback(lookback.reverse())
    })
    function withLookback (lookback) {
      var computations = 0
      Object.keys(d).forEach(function (e) {
        Object.keys(d[e]).forEach(function (pair) {
          var de = d[e][pair]
          de['rsi'] || (de['rsi'] = {})
          var r = de['rsi']
          r.ansi = ''
          var close_lookback = lookback.filter(function (tick) {
            return !!o(tick, 'data.trades.' + e + '.' + pair)
          }).map(function (tick) {
            return o(tick, 'data.trades.' + e + '.' + pair + '.close')
          })
          if (close_lookback.length > c.rsi_periods - 1) {
            close_lookback = close_lookback.slice(close_lookback.length - c.rsi_periods + 1)
          }
          r.samples = close_lookback.length
          var current_gain, current_loss
          var last_close = close_lookback[r.samples - 1]
          r.last_close = last_close
          if (!last_close) {
            current_gain = current_loss = 0
          }
          else {
            current_gain = de.close > last_close ? n(de.close).subtract(last_close).value() : 0
            current_loss = de.close < last_close ? n(last_close).subtract(de.close).value() : 0
          }
          last_close = 0
          var gain_sum = close_lookback.reduce(function (prev, curr) {
            if (!last_close) {
              last_close = curr
              return 0
            }
            var gain = curr > last_close ? curr - last_close : 0
            last_close = curr
            return prev + gain
          }, 0)
          var avg_gain = r.samples ? n(gain_sum).divide(r.samples).value() : 0
          // that was the avg gain of the lookback, but we want the last avg gain
          // if possible, to get smoothing effect.
          var rsi_lookback = lookback.filter(function (tick) {
            return !!o(tick, 'data.trades.' + e + '.' + pair)
          }).map(function (tick) {
            return o(tick, 'data.trades.' + e + '.' + pair + '.rsi')
          })
          var last_rsi = rsi_lookback.pop()
          if (last_rsi && last_rsi.avg_gain) {
            avg_gain = last_rsi.avg_gain
          }
          last_close = 0
          var loss_sum = close_lookback.reduce(function (prev, curr) {
            if (!last_close) {
              last_close = curr
              return 0
            }
            var loss = curr < last_close ? last_close - curr : 0
            last_close = curr
            return prev + loss
          }, 0)
          var avg_loss = r.samples ? n(loss_sum).divide(r.samples).value() : 0
          if (last_rsi && last_rsi.avg_loss) {
            avg_loss = last_rsi.avg_loss
          }
          var avg_gain_2 = n(avg_gain).multiply(c.rsi_periods - 1).add(current_gain).divide(c.rsi_periods).value()
          var avg_loss_2 = n(avg_loss).multiply(c.rsi_periods - 1).add(current_loss).divide(c.rsi_periods).value()
          if (avg_loss_2 === 0) {
            r.value = avg_gain_2 ? 100 : 50
          }
          else {
            r.relative_strength = n(avg_gain_2).divide(avg_loss_2).value()
            r.value = n(100).subtract(n(100).divide(n(1).add(r.relative_strength))).value()
          }
          //console.error(gain_sum, avg_gain, loss_sum, avg_loss, avg_gain_2, avg_loss_2, relative_strength)
          r.samples = last_rsi ? last_rsi.samples + 1 : close_lookback.length
          r.ansi = n(r.value).format('0')[r.value > 70 ? 'green' : r.value < 30 ? 'red' : 'white'] + ('x' + r.samples).grey
          r.close_lookback = close_lookback
          r.current_gain = current_gain
          r.current_loss = current_loss
          r.avg_gain = avg_gain_2
          r.avg_loss = avg_loss_2
          if (r.samples >= c.rsi_periods) {
            //get('logger').info('RSI', z(12, get_tick_str(tick.id)), get_timestamp(tick.time).grey, r.ansi, ('x' + r.samples).grey)
            computations++
          }
        })
      })
      if (computations) {
        //get('logger').info('RSI', 'computed RSI '.grey, ('x' + computations).grey)
      }
      delete sub_tick.data.rsi_backfill
      delete tick.data.rsi_backfill
      cb()
    }
  }
}
