# 📈 Graphite — Signal Analysis Agent

An interactive web-based **investment signal tool** that pulls live Yahoo Finance
data for a stock or fund and produces a **Buy / Hold / Sell** signal with clear,
explainable reasoning — all rendered in the browser.

> ⚠️ **Note:** Signals are derived from a transparent, documented heuristic
> (see `script.js`) applied to real market data. This is not a research-grade
> model and is **not financial advice**.

---

## ✨ Features

🔍 **Live Analysis Engine**
- Pulls real quote data from Yahoo Finance (price, PE, moving averages, beta, analyst rating)
- Scores valuation, momentum, sentiment, and risk from that data using documented formulas
- Long-term & short-term horizon support, each with different factor weighting
- Clear Buy / Hold / Sell signal with a confidence score

🎨 **Premium UI / UX**
- Dark graphite / grey theme
- Glassmorphism & subtle motion
- Smooth state transitions
- Responsive (desktop & mobile)

⚡ **Frontend + one thin proxy**
- HTML / CSS / vanilla JS — no frameworks
- One small Cloudflare Worker (`/cloudflare-worker`) proxies Yahoo Finance, since
  Yahoo doesn't allow direct browser requests (no CORS headers). It forwards
  requests unchanged and adds nothing — all analysis logic stays in `script.js`.

🧠 **Explainable Output**
- Confidence meter
- Factor-by-factor breakdown
- Human-readable reasoning tied to the actual scores, not generic filler

---

## 🔧 Setup

1. Deploy the Yahoo Finance proxy — see `cloudflare-worker/README.md`.
2. Set `YAHOO_PROXY_BASE` in `script.js` to your deployed Worker URL.
3. Open `index.html` in a browser (or serve the folder statically).

---

## 🖥️ Demo Preview

> _(Optional: add screenshots or GIFs here)_

```text
[ Screenshot / GIF Placeholder ]
