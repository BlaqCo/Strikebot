// signals.js — the v2 scalper stack: RSI + relative volume + VWAP trend + top-of-book imbalance.
// Pure functions in, verdicts out. Every value gets recorded in the ledger for calibration.

const C = require('./config');

// Wilder's RSI over an array of closes. Returns null if not enough data.
function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

// Session VWAP from today's bars (typical price weighted by volume)
function vwap(todayBars) {
  let pv = 0, vol = 0;
  for (const b of todayBars) {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * b.v;
    vol += b.v;
  }
  return vol > 0 ? pv / vol : null;
}

// Relative volume: last completed bar's volume vs average of the prior N bars
function rvol(bars, lookback = 20) {
  if (!bars || bars.length < lookback + 1) return null;
  const last = bars[bars.length - 1].v;
  const prior = bars.slice(-(lookback + 1), -1);
  const avg = prior.reduce((s, b) => s + b.v, 0) / prior.length;
  return avg > 0 ? last / avg : null;
}

// Top-of-book imbalance from a latest quote: bid size share of total displayed size.
// 0.5 = balanced, >0.5 = bid-heavy (buyers stacked), <0.5 = ask-heavy.
function bookImbalance(quote) {
  if (!quote) return null;
  const bs = quote.bs || 0, as = quote.as || 0;
  const total = bs + as;
  return total > 0 ? bs / total : null;
}

// Evaluate one symbol through the full v2 gate stack.
// inputs: { bars (2-day 5min asc), dayKey 'YYYY-MM-DD', quote, dayMove, price }
// Returns { direction: 'call'|'put'|null, metrics, blockedBy }
function evaluateV2({ bars, dayKey, quote, dayMove, price }) {
  const metrics = { rsi: null, rvol: null, vwapDist: null, bookImb: null };
  const out = (direction, blockedBy = null) => ({ direction, metrics, blockedBy });

  if (!bars || bars.length < C.RSI_PERIOD + 2) return out(null, 'bars');

  const closes = bars.map(b => b.c);
  const r = rsi(closes, C.RSI_PERIOD);
  metrics.rsi = r == null ? null : Math.round(r * 10) / 10;

  const rv = rvol(bars, C.RVOL_LOOKBACK);
  metrics.rvol = rv == null ? null : Math.round(rv * 100) / 100;

  const todayBars = bars.filter(b => String(b.t).slice(0, 10) === dayKey);
  const vw = vwap(todayBars);
  metrics.vwapDist = vw && price ? Math.round(((price - vw) / vw) * 10000) / 10000 : null;

  const imb = bookImbalance(quote);
  metrics.bookImb = imb == null ? null : Math.round(imb * 100) / 100;

  // ---- Direction bias from RSI band ----
  const longRsi = r != null && r >= C.RSI_LONG_MIN && r <= C.RSI_LONG_MAX;
  const shortRsi = r != null && r >= (100 - C.RSI_LONG_MAX) && r <= (100 - C.RSI_LONG_MIN);
  let direction = longRsi ? 'call' : (shortRsi ? 'put' : null);
  if (!direction) return out(null, 'rsi');

  // ---- Day-move floor must agree with direction ----
  if (direction === 'call' && dayMove < C.MOM_MIN_V2) return out(null, 'mom');
  if (direction === 'put' && dayMove > -C.MOM_MIN_V2) return out(null, 'mom');

  // ---- Volume confirmation ----
  if (rv == null || rv < C.RVOL_MIN) return out(null, 'rvol');

  // ---- VWAP trend gate ----
  if (C.VWAP_FILTER && vw != null) {
    if (direction === 'call' && price <= vw) return out(null, 'vwap');
    if (direction === 'put' && price >= vw) return out(null, 'vwap');
  }

  // ---- Book imbalance confirmation ----
  if (C.BOOK_FILTER && imb != null) {
    if (direction === 'call' && imb < C.BOOK_IMB_MIN) return out(null, 'book');
    if (direction === 'put' && imb > 1 - C.BOOK_IMB_MIN) return out(null, 'book');
  }

  return out(direction);
}

module.exports = { rsi, vwap, rvol, bookImbalance, evaluateV2 };
