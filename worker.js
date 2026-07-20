/**
 * Graphite Signal Desk — Yahoo Finance proxy
 *
 * Yahoo Finance's public endpoints don't send CORS headers, so a
 * static frontend can't call them directly from the browser. This
 * Worker sits in between: it forwards two read-only Yahoo endpoints
 * and adds the CORS headers the browser needs. It does not add,
 * remove, or reinterpret any data — the frontend does all scoring.
 *
 * Routes:
 *   GET /quote?symbols=AAPL          → Yahoo v7/finance/quote
 *   GET /search?q=tesla              → Yahoo v1/finance/search
 *
 * Deploy (Cloudflare dashboard):
 *   1. Workers & Pages → Create → Create Worker
 *   2. Paste this file's contents into the editor, Deploy
 *   3. Copy the workers.dev URL into YAHOO_PROXY_BASE in script.js
 *
 * Deploy (Wrangler CLI):
 *   npm install -g wrangler
 *   wrangler login
 *   wrangler deploy worker.js --name graphite-quote-proxy
 */

const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v7/finance/quote';
const YAHOO_SEARCH_URL = 'https://query1.finance.yahoo.com/v1/finance/search';

// Tighten this to your deployed frontend's origin before going live
// (e.g. 'https://your-firm.github.io') to stop other sites from
// riding on your Worker's Yahoo requests.
const ALLOWED_ORIGIN = '*';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (request.method !== 'GET') {
      return jsonError('Method not allowed', 405);
    }

    try {
      if (url.pathname === '/quote') {
        return await handleQuote(url);
      }
      if (url.pathname === '/search') {
        return await handleSearch(url);
      }
      return jsonError('Not found', 404);
    } catch (err) {
      return jsonError('Upstream request to Yahoo Finance failed', 502);
    }
  },
};

async function handleQuote(url) {
  const symbols = url.searchParams.get('symbols');
  if (!symbols) return jsonError('Missing "symbols" query parameter', 400);

  const upstream = await fetch(`${YAHOO_QUOTE_URL}?symbols=${encodeURIComponent(symbols)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GraphiteSignalDesk/1.0)' },
  });

  if (!upstream.ok) return jsonError('Yahoo Finance quote lookup failed', upstream.status);
  const data = await upstream.json();
  return jsonResponse(data);
}

async function handleSearch(url) {
  const query = url.searchParams.get('q');
  if (!query) return jsonError('Missing "q" query parameter', 400);

  const upstream = await fetch(
    `${YAHOO_SEARCH_URL}?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GraphiteSignalDesk/1.0)' } }
  );

  if (!upstream.ok) return jsonError('Yahoo Finance search lookup failed', upstream.status);
  const data = await upstream.json();
  return jsonResponse(data);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}
