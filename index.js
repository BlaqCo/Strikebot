// index.js — Express server + dashboard + control endpoints. Boots the bot loop.

const express = require('express');
const path = require('path');
const C = require('./config');
const { state, addLog, save } = require('./state');
const bot = require('./bot-options');

const app = express();
app.use(express.json());

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/status', (_req, res) => {
  const positions = Object.values(state.positions).map(p => ({
    symbol: p.symbol,
    underlying: p.underlying,
    direction: p.direction,
    qty: p.qty,
    entryPrice: p.entryPrice,
    mark: p.mark || p.entryPrice,
    pnlPct: p.pnlPct || 0,
    pnl: ((p.mark || p.entryPrice) - p.entryPrice) * 100 * p.qty,
    ageMin: Math.round((Date.now() - p.openedAt) / 60000),
    strike: p.strike,
    exp: p.exp,
    delta: p.entryDelta,
  }));

  const unrealized = positions.reduce((s, p) => s + p.pnl, 0);
  const acct = bot.latest.account;
  const wins = state.lifetime.wins, losses = state.lifetime.losses;

  res.json({
    mode: C.DRY_RUN ? 'DRY RUN' : 'PAPER',
    marketOpen: bot.latest.clock ? bot.latest.clock.is_open : null,
    nextClose: bot.latest.clock ? bot.latest.clock.next_close : null,
    equity: acct ? parseFloat(acct.equity) : null,
    buyingPower: acct ? parseFloat(acct.options_buying_power ?? acct.buying_power ?? 0) : null,
    dayRealized: Math.round(state.dayRealized * 100) / 100,
    unrealized: Math.round(unrealized * 100) / 100,
    dayPnl: Math.round((state.dayRealized + unrealized) * 100) / 100,
    halted: state.halted,
    haltReason: state.haltReason,
    lifetime: state.lifetime,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    positions,
    maxConc: C.MAX_CONC,
    lastScanAt: state.lastScanAt,
    lastError: state.lastError,
    log: state.log.slice(0, 40),
    config: C.publicView(),
  });
});

app.get('/api/ledger', (_req, res) => {
  res.json({ ledger: state.ledger.slice(0, 200) });
});

app.post('/api/flatten', async (_req, res) => {
  addLog('manual flatten requested');
  await bot.flattenAll('manual');
  res.json({ ok: true });
});

app.post('/api/halt', (_req, res) => {
  state.halted = true;
  state.haltReason = 'manual halt';
  addLog('manual halt — no new entries');
  save();
  res.json({ ok: true });
});

app.post('/api/resume', (_req, res) => {
  state.halted = false;
  state.haltReason = null;
  addLog('resumed — entries enabled');
  save();
  res.json({ ok: true });
});

app.listen(C.PORT, () => {
  console.log(`strikebot dashboard on :${C.PORT}`);
  if (!C.ALPACA_KEY || !C.ALPACA_SECRET) {
    console.error('WARNING: ALPACA_KEY / ALPACA_SECRET not set — API calls will fail.');
  }
  bot.start();
});
