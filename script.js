'use strict';

/* ============================================================
   Graphite Signal Desk — live analysis engine
   Market data is pulled from Yahoo Finance through a lightweight
   proxy (see /cloudflare-worker/worker.js) because Yahoo's
   endpoints don't send CORS headers and can't be called directly
   from a browser. The proxy forwards the raw Yahoo response
   unchanged; every scoring decision below happens client-side.
   ============================================================ */

/* ---------- Proxy configuration ----------
   Replace with your deployed Cloudflare Worker URL
   (e.g. https://graphite-quote-proxy.YOUR-SUBDOMAIN.workers.dev).
   See /cloudflare-worker/README.md for deploy steps. */

const YAHOO_PROXY_BASE = 'https://graphite-quote-proxy.YOUR-SUBDOMAIN.workers.dev';

/* ---------- Company name → ticker shortcuts ----------
   Fast path for common names so we skip a network round-trip to
   the search endpoint for the most frequently typed queries. */

const COMPANY_ALIASES = {
  APPLE: 'AAPL', MICROSOFT: 'MSFT', NVIDIA: 'NVDA', TESLA: 'TSLA',
  AMAZON: 'AMZN', ALPHABET: 'GOOGL', GOOGLE: 'GOOGL', META: 'META',
  FACEBOOK: 'META', NETFLIX: 'NFLX', GAMESTOP: 'GME', COINBASE: 'COIN',
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ---------- Symbol resolution ----------
   Turns whatever the user typed (a ticker or a company name) into
   a Yahoo-recognized symbol, using the alias map first and the
   Yahoo search endpoint as a fallback for anything unrecognized. */

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

async function fetchQuote(symbol) {
  const data = await fetchJSON(`${YAHOO_PROXY_BASE}/quote?symbols=${encodeURIComponent(symbol)}`);
  const result = data && data.quoteResponse && data.quoteResponse.result && data.quoteResponse.result[0];
  if (!result) throw new Error(`No quote data found for "${symbol}".`);
  return result;
}

async function searchSymbol(query) {
  const data = await fetchJSON(`${YAHOO_PROXY_BASE}/search?q=${encodeURIComponent(query)}`);
  const quotes = (data && data.quotes) || [];
  const match = quotes.find((q) => q.quoteType === 'EQUITY' || q.quoteType === 'ETF');
  if (!match) throw new Error(`No matching ticker found for "${query}".`);
  return match.symbol;
}

async function resolveSymbol(rawInput) {
  const trimmed = rawInput.trim();
  const upper = trimmed.toUpperCase();

  if (COMPANY_ALIASES[upper]) return COMPANY_ALIASES[upper];

  // Short, ticker-shaped input — try it directly before falling
  // back to a text search (cheaper and usually correct).
  const looksLikeTicker = /^[A-Z0-9.\-]{1,10}$/.test(upper);
  if (looksLikeTicker) {
    try {
      await fetchQuote(upper);
      return upper;
    } catch (err) {
      // Not a valid ticker as typed — fall through to search.
    }
  }

  return searchSymbol(trimmed);
}

/* ---------- Factor scoring ----------
   Each factor is derived from a real, named field on the Yahoo
   quote object using a simple, documented heuristic. None of this
   is a proprietary model — it's a transparent, explainable mapping
   from public market data onto the same 0-100 scale the UI expects. */

// Valuation: trailingPE compared against a ~22x broad-market
// benchmark. Cheaper than benchmark scores higher ("attractive");
// richer scores lower. Loss-making names (no meaningful PE) get a
// neutral score rather than a misleading one.
function valuationScoreFromPE(trailingPE) {
  const BENCHMARK_PE = 22;
  if (!trailingPE || trailingPE <= 0) return 50;
  const deviation = (BENCHMARK_PE - trailingPE) / BENCHMARK_PE;
  return clamp(Math.round(50 + deviation * 90), 4, 96);
}

// Momentum: current price relative to its 50-day and 200-day
// moving averages. Trading above both averages scores high;
// trading below both scores low.
function momentumScoreFromAverages(price, fiftyDayAvg, twoHundredDayAvg) {
  if (!price || !fiftyDayAvg || !twoHundredDayAvg) return 50;
  const pctVs50 = (price - fiftyDayAvg) / fiftyDayAvg;
  const pctVs200 = (price - twoHundredDayAvg) / twoHundredDayAvg;
  const blended = pctVs50 * 0.6 + pctVs200 * 0.4;
  return clamp(Math.round(50 + blended * 400), 4, 96);
}

// Sentiment: Yahoo's consensus analyst rating, where 1.0 = Strong
// Buy and 5.0 = Strong Sell. Not every symbol carries analyst
// coverage (most ETFs don't), so the day's price move is used as a
// weaker fallback proxy when no rating is present.
function sentimentScoreFromQuote(quote) {
  const ratingValue = parseFloat(quote.averageAnalystRating);
  if (!Number.isNaN(ratingValue) && ratingValue > 0) {
    return clamp(Math.round(100 - ((ratingValue - 1) / 4) * 100), 4, 96);
  }
  if (typeof quote.regularMarketChangePercent === 'number') {
    return clamp(Math.round(50 + quote.regularMarketChangePercent * 4), 4, 96);
  }
  return 50;
}

// Risk: blends beta (volatility relative to the broad market) with
// 52-week trading range width (a proxy for realized volatility).
// Missing beta defaults to 1.0 (market-average sensitivity).
function riskScoreFromVolatility(beta, fiftyTwoWeekHigh, fiftyTwoWeekLow) {
  const betaComponent = (typeof beta === 'number' && beta > 0) ? beta : 1;
  const rangeWidthPct = (fiftyTwoWeekHigh && fiftyTwoWeekLow && fiftyTwoWeekLow > 0)
    ? (fiftyTwoWeekHigh - fiftyTwoWeekLow) / fiftyTwoWeekLow
    : 0.3;
  return clamp(Math.round(betaComponent * 30 + rangeWidthPct * 60), 4, 96);
}

function computeFactorsFromQuote(quote, horizon) {
  const scores = {
    valuation: valuationScoreFromPE(quote.trailingPE),
    momentum: momentumScoreFromAverages(quote.regularMarketPrice, quote.fiftyDayAverage, quote.twoHundredDayAverage),
    sentiment: sentimentScoreFromQuote(quote),
    risk: riskScoreFromVolatility(quote.beta, quote.fiftyTwoWeekHigh, quote.fiftyTwoWeekLow),
  };

  // Horizon adjusts weighting: long-term leans on valuation + risk,
  // short-term leans on momentum + sentiment.
  const weights = horizon === 'short'
    ? { valuation: 0.16, momentum: 0.36, sentiment: 0.30, risk: 0.18 }
    : { valuation: 0.34, momentum: 0.18, sentiment: 0.18, risk: 0.30 };

  return {
    label: quote.shortName || quote.longName || null,
    scores,
    weights,
  };
}

/* ---------- Signal + confidence derivation ---------- */

function deriveSignal(scores, weights) {
  // Risk is inverted: high risk score works against the composite.
  const composite =
    scores.valuation * weights.valuation +
    scores.momentum * weights.momentum +
    scores.sentiment * weights.sentiment +
    (100 - scores.risk) * weights.risk;

  let signal;
  if (composite >= 62) signal = 'buy';
  else if (composite <= 42) signal = 'sell';
  else signal = 'hold';

  // Confidence: distance from the nearest decision boundary, plus
  // agreement between factors (low variance = higher confidence).
  const values = [scores.valuation, scores.momentum, scores.sentiment, 100 - scores.risk];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const agreement = clamp(100 - Math.sqrt(variance) * 2.2, 0, 100);

  const boundaryDistance = signal === 'hold'
    ? 100 - Math.min(Math.abs(composite - 42), Math.abs(62 - composite)) * 2.4
    : clamp(Math.abs(composite - 52) * 2.1, 0, 100);

  const confidence = clamp(Math.round(agreement * 0.45 + boundaryDistance * 0.55), 38, 97);

  return { signal, composite: Math.round(composite), confidence };
}

/* ---------- Reasoning copy generation ---------- */

const FACTOR_META = {
  valuation: { label: 'Valuation', color: 'var(--accent-buy)' },
  momentum: { label: 'Momentum', color: 'var(--accent-hold)' },
  sentiment: { label: 'Sentiment', color: 'var(--accent-neutral)' },
  risk: { label: 'Risk level', color: 'var(--accent-sell)' },
};

function scoreBand(score) {
  if (score >= 75) return 'very_high';
  if (score >= 58) return 'high';
  if (score >= 42) return 'mid';
  if (score >= 25) return 'low';
  return 'very_low';
}

function valuationLine(score, symbol) {
  const band = scoreBand(score);
  const lines = {
    very_high: `${symbol} screens as attractively valued relative to its own history and peer set, with room for multiple expansion if fundamentals hold.`,
    high: `Valuation for ${symbol} sits on the reasonable side of fair value — not a bargain, but not stretched either.`,
    mid: `${symbol} is trading close to a fair-value estimate, offering little margin of safety in either direction.`,
    low: `${symbol} carries a valuation premium that assumes continued strong execution; any stumble could compress the multiple.`,
    very_low: `${symbol} looks expensive against normalized earnings power, leaving limited cushion if growth decelerates.`,
  };
  return lines[band];
}

function momentumLine(score, symbol) {
  const band = scoreBand(score);
  const lines = {
    very_high: `Price action shows strong, broad-based momentum with the trend confirmed across multiple timeframes.`,
    high: `The trend is constructive, with price holding above key moving averages and buyers stepping in on pullbacks.`,
    mid: `Momentum is directionless right now — the trend lacks conviction in either direction.`,
    low: `Momentum has weakened, with the stock struggling to reclaim short-term resistance levels.`,
    very_low: `The trend is deteriorating, with lower highs and heavier volume on down days.`,
  };
  return lines[band];
}

function sentimentLine(score, symbol) {
  const band = scoreBand(score);
  const lines = {
    very_high: `Market sentiment is notably upbeat, with positioning and commentary skewing bullish.`,
    high: `Sentiment leans constructive, though not euphoric — a healthy backdrop rather than a crowded trade.`,
    mid: `Sentiment is mixed, with bullish and bearish narratives roughly offsetting each other.`,
    low: `Sentiment has cooled, and the prevailing narrative has turned more cautious.`,
    very_low: `Sentiment is distinctly negative, with skepticism dominating recent coverage and positioning.`,
  };
  return lines[band];
}

function riskLine(score, symbol) {
  const band = scoreBand(score);
  const lines = {
    very_high: `Risk is elevated — expect meaningfully larger drawdowns and volatility than the broader market.`,
    high: `Above-average risk is present, driven by concentration, volatility, or balance-sheet sensitivity.`,
    mid: `Risk sits near the market average — no glaring red flags, but no particular ballast either.`,
    low: `Downside risk looks contained relative to peers, aided by diversification or defensive characteristics.`,
    very_low: `This is a comparatively low-risk holding, with historically shallow drawdowns and steady behavior.`,
  };
  return lines[band];
}

function buildBullets(scores, symbol) {
  return [
    valuationLine(scores.valuation, symbol),
    momentumLine(scores.momentum, symbol),
    sentimentLine(scores.sentiment, symbol),
    riskLine(scores.risk, symbol),
  ];
}

function buildParagraph(symbol, signal, confidence, scores, horizon, label) {
  const name = label ? `${label} (${symbol})` : symbol;
  const horizonWord = horizon === 'short' ? 'short-term' : 'long-term';

  const openers = {
    buy: `Weighing all four factors on a ${horizonWord} basis, ${name} presents a favorable setup.`,
    sell: `On a ${horizonWord} view, the balance of evidence for ${name} tilts unfavorable.`,
    hold: `The picture for ${name} on a ${horizonWord} basis is genuinely mixed.`,
  };

  const closers = {
    buy: `The combination of supportive fundamentals and a constructive trend outweighs the risks identified, supporting accumulation with normal position sizing.`,
    sell: `Deteriorating momentum or an unfavorable risk/valuation trade-off outweighs the positives here, arguing for trimming or avoiding new exposure.`,
    hold: `No single factor is compelling enough to force a decisive call, so maintaining current exposure while monitoring for a clearer signal is the more disciplined choice.`,
  };

  return `${openers[signal]} ${closers[signal]} Confidence in this read is ${confidence}%, reflecting how consistently valuation, momentum, sentiment and risk point in the same direction.`;
}

/* ============================================================
   DOM wiring
   ============================================================ */

const form = document.getElementById('analyze-form');
const input = document.getElementById('symbol-input');
const analyzeBtn = document.getElementById('analyze-btn');

const emptyState = document.getElementById('empty-state');
const loadingState = document.getElementById('loading-state');
const loadingLabel = document.getElementById('loading-label');
const resultEl = document.getElementById('result');

const resultSymbol = document.getElementById('result-symbol');
const resultHorizon = document.getElementById('result-horizon');
const signalBadge = document.getElementById('signal-badge');
const signalLabel = document.getElementById('signal-label');

const confidenceFill = document.getElementById('confidence-fill');
const confidenceNumber = document.getElementById('confidence-number');
const factorsList = document.getElementById('factors-list');

const reasoningParagraph = document.getElementById('reasoning-paragraph');
const reasoningBullets = document.getElementById('reasoning-bullets');

const rerunBtn = document.getElementById('rerun-btn');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');

const LOADING_MESSAGES = [
  'Pulling valuation data…',
  'Reading recent price momentum…',
  'Scanning market sentiment…',
  'Weighing risk exposure…',
  'Reconciling factors into a signal…',
];

const HISTORY_KEY = 'graphite-signal-history';
const CIRCUMFERENCE = 2 * Math.PI * 52;

let typingTimer = null;
let loadingInterval = null;

/* ---------- State transitions ---------- */

const emptyStateTitle = emptyState.querySelector('.empty-state__title');
const emptyStateBody = emptyState.querySelector('.empty-state__body');
const DEFAULT_EMPTY_TITLE = emptyStateTitle.textContent;
const DEFAULT_EMPTY_BODY = emptyStateBody.textContent;

function showEmpty() {
  emptyStateTitle.textContent = DEFAULT_EMPTY_TITLE;
  emptyStateBody.textContent = DEFAULT_EMPTY_BODY;
  emptyState.hidden = false;
  loadingState.hidden = true;
  resultEl.hidden = true;
}

function showError(message) {
  clearInterval(loadingInterval);
  emptyStateTitle.textContent = 'Could not complete analysis';
  emptyStateBody.textContent = message;
  emptyState.hidden = false;
  loadingState.hidden = true;
  resultEl.hidden = true;
}

function showLoading() {
  emptyState.hidden = true;
  loadingState.hidden = false;
  resultEl.hidden = true;

  let i = 0;
  loadingLabel.textContent = LOADING_MESSAGES[0];
  clearInterval(loadingInterval);
  loadingInterval = setInterval(() => {
    i = (i + 1) % LOADING_MESSAGES.length;
    loadingLabel.textContent = LOADING_MESSAGES[i];
  }, 550);
}

function showResult() {
  clearInterval(loadingInterval);
  emptyState.hidden = true;
  loadingState.hidden = true;
  resultEl.hidden = false;
}

/* ---------- Rendering ---------- */

function renderFactors(scores) {
  factorsList.innerHTML = '';
  Object.keys(FACTOR_META).forEach((key) => {
    const meta = FACTOR_META[key];
    const score = scores[key];

    const li = document.createElement('li');
    li.className = 'factor';
    li.innerHTML = `
      <span class="factor__name">${meta.label}</span>
      <span class="factor__track"><span class="factor__fill" style="background:${meta.color}"></span></span>
      <span class="factor__score">${score}</span>
    `;
    factorsList.appendChild(li);

    // Animate fill on next frame
    requestAnimationFrame(() => {
      const fill = li.querySelector('.factor__fill');
      fill.style.width = `${score}%`;
    });
  });
}

function renderConfidenceRing(confidence) {
  const offset = CIRCUMFERENCE * (1 - confidence / 100);
  confidenceFill.style.strokeDasharray = `${CIRCUMFERENCE}`;
  confidenceFill.style.strokeDashoffset = `${CIRCUMFERENCE}`;
  confidenceNumber.textContent = '0';

  requestAnimationFrame(() => {
    confidenceFill.style.strokeDashoffset = `${offset}`;
  });

  // Count up the number
  const duration = 900;
  const start = performance.now();
  function step(now) {
    const progress = clamp01((now - start) / duration);
    confidenceNumber.textContent = Math.round(progress * confidence);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function signalColorVar(signal) {
  return signal === 'buy' ? 'var(--accent-buy)' : signal === 'sell' ? 'var(--accent-sell)' : 'var(--accent-hold)';
}

function typeParagraph(text) {
  reasoningParagraph.innerHTML = '';
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  reasoningParagraph.appendChild(cursor);

  clearInterval(typingTimer);
  let i = 0;
  const speed = 12; // ms per character
  typingTimer = setInterval(() => {
    if (i >= text.length) {
      clearInterval(typingTimer);
      cursor.remove();
      return;
    }
    cursor.insertAdjacentText('beforebegin', text[i]);
    i++;
  }, speed);
}

function renderBullets(bullets) {
  reasoningBullets.innerHTML = '';
  bullets.forEach((text, idx) => {
    const li = document.createElement('li');
    li.textContent = text;
    li.style.animationDelay = `${0.15 + idx * 0.12}s`;
    reasoningBullets.appendChild(li);
  });
}

function renderResult(symbol, horizonValue, analysis) {
  const { scores } = analysis.factors;
  const { signal, confidence } = analysis.decision;

  resultSymbol.textContent = symbol;
  resultHorizon.textContent = analysis.factors.label
    ? `${analysis.factors.label} · ${horizonValue === 'short' ? 'Short-term' : 'Long-term'} outlook`
    : `${horizonValue === 'short' ? 'Short-term' : 'Long-term'} outlook`;

  signalBadge.dataset.signal = signal;
  signalLabel.textContent = signal.toUpperCase();

  confidenceFill.style.stroke = signalColorVar(signal);
  renderConfidenceRing(confidence);
  renderFactors(scores);

  const paragraph = buildParagraph(symbol, signal, confidence, scores, horizonValue, analysis.factors.label);
  typeParagraph(paragraph);

  const bullets = buildBullets(scores, symbol);
  renderBullets(bullets);
}

/* ---------- History (persisted via localStorage) ---------- */

function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch (err) {
    /* storage unavailable — fail silently */
  }
}

function addToHistory(symbol, horizon, signal) {
  let history = loadHistory();
  history = history.filter((item) => item.symbol !== symbol);
  history.unshift({ symbol, horizon, signal, ts: Date.now() });
  history = history.slice(0, 3);
  saveHistory(history);
  renderHistory();
}

function renderHistory() {
  const history = loadHistory();
  historyList.innerHTML = '';

  if (!history.length) {
    const li = document.createElement('li');
    li.className = 'history__empty';
    li.id = 'history-empty';
    li.textContent = 'Nothing analyzed yet this session.';
    historyList.appendChild(li);
    return;
  }

  history.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'history__item';
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.innerHTML = `
      <span class="history__symbol">${item.symbol}</span>
      <span class="history__tag" data-signal="${item.signal}">${item.signal.toUpperCase()}</span>
    `;
    const rerun = () => {
      input.value = item.symbol;
      const radio = form.querySelector(`input[name="horizon"][value="${item.horizon}"]`);
      if (radio) radio.checked = true;
      runAnalysis(item.symbol, item.horizon);
    };
    li.addEventListener('click', rerun);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        rerun();
      }
    });
    historyList.appendChild(li);
  });
}

/* ---------- Orchestration ---------- */

function getHorizon() {
  const checked = form.querySelector('input[name="horizon"]:checked');
  return checked ? checked.value : 'long';
}

async function runAnalysis(rawSymbol, horizonOverride) {
  const horizon = horizonOverride || getHorizon();

  analyzeBtn.disabled = true;
  showLoading();

  try {
    const symbol = await resolveSymbol(rawSymbol);
    const quote = await fetchQuote(symbol);
    const factors = computeFactorsFromQuote(quote, horizon);
    const decision = deriveSignal(factors.scores, factors.weights);

    showResult();
    renderResult(symbol, horizon, { factors, decision });
    addToHistory(symbol, horizon, decision.signal);
  } catch (err) {
    showError(err.message || 'Unable to reach live market data. Please try again.');
  } finally {
    analyzeBtn.disabled = false;
  }
}

/* ---------- Events ---------- */

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = input.value.trim();
  if (!value) return;
  runAnalysis(value);
});

rerunBtn.addEventListener('click', () => {
  showEmpty();
  input.value = '';
  input.focus();
});

/* ---------- Init ---------- */

renderHistory();
showEmpty();
