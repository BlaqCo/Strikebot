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
  WATCHLIST: str('WATCHLIST', 'SPY,QQQ,NVDA,TSLA,AAPL,META,AMD,MSFT,AMZN,GOOGL')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean),

  // ---- Signal (momentum) ----
  MOM_MIN: num('MOM_MIN', 0.006),        // min abs day move to trigger (0.6%)
  SCAN_INTERVAL_SEC: num('SCAN_INTERVAL_SEC', 60),
  COOLDOWN_MIN: num('COOLDOWN_MIN', 45), // per-underlying re-entry cooldown

  // ---- Contract selection ----
  MIN_DTE: num('MIN_DTE', 1),
  MAX_DTE: num('MAX_DTE', 7),
  DELTA_MIN: num('DELTA_MIN', 0.45),
  DELTA_MAX: num('DELTA_MAX', 0.62),
  SPREAD_CAP: num('SPREAD_CAP', 0.08),   // (ask-bid)/mid must be <= this
  MIN_BID: num('MIN_BID', 0.15),         // ignore illiquid dust contracts

  // ---- Sizing & risk ----
  PER_TRADE_BUDGET: num('PER_TRADE_BUDGET', 500), // $ per position (premium)
  MAX_CONC: num('MAX_CONC', 4),                   // max simultaneous positions
  TP_PCT: num('TP_PCT', 0.30),                    // take profit at +30% of premium
  SL_PCT: num('SL_PCT', 0.20),                    // stop loss at -20% of premium
  TIME_STOP_MIN: num('TIME_STOP_MIN', 90),        // exit stale positions
  EOD_FLATTEN_MIN: num('EOD_FLATTEN_MIN', 10),    // flatten N min before close
  DAILY_LOSS_STOP: num('DAILY_LOSS_STOP', 300),   // halt day at -$X (0 = off)

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
