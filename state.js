// state.js — in-memory state with JSON persistence. The ledger is the product:
// every close records the entry conditions so the data can judge the config.

const fs = require('fs');
const path = require('path');
const C = require('./config');

const state = {
  startedAt: Date.now(),
  // occSymbol -> position meta
  positions: {},
  // closed trades (calibration ledger)
  ledger: [],
  // lifetime stats
  lifetime: { wins: 0, losses: 0, netPnl: 0, volume: 0, trades: 0 },
  // day tracking
  dayKey: null,        // 'YYYY-MM-DD' in market time
  dayRealized: 0,
  halted: false,
  haltReason: null,
  // per-underlying cooldowns: symbol -> ts when re-entry allowed
  cooldowns: {},
  // rolling log for dashboard
  log: [],
  lastScanAt: null,
  lastError: null,
};

function addLog(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  state.log.unshift(line);
  if (state.log.length > 200) state.log.length = 200;
  console.log(line);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(C.DATA_FILE), { recursive: true });
      const { log, ...persist } = state; // don't persist the console log
      fs.writeFileSync(C.DATA_FILE, JSON.stringify(persist));
    } catch (e) {
      console.error('state save failed:', e.message);
    }
  }, 500);
}

function load() {
  try {
    if (fs.existsSync(C.DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(C.DATA_FILE, 'utf8'));
      Object.assign(state, data, { log: [], startedAt: Date.now() });
      addLog(`state loaded: ${Object.keys(state.positions).length} open, ${state.ledger.length} in ledger`);
    }
  } catch (e) {
    console.error('state load failed (starting fresh):', e.message);
  }
}

// Reset day counters when the market date rolls over (uses clock timestamp)
function rotateDay(clockTsIso) {
  const key = String(clockTsIso).slice(0, 10);
  if (state.dayKey !== key) {
    state.dayKey = key;
    state.dayRealized = 0;
    state.halted = false;
    state.haltReason = null;
    addLog(`new session day: ${key}`);
    save();
  }
}

function openPosition(meta) {
  state.positions[meta.symbol] = meta;
  state.cooldowns[meta.underlying] = Date.now() + C.COOLDOWN_MIN * 60000;
  save();
}

function closePosition(symbol, exitPrice, reason) {
  const p = state.positions[symbol];
  if (!p) return null;
  delete state.positions[symbol];

  const pnl = (exitPrice - p.entryPrice) * 100 * p.qty;
  const pnlPct = p.entryPrice > 0 ? (exitPrice - p.entryPrice) / p.entryPrice : 0;
  const entry = {
    symbol,
    underlying: p.underlying,
    direction: p.direction,          // 'call' | 'put'
    qty: p.qty,
    entryPrice: p.entryPrice,
    exitPrice,
    pnl: round2(pnl),
    pnlPct: round4(pnlPct),
    reason,                           // tp | sl | time | eod | dayStop | manual | external
    openedAt: p.openedAt,
    closedAt: Date.now(),
    holdMin: Math.round((Date.now() - p.openedAt) / 60000),
    // calibration snapshot from entry time:
    signalMode: p.signalMode || 'momentum',
    entryDelta: p.entryDelta,
    entryIv: p.entryIv,
    entrySpreadPct: p.entrySpreadPct,
    entryMomentum: p.entryMomentum,
    entryRsi: p.entryRsi ?? null,
    entryRvol: p.entryRvol ?? null,
    entryVwapDist: p.entryVwapDist ?? null,
    entryBookImb: p.entryBookImb ?? null,
    dteAtEntry: p.dteAtEntry,
    strike: p.strike,
    exp: p.exp,
    dryRun: !!p.dryRun,
  };
  state.ledger.unshift(entry);
  if (state.ledger.length > 2000) state.ledger.length = 2000;

  state.dayRealized += pnl;
  state.lifetime.trades += 1;
  state.lifetime.netPnl = round2(state.lifetime.netPnl + pnl);
  state.lifetime.volume = round2(state.lifetime.volume + p.entryPrice * 100 * p.qty);
  if (pnl >= 0) state.lifetime.wins += 1; else state.lifetime.losses += 1;

  save();
  return entry;
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = { state, addLog, save, load, rotateDay, openPosition, closePosition, round2 };
