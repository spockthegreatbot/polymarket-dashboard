# PolyIntel — Polymarket Intelligence Dashboard

A visual command center for browsing betting opportunities on Polymarket. Dark-themed, Bloomberg-terminal-inspired dashboard with real-time market data.

![Dashboard](https://img.shields.io/badge/Status-Live-brightgreen)

## Features

- **6 Intelligence Columns**: Don't Miss, High Risk High Reward, Safe Plays, Closing Soon, Trending, Whale Moves
- **Real-time data**: Auto-refresh every 60s from Polymarket Gamma API
- **Smart categorization**: Auto-categorizes markets (Politics, Sports, Crypto, etc.)
- **Edge scoring**: Computed edge score based on volume, liquidity, and odds
- **Search & filter**: Full-text search (⌘K), category tabs, sort options
- **Watchlist**: Star markets to track them
- **Trader Queue**: Queue markets to send to your trading agent
- **Dark/Light mode**: Toggle between dark glassmorphism and light themes
- **Responsive**: Works on desktop and mobile

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Browser     │────▶│  server.js :8877  │────▶│  Polymarket API  │
│  index.html  │◀────│  Express + Cache  │◀────│  gamma-api       │
└─────────────┘     └──────────────────┘     └──────────────────┘
```

- **Frontend**: Single HTML file, vanilla JS, no build tools
- **Backend**: Node.js Express server, 30s API cache, smart data enrichment
- **No database**: Everything computed on-the-fly

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/polymarket-dashboard.git
cd polymarket-dashboard
npm install
npm start
# Open http://localhost:8877
```

## Deploy on VPS

```bash
chmod +x setup.sh
./setup.sh
```

This will:
1. Install dependencies
2. Create a systemd service (`polyintel`)
3. Start the dashboard on port 8877

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/markets` | All active markets (supports `?search=`, `?category=`, `?sort=`, `?limit=`) |
| `GET /api/columns` | Pre-categorized markets in 6 columns |
| `GET /api/market/:id` | Single market details |
| `GET /api/trending` | Markets with biggest 24h price moves |
| `GET /api/closing-soon` | Markets ending within 48h |
| `GET /api/whales` | Markets with unusual volume activity |
| `GET /api/stats` | Dashboard-level statistics |

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS, Inter font, CSS glassmorphism
- **Backend**: Node.js, Express, node-fetch
- **Data**: Polymarket Gamma API (free, no auth required)
- **Deploy**: systemd on VPS, static HTML anywhere

## License

MIT
