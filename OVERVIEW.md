# AgentBackTest — what the app does

An intraday trading research and paper-trading tool for Indian stocks (NSE), connected to Upstox for prices. It finds stocks worth looking at, proposes trades with a stop and target, checks each one against your money and loss limits, and lets you paper trade them. It also backtests strategies on years of 5-minute data with real Upstox charges.

**It never places a real order.** Everything is analysis and paper trading.

Last updated: 16 November 2026.

---

## Read this first

Ten strategies have been tested in this app on Indian stocks with real charges. **None has shown a profit after charges.** Independent research done for this project found no published, after-charges proof for any intraday strategy on Indian stocks either, and SEBI's own study found 71% of individual intraday traders lost money in FY2023.

So the app's proven value today is discipline and honest measurement: it stops bad trades and tells you plainly when a strategy does not work. It does not hand you a winning strategy.

---

## The four pages

Run the app (`npx next dev -p 3000`) and open http://localhost:3000.

### 1. Trading desk — `/desk`

Six agents run one after another and produce a full report in about ten seconds. You enter how much you are trading with today, the most you will lose on one trade, your stop for the day, margin, and how many stocks to analyse.

| Agent | What it does |
|---|---|
| Market scanner | Ranks about 218 liquid stocks by today's move × unusual volume and keeps the ones your money can buy |
| Technical analyst | Reads each chart (day's average price, RSI, MACD, EMA 9/20/50/200, yesterday's high and low, opening range, volume) and says leaning up, leaning down, sideways or no trade, with a score from −100 to +100 |
| News analyst | Pulls headlines from the last 48 hours, marks each positive, negative or neutral, rates the likely impact, and labels it official filing, news report or unverified |
| Trade strategist | Writes the plan: entry and entry zone, stop loss, up to three targets, number of shares, money needed, most you can lose, reward per rupee risked, charges, when to enter, when the idea is wrong, when to exit |
| Time machine | Replays the same entry on past sessions and runs 2,000 simulated price paths built from the stock's own 5-minute history. Reports the share that hit the target, hit the stop, or neither; average and median result; best and worst; eight what-if scenarios; and the chance of hitting your daily stop |
| Risk manager | Has the final say. Runs about sixteen checks and rejects the trade if any one fails |

Each stock ends as **BUY CANDIDATE**, **SELL CANDIDATE** or **NO TRADE**, with every reason shown as a tick or a cross. Approved candidates have a "Paper trade" button. A "Today so far" box shows trades taken, wins, losses, net result and whether you are locked out for the day.

### 2. Today's signals — `/scan`

The quick daily screen. It opens, scans on its own, and refreshes every minute while the market is open.

- Shows only stocks you can afford that are moving. With ₹1,000 and no margin that means stocks up to ₹500; with 5× margin, up to ₹2,500.
- Runs the selected strategies on the most active stocks and shows at most three cards up front.
- Every card leads with a verdict: **Worth taking**, **Wait** or **Skip**, followed by a tick-and-cross list of reasons with real numbers.
- "Lose" and "make" amounts already include brokerage and taxes.
- When the market is closed it shows a watchlist for the next session instead.
- You can switch from "Most active today" to your own fixed watchlist in settings.

### 3. Test a strategy — `/`

Backtest one strategy on one stock.

- Pick a stock, a strategy, 5-minute, 15-minute or daily bars, and a date range. With Upstox connected, 5-minute history goes back to January 2022.
- The result opens with a one-line verdict ("Loses money after costs", "Marginal edge", "Too few trades to trust", "Profitable in this backtest"), then four headline numbers, a chart with every trade marked, and the equity curve.
- Collapsed sections hold the best and worst days, hours and weekdays, a month-by-month table, and the full trade list.
- Advanced settings: strategy parameters, risk per trade, slippage, square-off time, entry window, maximum trades per day, daily loss cut-off, margin, and moving the stop to break-even.

### 4. Find what works — `/finder`

Searches many parameter settings across several stocks, and is built to resist fooling itself.

- Splits the data into three slices: one to tune, one to rank, and one that is never used for either. The verdict shown comes only from that untouched slice.
- Ranks by a score that is pulled towards zero when there are few trades, so five lucky trades cannot beat forty steady ones.
- States how many combinations were tried, because with thousands of tries some will look good by luck.
- Warns when there is too little data to conclude anything.

---

## The rules it enforces

These apply on the live screens and to every paper trade. They are fixed in code, not suggestions.

**Account-level**

| Rule | Value |
|---|---|
| New trades only between | 09:30 and 14:45 IST |
| Everything closed by | 15:05 (Upstox force-closes at 15:10 and charges about ₹88) |
| Maximum trades a day | 3 |
| Stop for the day after losing | 2% of your capital |
| Stop after consecutive losses | 2 in a row |
| Wait before re-trading a stock that hit your stop | 30 minutes |

**Per trade**

| Rule | Value |
|---|---|
| Stop loss | Required, and at least 0.35% away from entry |
| Reward after charges | At least 1.5 times the risk |
| Chasing | Rejected if price has already run more than 0.3 of the stop distance in your favour, or 0.5 against |
| Signal age | A new signal expires after 90 seconds on 5-minute bars, 180 on 15-minute |
| Affordability | Must be able to buy at least 2 shares; stocks under ₹20 are excluded |
| Direction | In "most active" mode, signals against a stock that has moved 1.5% or more today are held back |
| Track record | A strategy counts as proven only with 30 or more recent trades and a positive average result across today's stocks |

Limits are fractions of the capital you set. They do not loosen after a profitable day.

---

## Charges

All results use Upstox's equity intraday rate card as published in November 2026:

- Brokerage: ₹20 per order or 0.1%, whichever is lower
- STT: 0.025% on the sell side
- NSE transaction charge: 0.00307% each side
- SEBI fee: ₹10 per crore
- Stamp duty: 0.003% on the buy side
- GST: 18% on brokerage, transaction charge and SEBI fee
- Slippage: 0.05% per fill, doubled on stop-loss exits

On a small trade this comes to about **0.27% of the position per round trip**. With ₹1,000 and a 0.5% stop, you need to win more than half your trades just to break even.

---

## Strategies included

| Id | Name | Tested result |
|---|---|---|
| `orb` | Opening Range Breakout | Lost on all 20 stocks over 18 months |
| `orb-rvol` | Opening range breakout on unusual volume | Lost: −₹69,486 on 408 trades at ₹1,00,000; the volume filter did not improve the result per trade |
| `vwap-reclaim` | VWAP Reclaim | Lost in recent-weeks scans |
| `mtf-trend` | Multi-timeframe trend with lower-timeframe entry | Lost in recent-weeks scans |
| `supertrend` | Supertrend Flip | Lost in recent-weeks scans |
| `ema-cross` | EMA Crossover | Lost in backtests |
| `rsi-reversion` | RSI Mean Reversion | Not profitable; off by default for moving stocks |
| `bb-reversion` | Bollinger Reversion | Not profitable; off by default for moving stocks |
| `order-block` | Order Block Retest | Not profitable; off by default |
| `swing-fade` | Swing exhaustion fade (ported from a TradingView script) | Coded and registered; its test on Indian data was interrupted and has no result yet |

The full `orb-rvol` test is the most rigorous: 20 liquid stocks, 5-minute Upstox data from May 2025 to November 2026, 375 trading days each.

---

## Paper trading

- Pressing "Paper trade" records the trade in a local ledger. No order goes to any broker unless an Upstox sandbox token is configured, and the sandbox never involves real money.
- Entry is filled slightly worse than the shown price, to mimic real slippage.
- The app then follows the price and closes the trade at the stop, the target, or 15:05, whichever comes first. If the stop and target both fall inside one bar it assumes the stop was hit.
- Results are after brokerage and taxes.
- Margin of 1×, 2×, 3× or 5× can be chosen; it changes how many shares you can buy, not the loss limit per trade.

---

## Where the data comes from

| Data | Source |
|---|---|
| Live prices and today's candles | Upstox, when connected |
| 5-minute and 15-minute history back to 2022 | Upstox, saved on disk month by month so each month downloads once |
| Daily history | Yahoo Finance |
| Fallback when Upstox is unavailable | Yahoo Finance, delayed 1–15 minutes and limited to about 60 days of intraday data |
| List of liquid stocks | About 218 NSE stocks that have futures, from Upstox's public instrument file |
| News | Google News headlines from the last 48 hours |

The screen always says whether prices are live or delayed.

**Upstox rate limits.** The candle service locks the account out for five minutes if hit with a burst. The app paces candle requests at two a second, downloads history one request every 1.2 seconds, ranks the whole 218-stock pool with a single quote request, and stops calling Upstox when told to wait.

---

## Setup

1. `npm install`
2. Create `.env.local` in the project root. It is ignored by git.

   ```
   # Read-only access token for prices. Used for data only, never for orders.
   UPSTOX_ACCESS_TOKEN=

   # Optional: log in through the browser instead of pasting a token.
   UPSTOX_API_KEY=
   UPSTOX_API_SECRET=
   # UPSTOX_REDIRECT_URI=http://localhost:3000/api/upstox/callback

   # Optional: also send each paper trade to the Upstox sandbox (no real money).
   # UPSTOX_SANDBOX_TOKEN=
   ```

3. `npx next dev -p 3000` and open http://localhost:3000

Without any Upstox settings the app still runs, on delayed Yahoo prices.

Checks: `npx tsc --noEmit`, `npx eslint src`, `npx vitest run` (run vitest from PowerShell; it misbehaves under Git Bash on this machine).

---

## How the code is laid out

```
src/app/                 Pages and API routes
  desk/  scan/  finder/  page.tsx (backtest)
  api/desk  api/scan  api/backtest  api/finder  api/paper  api/candles  api/upstox/*
src/components/          One component per page, plus shared form and chart pieces
src/lib/
  backtest/              The engine, the charges model, metrics, day-and-hour statistics
  strategies/            The ten strategies
  optimizer/             The Finder's three-slice search and ranking
  scan/                  Stock ranking, affordability, live signals, the Take / Wait / Skip verdict
  desk/                  The six agents and the orchestrator
  paper/                 Paper-trade rules, settlement and ledger
  data/                  Upstox and Yahoo clients, the history store, live price selection
  research/              Order-book maths for the unfinished order-flow study
scripts/                 record-depth.mjs — order-book recorder (unfinished study)
.cache/                  Downloaded candles, the paper ledger, instrument lists (ignored by git)
```

API routes, all local:

| Route | Purpose |
|---|---|
| `POST /api/desk` | Run all six agents and return the full report |
| `POST /api/scan` | Live signals for the most active stocks or a watchlist |
| `POST /api/backtest` | One strategy on one stock |
| `POST /api/finder` | Parameter search with the three-slice test |
| `GET / POST /api/paper` | Read the paper ledger; place, close or clear paper trades |
| `GET /api/candles` | Candles for one stock |
| `GET /api/upstox/status`, `/login`, `/callback` | Upstox connection |
| `GET /api/strategies`, `/api/symbols` | Lists for the forms |

---

## What is not built, or not finished

- **Live order placement.** Deliberately absent.
- **AI language model.** News sentiment uses keyword rules, not an AI service.
- **Official exchange filings.** News comes from Google News only; NSE and BSE announcements and RBI notices are not read directly.
- **Sector strength, correlated positions, bid-ask spread checks.** Not in the risk manager.
- **Exchange holidays.** "Market open" is judged by the clock, Monday to Friday.
- **Three research studies were started and interrupted, and have no results yet:**
  - the test of the "Swing exhaustion fade" TradingView script on Indian data;
  - the order-book recorder and analyser, to measure whether order imbalance predicts price;
  - the multi-day study of momentum, short-term reversal, overnight returns and candlestick patterns over about eight years.
- **Database, cloud deployment, Docker.** The app runs on your own computer and stores everything in files under `.cache/`.

## Known limits

- The live cards and the paper-trade button on the Trading desk have only been seen with the market closed; a live approved candidate has not been observed yet.
- The time machine's percentages are simulated from the stock's own past moves. They are estimates, not promises.
- Backtests of fixed stock lists use today's list of liquid stocks, which flatters long-history results slightly.
- With very small capital (around ₹1,000) charges dominate, and many stocks cannot be sized small enough to respect a 1% loss limit. The app will reject those trades rather than bend the rule.
- Nothing here is investment advice.
