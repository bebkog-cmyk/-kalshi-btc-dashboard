# BTC 15m Edge Lab

A mobile-friendly, view-only dashboard for Kalshi's `KXBTC15M` Bitcoin Up/Down markets.

## What it shows

- Automatically selects the current open 15-minute BTC contract
- Displays the target, countdown, actionable UP/DOWN asks, and target distance
- Estimates probability from recent one-minute BTC volatility with restrained momentum
- Compares the probability with Kalshi's ask price
- Defaults to **NO TRADE** unless raw estimated edge is at least 8 percentage points
- Blocks new signals during the final settlement minute
- Keeps a local journal and exports it as CSV
- Attempts to grade saved calls after markets settle

## Important limitation

Kalshi settles this series from the average of 60 CF Benchmarks RTI readings in the final minute. The exact CF feed requires authenticated Kalshi access and an eligible account. This first version uses Coinbase BTC-USD as a proxy, or a manually entered CF/Kalshi price.

It places no orders, stores no Kalshi credentials, and is an experimental measurement tool—not proof of a profitable strategy or financial advice.

## Data sources

- Kalshi public Trade API: market details and quotes
- Coinbase Exchange public API: BTC proxy price and one-minute candles
