// Automated End-of-Day Recap for Alpha Trading Pro
//
// Runs on a schedule (see .github/workflows/eod-recap.yml). Reads today's
// tickers + levels from data/today-tickers.json (written by the newsletter
// tool when you hit "Post to Discord" each morning), pulls closing prices
// from Yahoo Finance, asks Claude to draft the recap in your voice, and
// posts it straight to Discord. No browser, no clicking required.

import { readFileSync } from 'fs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DISCORD_WEBHOOKS = (process.env.DISCORD_WEBHOOKS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY secret.');
  process.exit(1);
}
if (!DISCORD_WEBHOOKS.length) {
  console.error('Missing DISCORD_WEBHOOKS secret (comma-separated webhook URLs).');
  process.exit(1);
}

// ─── 1. Load today's tickers/levels saved by the newsletter tool ──────────
let data;
try {
  data = JSON.parse(readFileSync('data/today-tickers.json', 'utf8'));
} catch (e) {
  console.error('Could not read data/today-tickers.json — did the morning newsletter run today?');
  process.exit(1);
}

const todayET = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
if (data.date !== todayET) {
  console.log(`Skipping: data/today-tickers.json is dated ${data.date}, not today (${todayET}). No newsletter posted today — nothing to recap.`);
  process.exit(0);
}

const tickers = data.tickers || {};
const symbols = Object.keys(tickers);
if (!symbols.length) {
  console.log('No tickers found for today. Nothing to recap.');
  process.exit(0);
}

// ─── 2. Pull today's price action from Yahoo Finance ───────────────────────
// This tool's futures tickers use a leading slash (e.g. /ES); Yahoo Finance
// uses its own continuous-contract symbols instead. Map between the two.
const FUTURES_MAP = {
  '/BTC': 'BTC-USD',
  '/CL': 'CL=F',
  '/ES': 'ES=F',
  '/GC': 'GC=F',
  '/NQ': 'NQ=F',
  '/RTY': 'RTY=F',
  '/YM': 'YM=F'
};

async function fetchQuote(sym) {
  const ySym = sym.startsWith('/') ? (FUTURES_MAP[sym] || null) : sym;
  if (!ySym) return null;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=5m&range=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const closes = result.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
    const highs = result.indicators?.quote?.[0]?.high?.filter(v => v != null) || [];
    const lows = result.indicators?.quote?.[0]?.low?.filter(v => v != null) || [];

    return {
      price: meta.regularMarketPrice ?? closes[closes.length - 1] ?? null,
      prevClose: meta.previousClose ?? null,
      dayHigh: highs.length ? Math.max(...highs) : meta.regularMarketDayHigh,
      dayLow: lows.length ? Math.min(...lows) : meta.regularMarketDayLow
    };
  } catch (e) {
    console.error(`Quote fetch failed for ${sym}:`, e.message);
    return null;
  }
}

const quotes = {};
for (const sym of symbols) {
  quotes[sym] = await fetchQuote(sym);
  await new Promise(r => setTimeout(r, 250)); // be polite to Yahoo
}

// ─── 3. Work out hold/lose against each ticker's levels ────────────────────
function parseFirstNumber(str) {
  if (!str) return null;
  const m = String(str).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

function evaluateTicker(sym, levels, quote) {
  const pivot = parseFirstNumber(levels.pivot);
  const supply = parseFirstNumber(levels.supply);
  const demand = parseFirstNumber(levels.demand);
  const price = quote?.price ?? null;

  let status = 'unknown';
  if (price != null && pivot != null) {
    if (supply != null && price >= supply) status = 'reached_supply';
    else if (demand != null && price <= demand) status = 'lost_demand';
    else if (price >= pivot) status = 'held_pivot';
    else status = 'lost_pivot';
  }

  return { sym, levels, quote, status };
}

const evaluated = symbols.map(sym => evaluateTicker(sym, tickers[sym], quotes[sym]));

// ─── 4. Ask Claude to draft the recap in your voice ─────────────────────────
const dateLabel = new Date().toLocaleDateString('en-US', {
  timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric'
});

const tickerBlock = evaluated.map(t => {
  const q = t.quote;
  const priceStr = q?.price != null ? `$${q.price.toFixed(2)}` : 'N/A (no quote)';
  const hiStr = q?.dayHigh != null ? `$${q.dayHigh.toFixed(2)}` : 'N/A';
  const loStr = q?.dayLow != null ? `$${q.dayLow.toFixed(2)}` : 'N/A';
  return [
    `SYMBOL: ${t.sym}`,
    `emoji: ${t.levels.emoji || ''}`,
    `morning pivot: ${t.levels.pivot || 'N/A'}`,
    `morning supply (hold target): ${t.levels.supply || 'N/A'}`,
    `morning demand (lose target): ${t.levels.demand || 'N/A'}`,
    `close/current price: ${priceStr}`,
    `day high: ${hiStr} · day low: ${loStr}`,
    `status vs levels: ${t.status}`,
    `flow notes from this morning: ${(t.levels.flow || []).join(' | ') || 'none'}`
  ].join('\n');
}).join('\n\n');

const systemStyle = `You write end-of-day trading recaps for the Alpha Trading Pro Discord. Match this exact voice and format style (from a real morning post by the trader):

🔥 🍏 $AAPL rejected the mean yesterday this morning lets see if we can hold 309-311 cant we go to pivot and then we see
• 307.67 pivot
• Hold → 309.42-311.40 315-317.40 supply
• Lose → 305.02-302.07 demand
🐋 $2.8M CALL flow yesterday · $312.5C exp 8/24
🎯 29 unusual flows yesterday
📈 72% bullish premium flow

Rules:
- Casual trader shorthand, lowercase mid-sentence, minimal punctuation, like a real person typing fast between charts — NOT corporate or polished.
- Past tense for EOD (this already happened today), not future tense.
- Use "status vs levels" to say plainly whether it held, lost, or reached targets.
- Trade both directions. When a ticker lost its pivot or broke demand, call out the short setup, not just "it lost pivot" — e.g. what level a short would trigger below, or where it could retest from underneath. When it held pivot or reached supply, frame the long side the same way. Match how a real trader who plays both sides would talk, not a passive observer.
- Keep each ticker to 2-4 lines max: one line of commentary, then closing price + high/low, then hold/lose result with the actionable read (long or short).
- Use the same emoji style (🔥 for conviction, ticker-relevant emoji, 🐋 for flow, 🎯 for flow count) only when the source data is provided — never invent flow numbers or emojis not given to you.
- Do not invent numbers you were not given. If a quote is N/A, say "no quote available" for that ticker instead of guessing.`;

async function callClaude(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemStyle,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const json = await res.json();
  if (json.error) throw new Error(`Anthropic API error: ${json.error.type} — ${json.error.message}`);
  return (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

const prompt = `Today is ${dateLabel}. Write the EOD recap for these tickers using the data below. Start with a header line "🏁 EOD RECAP — ${dateLabel}" then one short market-wide opening line, then one block per ticker in the style described, separated by a blank line.

${tickerBlock}`;

let recapText;
try {
  recapText = await callClaude(prompt);
} catch (e) {
  console.error('Failed to generate recap:', e.message);
  process.exit(1);
}

// ─── 5. Post to Discord ─────────────────────────────────────────────────────
async function postToDiscord(content) {
  // Discord hard-caps messages at 2000 chars — split on blank lines if needed.
  const chunks = [];
  let current = '';
  for (const line of content.split('\n')) {
    if ((current + '\n' + line).length > 1900) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);

  for (const webhook of DISCORD_WEBHOOKS) {
    for (const chunk of chunks) {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunk })
      });
      if (!res.ok) {
        console.error(`Discord post failed (${res.status}) for webhook ${webhook.slice(0, 50)}...`);
      }
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

await postToDiscord(recapText);
console.log('EOD recap posted successfully.');
console.log('---');
console.log(recapText);
