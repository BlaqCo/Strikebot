// alpaca.js — Alpaca trading + market data client (paper by default).
// Auth is just two headers. No signing. Node 18+ native fetch.

const C = require('./config');

function headers() {
  return {
    'APCA-API-KEY-ID': C.ALPACA_KEY,
    'APCA-API-SECRET-KEY': C.ALPACA_SECRET,
    'accept': 'application/json',
    'content-type': 'application/json',
  };
}

async function req(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: headers() });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${url}`);
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (!res.ok) {
        const msg = body && body.message ? body.message : text;
        const err = new Error(`HTTP ${res.status} ${url} :: ${msg}`);
        err.status = res.status;
        throw err;
      }
      return body;
    } catch (e) {
      lastErr = e;
      if (e.status && e.status < 500 && e.status !== 429) throw e; // don't retry 4xx
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- Trading API ----------
const T = C.TRADE_URL;

async function account() { return req(`${T}/v2/account`); }
async function clock() { return req(`${T}/v2/clock`); }
async function positions() { return req(`${T}/v2/positions`); }
async function openOrders() { return req(`${T}/v2/orders?status=open&limit=100`); }
async function getOrder(id) { return req(`${T}/v2/orders/${id}`); }
async function cancelOrder(id) {
  return req(`${T}/v2/orders/${id}`, { method: 'DELETE' });
}
async function placeOrder(body) {
  return req(`${T}/v2/orders`, { method: 'POST', body: JSON.stringify(body) });
}
// Market-close a position (fallback when limit exit won't fill)
async function closePosition(symbol) {
  return req(`${T}/v2/positions/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
}

// ---------- Market Data API ----------
const D = C.DATA_URL;

// Snapshots for a batch of stock symbols
async function stockSnapshots(symbols) {
  const url = `${D}/v2/stocks/snapshots?symbols=${symbols.join(',')}&feed=${C.STOCK_FEED}`;
  return req(url);
}

// Latest top-of-book quotes for a batch of symbols (bp/bs/ap/as)
async function latestQuotes(symbols) {
  const url = `${D}/v2/stocks/quotes/latest?symbols=${symbols.join(',')}&feed=${C.STOCK_FEED}`;
  const body = await req(url);
  return body.quotes || {};
}

// Intraday bars for a batch of symbols since startIso (paginated).
// Returns { SYM: [ {t,o,h,l,c,v}, ... ] } sorted ascending.
async function stockBars(symbols, timeframe, startIso) {
  const out = {};
  let pageToken = null;
  do {
    const p = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe,
      start: startIso,
      limit: '10000',
      feed: C.STOCK_FEED,
      sort: 'asc',
    });
    if (pageToken) p.set('page_token', pageToken);
    const body = await req(`${D}/v2/stocks/bars?${p.toString()}`);
    for (const [sym, bars] of Object.entries(body.bars || {})) {
      out[sym] = (out[sym] || []).concat(bars);
    }
    pageToken = body.next_page_token || null;
  } while (pageToken);
  return out;
}

// Full option chain snapshots for one underlying (paginated), with greeks + IV.
// filters: { type: 'call'|'put', expGte: 'YYYY-MM-DD', expLte: 'YYYY-MM-DD' }
async function optionChain(underlying, filters = {}) {
  const out = {};
  let pageToken = null;
  do {
    const p = new URLSearchParams({ feed: C.OPTION_FEED, limit: '1000' });
    if (filters.type) p.set('type', filters.type);
    if (filters.expGte) p.set('expiration_date_gte', filters.expGte);
    if (filters.expLte) p.set('expiration_date_lte', filters.expLte);
    if (pageToken) p.set('page_token', pageToken);
    const body = await req(`${D}/v1beta1/options/snapshots/${underlying}?${p.toString()}`);
    Object.assign(out, body.snapshots || {});
    pageToken = body.next_page_token || null;
  } while (pageToken);
  return out;
}

// Snapshots for specific option contracts (marks for open positions)
async function optionSnapshots(symbols) {
  if (!symbols.length) return {};
  const url = `${D}/v1beta1/options/snapshots?symbols=${symbols.join(',')}&feed=${C.OPTION_FEED}`;
  const body = await req(url);
  return body.snapshots || {};
}

// ---------- OCC symbol helpers ----------
// e.g. AAPL260717C00210000 -> { underlying:'AAPL', exp:'2026-07-17', type:'call', strike:210 }
function parseOcc(sym) {
  const m = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(sym);
  if (!m) return null;
  const [, u, d, cp, s] = m;
  return {
    underlying: u,
    exp: `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`,
    type: cp === 'C' ? 'call' : 'put',
    strike: parseInt(s, 10) / 1000,
  };
}

function dte(expIso, nowMs = Date.now()) {
  return Math.max(0, Math.round((Date.parse(`${expIso}T21:00:00Z`) - nowMs) / 86400000));
}

module.exports = {
  account, clock, positions, openOrders, getOrder, cancelOrder,
  placeOrder, closePosition,
  stockSnapshots, latestQuotes, stockBars, optionChain, optionSnapshots,
  parseOcc, dte,
};
