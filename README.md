# memedesk

Autonomous Solana memecoin desk. Six agents, hard hand-offs, capital preservation first.
Paper by default. Live only after paper results clear the go-live bar.

```
SCOUT ──lead──▶ FILTER ──ticket──▶ ANALYST ──ticket──▶ EXECUTOR ──position──▶ RISK
                                                          ▲                     │
                                                          └────exit order───────┘
                         every decision, with its reason ──▶ LOGGER
```

| Seat | Owns | Never |
|---|---|---|
| **SCOUT** | Streams every pump.fun launch (dev history), every graduation to PumpSwap, every new Raydium AMM v4 / CPMM SOL pool | judges or trades |
| **FILTER** | Kills on: mint not revoked · freeze not revoked · LP < 95% locked · top-10 > 20% (pools/burn excluded) · < $50k volume last hour · dev tied to rugs | scores or trades |
| **ANALYST** | Scores survivors 0–1 from six logged components. < 0.6 = no trade | sizes or trades |
| **EXECUTOR** | The only seat with wallet access. Buys only with a valid Analyst ticket → valid Filter ticket, fresh data, and Risk's OK. Max 8% of balance | has opinions |
| **RISK** | -6% hard stop · trail arms at +12% · no averaging down · no revenge trades · loss-streak cooldown · daily halt | picks tokens or signs |
| **LOGGER** | Reason for every trade and rejection · tracks what refused tokens did next · auto-blacklists devs whose pools get pulled · morning recap | — |

## Hard limits (in code, can only be tightened)
- Position size ≤ **8%** of current free SOL (also ≤ 1.5% of pool liquidity)
- Hard stop **-6%** from cost basis (fees included). On a gap, fills can land past -6% — memecoins gap.
- Trailing stop arms only after **+12%**, then exits 6% below the peak (`TRAIL_DISTANCE_PCT`)
- Analyst score ≥ **0.6**
- Any missing data = fail. No data is never a yes.

## Extra guards I added
- Freeze authority must be revoked (an active freeze authority can stop you selling)
- Pump.fun tokens are only tradeable after graduation (no LP exists on the bonding curve, so they can't pass the LP rule)
- Dev check = local rug history + RugCheck flag + serial-launcher (≥3 launches/72h) + shared funder with known ruggers
- Max 3 open positions · cooldown after 2–3 straight losses · token that stopped you out banned 24h · -12% day halts new entries
- Exits if pool liquidity drops 40%+ or price data goes dark for 3 minutes

## Commands
```
./install.sh      one-time setup on the server
./desk doctor     check every data source
./desk start      run 24/7 (systemd, survives reboots)
./desk terminal   live view — q quits the view, desk keeps running
./desk recap      recap now (auto-generated daily at RECAP_HOUR, sent to Telegram if set)
./desk audit      replays the logs and proves every rule held
./desk golive     paper → live readiness
```

## Going live
`./desk golive` must pass: 72h+ of paper, 40+ closed trades, profit factor ≥ 1.2, max drawdown ≤ 15%, zero violations.
Then in `.env`: `MODE=live`, `WALLET_PRIVATE_KEY=<fresh wallet>`, `LIVE_CONFIRM=I_ACCEPT_REAL_LOSSES`, and `./desk restart`.
The desk refuses to start live otherwise.

## Files
- `logs/<day>/decisions.jsonl` — every decision from every agent with its reason and the data behind it
- `logs/<day>/trades.csv` — every closed trade with entry and exit reasons
- `logs/outcomes.jsonl` — what each refused/traded token did over the next 24h
- `recaps/` — morning recaps
- `data/blacklist.txt` — add known rugger wallets by hand
