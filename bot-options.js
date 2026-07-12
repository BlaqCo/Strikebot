// bot-options.js — the engine.
// Signals: v2 = RSI band + relative volume + VWAP trend + top-of-book imbalance (SIGNAL_MODE=v2)
//          v1 = simple day-move momentum (SIGNAL_MODE=momentum)
// Selection: delta band + spread cap + budget on the option chain (greeks from Alpaca).
// Exits: take-profit, stop-loss, time stop, EOD flatten, daily loss stop.
// Risk rails: per-trade budget, total exposure cap, daily loss stop, bankroll kill switch.
// Every close writes a calibration row. The ledger decides what survives.

const A = require('./alpaca');
const C = require('./config');
const S = require('./state');
const SIG = require('./signals');

const { state, addLog } = S;

// Latest broker/clock info for the dashboard (refreshed each tick)
const latest = { account: null, clock: null };

let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const clock = await A.clock();
    latest.clock = clock;
    S.rotateDay(clock.timestamp);

    try { latest.account = await A.account(); } catch (e) { /* non-fatal */ }

    // Bankroll kill switch — re-applied every tick so the daily reset can't clear it.
    if (C.BANKROLL_STOP > 0 && state.lifetime.netPnl <= -C.BANKROLL_STOP && !state.halted) {
      state.halted = true;
      state.haltReason = `bankroll stop: lifetime net $${state.lifetime.netPnl.toFixed(0)} <= -$${C.BANKROLL_STOP}`;
      addLog(`BANKROLL STOP: ${state.haltReason}`);
      S.save();
    }

    if (!clock.is_open) {
      state.lastScanAt = Date.now();
      return;
    }

    const msToClose = Date.parse(clock.next_close) - Date.parse(clock.timestamp);
    const eodWindow = msToClose <= C.EOD_FLATTEN_MIN * 60000;

    await managePositions(eodWindow);
    await checkDayStop();

    const openCount = Object.keys(state.positions).length;
    if (!eodWindow && !state.halted && openCount < C.MAX_CONC) {
      await scanEntries(clock, C.MAX_CONC - openCount);
    }

    state.lastScanAt = Date.now();
    state.lastError = null;
  } catch (e) {
    state.lastError = e.message;
    addLog(`tick error: ${e.message}`);
  } finally {
    ticking = false;
  }
}

// Total premium currently deployed across open positions ($)
function openExposure() {
  return Object.values(state.positions)
    .reduce((s, p) => s + p.entryPrice * 100 * p.qty, 0);
}

// ---------------- Position management ----------------

async function managePositions(eodWindow) {
  const symbols = Object.keys(state.positions);
  if (!symbols.length) return;

  // Reconcile with broker: if a live (non-dry) position vanished, it was closed externally.
  if (!C.DRY_RUN) {
    try {
      const broker = await A.positions();
      const held = new Set(broker.map(p => p.symbol));
      for (const sym of symbols) {
        const p = state.positions[sym];
        if (!p.dryRun && !held.has(sym) && Date.now() - p.openedAt > 60000) {
          S.closePosition(sym, p.mark || p.entryPrice, 'external');
          addLog(`${sym} closed externally — recorded at last mark`);
        }
      }
    } catch (e) { addLog(`reconcile failed: ${e.message}`); }
  }

  const live = Object.keys(state.positions);
  if (!live.length) return;

  let snaps = {};
  try { snaps = await A.optionSnapshots(live); }
  catch (e) { addLog(`marks fetch failed: ${e.message}`); return; }

  for (const sym of live) {
    const p = state.positions[sym];
    const q = snaps[sym] && snaps[sym].latestQuote;
    const bid = q && q.bp > 0 ? q.bp : null;
    const ask = q && q.ap > 0 ? q.ap : null;
    const mid = bid && ask ? (bid + ask) / 2
      : (snaps[sym] && snaps[sym].latestTrade ? snaps[sym].latestTrade.p : p.mark);

    if (mid) { p.mark = mid; p.bid = bid; }
    const pnlPct = p.entryPrice > 0 ? ((p.mark || p.entryPrice) - p.entryPrice) / p.entryPrice : 0;
    p.pnlPct = pnlPct;
    const ageMin = (Date.now() - p.openedAt) / 60000;

    let reason = null;
    if (eodWindow) reason = 'eod';
    else if (pnlPct >= C.TP_PCT) reason = 'tp';
    else if (pnlPct <= -C.SL_PCT) reason = 'sl';
    else if (ageMin >= C.TIME_STOP_MIN) reason = 'time';

    if (reason) await exitPosition(p, reason);
  }
  S.save();
}

async function exitPosition(p, reason) {
  const sym = p.symbol;
  const exitRef = p.bid || p.mark || p.entryPrice;

  if (p.dryRun || C.DRY_RUN) {
    const t = S.closePosition(sym, exitRef, reason);
    addLog(`DRY exit ${sym} @ ${exitRef} (${reason}) pnl $${t.pnl}`);
    return;
  }

  try {
    // Try a limit at the bid first (fills fast, avoids paying the whole spread blindly)
    const order = await A.placeOrder({
      symbol: sym, qty: String(p.qty), side: 'sell',
      type: 'limit', limit_price: String(round2(exitRef)), time_in_force: 'day',
    });
    const done = await pollOrder(order.id, C.ORDER_TIMEOUT_SEC);
    if (done && done.status === 'filled') {
      const px = parseFloat(done.filled_avg_price) || exitRef;
      const t = S.closePosition(sym, px, reason);
      addLog(`exit ${sym} @ ${px} (${reason}) pnl $${t.pnl}`);
      return;
    }
    if (done && done.status !== 'filled') { try { await A.cancelOrder(order.id); } catch {} }

    // Fallback: market close via broker
    const mkt = await A.closePosition(sym);
    let px = exitRef;
    if (mkt && mkt.id) {
      const filled = await pollOrder(mkt.id, 15);
      if (filled && filled.filled_avg_price) px = parseFloat(filled.filled_avg_price);
    }
    const t = S.closePosition(sym, px, reason);
    addLog(`exit(mkt) ${sym} @ ${px} (${reason}) pnl $${t.pnl}`);
  } catch (e) {
    addLog(`exit failed ${sym}: ${e.message}`);
  }
}

async function checkDayStop() {
  if (!C.DAILY_LOSS_STOP || state.halted) return;
  let unrealized = 0;
  for (const p of Object.values(state.positions)) {
    if (p.mark) unrealized += (p.mark - p.entryPrice) * 100 * p.qty;
  }
  const dayPnl = state.dayRealized + unrealized;
  if (dayPnl <= -C.DAILY_LOSS_STOP) {
    state.halted = true;
    state.haltReason = `daily loss stop hit ($${dayPnl.toFixed(0)})`;
    addLog(`DAY STOP: ${state.haltReason} — flattening`);
    await flattenAll('dayStop');
  }
}

async function flattenAll(reason) {
  for (const p of Object.values({ ...state.positions })) {
    await exitPosition(p, reason);
  }
}

// ---------------- Entries ----------------

async function scanEntries(clock, slots) {
  // Exposure gate: how much premium room is left under the cap?
  const room = C.MAX_TOTAL_EXPOSURE > 0
    ? C.MAX_TOTAL_EXPOSURE - openExposure()
    : Infinity;
  if (room < C.MIN_BID * 100) return; // not enough room for even the cheapest contract

  const candidates = C.SIGNAL_MODE === 'v2'
    ? await scanV2(clock)
    : await scanMomentum();

  for (const cand of candidates.slice(0, slots)) {
    try {
      await tryEnter(cand, clock);
    } catch (e) {
      addLog(`entry failed ${cand.sym}: ${e.message}`);
    }
  }
}

// v1: simple day-move momentum
async function scanMomentum() {
  let snaps;
  try { snaps = await A.stockSnapshots(C.WATCHLIST); }
  catch (e) { addLog(`stock snapshots failed: ${e.message}`); return []; }
  const map = snaps.snapshots || snaps;

  const openUnderlyings = new Set(Object.values(state.positions).map(p => p.underlying));
  const candidates = [];

  for (const sym of C.WATCHLIST) {
    const s = map[sym];
    if (!s || !s.prevDailyBar || !s.prevDailyBar.c) continue;
    const last = (s.latestTrade && s.latestTrade.p)
      || (s.minuteBar && s.minuteBar.c)
      || (s.dailyBar && s.dailyBar.c);
    if (!last) continue;
    const move = (last - s.prevDailyBar.c) / s.prevDailyBar.c;
    if (Math.abs(move) < C.MOM_MIN) continue;
    if (openUnderlyings.has(sym)) continue;
    if ((state.cooldowns[sym] || 0) > Date.now()) continue;
    candidates.push({ sym, move, direction: move > 0 ? 'call' : 'put', metrics: {}, mode: 'momentum' });
  }
  candidates.sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  return candidates;
}

// v2: RSI + RVOL + VWAP + book imbalance
async function scanV2(clock) {
  const openUnderlyings = new Set(Object.values(state.positions).map(p => p.underlying));
  const eligible = C.WATCHLIST.filter(sym =>
    !openUnderlyings.has(sym) && (state.cooldowns[sym] || 0) <= Date.now());
  if (!eligible.length) return [];

  let snaps, bars, quotes;
  try {
    const startIso = new Date(Date.parse(clock.timestamp) - 3 * 86400000).toISOString();
    [snaps, bars, quotes] = await Promise.all([
      A.stockSnapshots(eligible),
      A.stockBars(eligible, C.BAR_TIMEFRAME, startIso),
      C.BOOK_FILTER ? A.latestQuotes(eligible) : Promise.resolve({}),
    ]);
  } catch (e) { addLog(`v2 data fetch failed: ${e.message}`); return []; }
  const map = snaps.snapshots || snaps;
  const dayKey = String(clock.timestamp).slice(0, 10);

  const candidates = [];
  const blocked = {};

  for (const sym of eligible) {
    const s = map[sym];
    if (!s || !s.prevDailyBar || !s.prevDailyBar.c) continue;
    const price = (s.latestTrade && s.latestTrade.p)
      || (s.minuteBar && s.minuteBar.c)
      || (s.dailyBar && s.dailyBar.c);
    if (!price) continue;
    const dayMove = (price - s.prevDailyBar.c) / s.prevDailyBar.c;

    const verdict = SIG.evaluateV2({
      bars: bars[sym] || [],
      dayKey,
      quote: quotes[sym],
      dayMove,
      price,
    });

    if (!verdict.direction) {
      if (verdict.blockedBy) blocked[verdict.blockedBy] = (blocked[verdict.blockedBy] || 0) + 1;
      continue;
    }
    candidates.push({
      sym, move: dayMove, direction: verdict.direction,
      metrics: verdict.metrics, mode: 'v2',
    });
  }

  // Strongest conviction first: highest relative volume
  candidates.sort((a, b) => (b.metrics.rvol || 0) - (a.metrics.rvol || 0));

  if (!candidates.length && Object.keys(blocked).length) {
    const summary = Object.entries(blocked).map(([k, v]) => `${k}:${v}`).join(' ');
    addLog(`v2 scan: no signals (gates blocked — ${summary})`);
  }
  return candidates;
}

async function tryEnter({ sym, move, direction, metrics, mode }, clock) {
  // Budget for THIS trade = per-trade cap, shrunk to whatever exposure room remains.
  let budget = C.PER_TRADE_BUDGET;
  if (C.MAX_TOTAL_EXPOSURE > 0) {
    const room = C.MAX_TOTAL_EXPOSURE - openExposure();
    if (room <= 0) return;
    budget = Math.min(budget, room);
  }

  const type = direction;
  const nowMs = Date.parse(clock.timestamp);
  const expGte = isoDate(nowMs + C.MIN_DTE * 86400000);
  const expLte = isoDate(nowMs + C.MAX_DTE * 86400000);

  const chain = await A.optionChain(sym, { type, expGte, expLte });
  const targetDelta = (C.DELTA_MIN + C.DELTA_MAX) / 2;

  let best = null;
  for (const [occ, snap] of Object.entries(chain)) {
    const info = A.parseOcc(occ);
    const q = snap.latestQuote;
    const g = snap.greeks;
    if (!info || !q || !g) continue;
    const bid = q.bp, ask = q.ap;
    if (!(bid >= C.MIN_BID) || !(ask > bid)) continue;
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    if (spreadPct > C.SPREAD_CAP) continue;
    const delta = Math.abs(g.delta || 0);
    if (delta < C.DELTA_MIN || delta > C.DELTA_MAX) continue;
    if (ask * 100 > budget) continue;

    const score = spreadPct + Math.abs(delta - targetDelta) * 0.5;
    if (!best || score < best.score) {
      best = { occ, info, bid, ask, mid, spreadPct, delta, iv: snap.impliedVolatility, score };
    }
  }
  if (!best) { addLog(`${sym} ${type}: no contract passed filters (budget $${budget.toFixed(0)})`); return; }

  const qty = Math.floor(budget / (best.ask * 100));
  if (qty < 1) return;
  const cost = best.ask * 100 * qty;

  // Buying power guard
  if (latest.account) {
    const bp = parseFloat(latest.account.options_buying_power ?? latest.account.buying_power ?? '0');
    if (bp && cost > bp) { addLog(`${sym}: cost $${cost.toFixed(0)} > buying power`); return; }
  }

  const meta = {
    symbol: best.occ,
    underlying: sym,
    direction: type,
    qty,
    entryPrice: best.ask,
    openedAt: Date.now(),
    signalMode: mode,
    entryDelta: round4(best.delta),
    entryIv: best.iv ? round4(best.iv) : null,
    entrySpreadPct: round4(best.spreadPct),
    entryMomentum: round4(move),
    entryRsi: metrics.rsi ?? null,
    entryRvol: metrics.rvol ?? null,
    entryVwapDist: metrics.vwapDist ?? null,
    entryBookImb: metrics.bookImb ?? null,
    dteAtEntry: A.dte(best.info.exp, nowMs),
    strike: best.info.strike,
    exp: best.info.exp,
    mark: best.mid,
    dryRun: C.DRY_RUN,
  };

  const sigNote = mode === 'v2'
    ? `RSI ${metrics.rsi} RVOL ${metrics.rvol} book ${metrics.bookImb ?? '—'}`
    : `mom ${(move * 100).toFixed(2)}%`;

  if (C.DRY_RUN) {
    S.openPosition(meta);
    addLog(`DRY enter ${best.occ} x${qty} @ ${best.ask} (Δ${meta.entryDelta}, ${sigNote})`);
    return;
  }

  const order = await A.placeOrder({
    symbol: best.occ, qty: String(qty), side: 'buy',
    type: 'limit', limit_price: String(round2(best.ask)), time_in_force: 'day',
  });
  const done = await pollOrder(order.id, C.ORDER_TIMEOUT_SEC);

  if (done && parseFloat(done.filled_qty) > 0) {
    if (done.status !== 'filled') { try { await A.cancelOrder(order.id); } catch {} }
    meta.qty = parseInt(done.filled_qty, 10);
    meta.entryPrice = parseFloat(done.filled_avg_price) || best.ask;
    S.openPosition(meta);
    addLog(`enter ${best.occ} x${meta.qty} @ ${meta.entryPrice} (Δ${meta.entryDelta}, ${sigNote})`);
  } else {
    if (done && done.status !== 'filled') { try { await A.cancelOrder(order.id); } catch {} }
    addLog(`${best.occ}: not filled in ${C.ORDER_TIMEOUT_SEC}s — cancelled`);
  }
}

// ---------------- Helpers ----------------

async function pollOrder(id, timeoutSec) {
  const until = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      last = await A.getOrder(id);
      if (['filled', 'canceled', 'expired', 'rejected'].includes(last.status)) return last;
    } catch (e) { /* keep polling */ }
  }
  return last;
}

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

function start() {
  S.load();
  addLog(`bot started ${C.DRY_RUN ? '[DRY RUN]' : '[PAPER via Alpaca]'} — signal: ${C.SIGNAL_MODE} — watchlist: ${C.WATCHLIST.join(', ')}`);
  if (C.MAX_TOTAL_EXPOSURE > 0) addLog(`exposure cap: $${C.MAX_TOTAL_EXPOSURE} total open premium`);
  if (C.BANKROLL_STOP > 0) addLog(`bankroll stop: permanent halt at lifetime -$${C.BANKROLL_STOP}`);
  tick();
  setInterval(tick, C.SCAN_INTERVAL_SEC * 1000);
}

module.exports = { start, tick, flattenAll, latest };
