// config.js — every knob is an env var. Freeze the winning config, let the ledger judge it.

function num(name, def) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function str(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const CONFIG = {
  // ---- Alpaca ----
  ALPACA_KEY: str('ALPACA_KEY', ''),
  ALPACA_SECRET: str('ALPACA_SECRET', ''),
  TRADE_URL: str('ALPACA_TRADE_URL', 'https://paper-api.alpaca.markets'),
  DATA_URL: str('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
  STOCK_FEED: str('STOCK_FEED', 'iex'),          // free plan: iex
  OPTION_FEED: str('OPTION_FEED', 'indicative'), // free plan: indicative

  // ---- Mode ----
  DRY_RUN: bool('DRY_RUN', false), // true = no orders sent, fills simulated (entry@ask, exit@bid)

  // ---- Universe ----
  // Tuned for a $200/trade premium budget: liquid names whose near-ATM weeklies price under ~$2.00
  WATCHLIST: str('WATCHLIST', 'AMD,INTC,F,SOFI,PLTR,BAC,T,NIO,SNAP,UBER,RIVN,AAL')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),

  // ---- Signal engine ----
  SIGNAL_MODE: str('SIGNAL_MODE', 'v2'), // 'v2' = RSI+RVOL+VWAP+book | 'momentum' = v1 day-move
  SCAN_INTERVAL_SEC: num('SCAN_INTERVAL_SEC', 60),
  COOLDOWN_MIN: num('COOLDOWN_MIN', 45), // per-underlying re-entry cooldown

  // v1 (momentum)
  MOM_MIN: num('MOM_MIN', 0.006),        // min abs day move to trigger (0.6%)

  // v2 (scalper stack)
  BAR_TIMEFRAME: str('BAR_TIMEFRAME', '5Min'),
  RSI_PERIOD: num('RSI_PERIOD', 14),
  RSI_LONG_MIN: num('RSI_LONG_MIN', 55),  // calls: RSI in [55,75] = trending, not exhausted
  RSI_LONG_MAX: num('RSI_LONG_MAX', 75),  // puts mirror: RSI in [25,45]
  RVOL_MIN: num('RVOL_MIN', 1.5),         // last bar volume vs avg of lookback bars
  RVOL_LOOKBACK: num('RVOL_LOOKBACK', 20),
  VWAP_FILTER: bool('VWAP_FILTER', true), // calls only above VWAP, puts only below
  BOOK_FILTER: bool('BOOK_FILTER', true), // top-of-book size imbalance confirmation
  BOOK_IMB_MIN: num('BOOK_IMB_MIN', 0.60),// bid share >= 0.60 for calls, <= 0.40 for puts
  MOM_MIN_V2: num('MOM_MIN_V2', 0.003),   // softer day-move floor (0.3%), other gates do the work

  // ---- Contract selection ----
  MIN_DTE: num('MIN_DTE', 1),
  MAX_DTE: num('MAX_DTE', 7),
  DELTA_MIN: num('DELTA_MIN', 0.45),
  DELTA_MAX: num('DELTA_MAX', 0.62),
  SPREAD_CAP: num('SPREAD_CAP', 0.08),   // (ask-bid)/mid must be <= this
  MIN_BID: num('MIN_BID', 0.15),         // ignore illiquid dust contracts

  // ---- Sizing & risk ----
  PER_TRADE_BUDGET: num('PER_TRADE_BUDGET', 200),  // $ per position (premium)
  MAX_TOTAL_EXPOSURE: num('MAX_TOTAL_EXPOSURE', 400),// $ cap on TOTAL open premium (0 = off)
  BANKROLL_STOP: num('BANKROLL_STOP', 400),        // permanent halt if lifetime net <= -$X (0 = off)
  MAX_CONC: num('MAX_CONC', 2),                    // max simultaneous positions
  TP_PCT: num('TP_PCT', 0.30),                     // take profit at +30% of premium
  SL_PCT: num('SL_PCT', 0.20),                     // stop loss at -20% of premium
  TIME_STOP_MIN: num('TIME_STOP_MIN', 90),         // exit stale positions
  EOD_FLATTEN_MIN: num('EOD_FLATTEN_MIN', 10),     // flatten N min before close
  DAILY_LOSS_STOP: num('DAILY_LOSS_STOP', 150),    // halt day at -$X (0 = off)

  // ---- Execution ----
  ORDER_TIMEOUT_SEC: num('ORDER_TIMEOUT_SEC', 25), // cancel unfilled limits after this

  // ---- Server ----
  PORT: num('PORT', 3000),
  DATA_FILE: str('DATA_FILE', './data/state.json'),
};

// Public (no secrets) view for the dashboard config panel
CONFIG.publicView = function () {
  const { ALPACA_KEY, ALPACA_SECRET, publicView, ...rest } = CONFIG;
  return { ...rest, WATCHLIST: CONFIG.WATCHLIST.join(',') };
};

module.exports = CONFIG;
