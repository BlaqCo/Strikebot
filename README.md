# STRIKEBOT — automated options paper-trading bot

Node.js/Express bot that trades US equity options on **Alpaca paper trading**, with a live dashboard and a calibration ledger. Same architecture as PolyBettor: scanner loop → strict entry filters → frozen config → let the ledger judge.

## Why Alpaca (not Yahoo, not Webull for now)

- Yahoo Finance is data-only — no order execution, unofficial endpoints, rate limits.
- Alpaca is broker + data in one account: stock snapshots AND option chains **with greeks + IV included**, so signal prices match execution prices.
- Paper trading is a real environment: flip `ALPACA_TRADE_URL` to go live later, zero code changes.
- `alpaca.js` is an adapter — a Webull OpenAPI adapter can slot in behind the same interface later.

## Setup (5 minutes, all mobile-friendly)

1. Sign up / log in at **app.alpaca.markets** (free).
2. Switch to the **Paper** account (toggle top-left), then **API Keys → Generate** — copy the Key ID and Secret.
3. In the paper account settings, confirm **options trading is enabled** (paper accounts support options; the account's `options_trading_level` shows in `/v2/account`).
4. Push these files to a GitHub repo, deploy on Railway, set env vars below.
5. Open the Railway URL — dashboard is at `/`.

## Environment variables (Railway)

Required:
```
ALPACA_KEY=your_paper_key_id
ALPACA_SECRET=your_paper_secret
```

Frozen strategy config (defaults shown — tune AFTER a calibration week, not during):
```
WATCHLIST=SPY,QQQ,NVDA,TSLA,AAPL,META,AMD,MSFT,AMZN,GOOGL
MOM_MIN=0.006          # 0.6% day move triggers a signal
MIN_DTE=1
MAX_DTE=7
DELTA_MIN=0.45
DELTA_MAX=0.62
SPREAD_CAP=0.08        # reject contracts with spread > 8% of mid
MIN_BID=0.15
PER_TRADE_BUDGET=500
MAX_CONC=4
TP_PCT=0.30            # take profit +30% of premium
SL_PCT=0.20            # stop loss   -20% of premium
TIME_STOP_MIN=90
EOD_FLATTEN_MIN=10
DAILY_LOSS_STOP=300    # halt the day at -$300 (0 = off)
COOLDOWN_MIN=45
SCAN_INTERVAL_SEC=60
DRY_RUN=false          # true = simulate fills, send nothing to Alpaca
```

## How it trades (default engine)

1. Every 60s during market hours, snapshot the watchlist.
2. Any name moving ±0.6%+ on the day → directional signal (up = call, down = put).
3. Pull that name's option chain (1–7 DTE) and filter: |delta| 0.45–0.62, spread ≤ 8% of mid, bid ≥ $0.15, premium within budget.
4. Best contract = tightest spread closest to mid-band delta. Limit buy at the ask; cancel if unfilled in 25s.
5. Exits: +30% TP / −20% SL / 90-min time stop / EOD flatten 10 min before close / daily loss stop.
6. Every close writes a ledger row with entry delta, IV, spread, momentum, DTE, hold time, and exit reason — that's your calibration data.

## Calibration workflow

Run the frozen config for a week. Then read the ledger for edges: win rate by delta bucket, by momentum size, by underlying, by exit reason. Change ONE knob at a time. (Nothing here is financial advice — the defaults are a starting structure to generate data, not a claim that they're profitable.)

## Endpoints

- `GET /` dashboard
- `GET /api/status` full state
- `GET /api/ledger` calibration ledger
- `POST /api/halt` · `POST /api/resume` · `POST /api/flatten`
- `GET /health` for Railway

## Notes / known limits

- Free data = IEX stock feed + indicative options feed. Fine for paper/calibration; upgrade feeds before ever considering live.
- Railway's filesystem is ephemeral — `data/state.json` survives restarts but not redeploys. Ledger export/persistence upgrade is the obvious v2.
- Open interest isn't in the chain snapshot; liquidity is enforced via spread cap + min bid instead.
