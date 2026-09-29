// Writes ai.json: one short AI headline per recent post, using GitHub Models (free tier).
// Runs in GitHub Actions. Any failure leaves ai.json untouched and the screen works without it.
import { readFile, writeFile } from 'node:fs/promises';

const MODEL = 'openai/gpt-4.1-mini';
const MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const BSKY = 'https://public.api.bsky.app/xrpc';
const FX = 'https://api.fxtwitter.com/2';
const MAX_NEW_PER_RUN = 25;       // one model call per run keeps us far below the daily quota
const KEEP_DAYS = 8;

const readJSON = async (path, fallback) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } };
const log = (...a) => console.log('[ai-headlines]', ...a);

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'signage-ai-headlines' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function blueskyPosts(account) {
  const data = await getJSON(`${BSKY}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(account.handle)}&limit=15&filter=posts_no_replies`);
  return (data.feed || []).filter(i => i.post && i.post.record && !(i.reason && String(i.reason.$type).endsWith('#reasonPin'))).map(i => ({
    id: i.post.uri,
    time: Date.parse(i.post.record.createdAt) || Date.parse(i.post.indexedAt),
    author: i.post.author.displayName || i.post.author.handle,
    text: String(i.post.record.text || '').trim(),
    link: i.post.embed && i.post.embed.external ? i.post.embed.external.title || '' : ''
  }));
}

async function xPosts(account) {
  const data = await getJSON(`${FX}/profile/${encodeURIComponent(account.handle)}/statuses?count=15`);
  return (data.results || []).filter(s => s && s.type === 'status' && !(s.replying_to && (s.replying_to.status || s.replying_to.screen_name))).map(s => ({
    id: `x:${s.id}`,
    time: s.created_timestamp ? s.created_timestamp * 1000 : Date.parse(s.created_at),
    author: (s.author && s.author.name) || account.handle,
    text: String(s.text || '').replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').trim(),
    link: s.card && s.card.title ? s.card.title : ''
  }));
}

async function writeHeadlines(batch) {
  const system = [
    'You write headlines for a digital signage screen at United Nations Headquarters.',
    'For each social media post, write one headline in English, whatever the language of the post.',
    'Rules: at most 9 words; factual and neutral, in the editorial tone of UN News; only use facts stated in the post;',
    'no clickbait, no emojis, no hashtags, no quotation marks around the whole headline, no final period.',
    'Keep names of people, countries and organisations exactly as in the post.',
    'Reply with JSON only: {"headlines":[{"id":"...","headline":"..."}]} with one entry per post id.'
  ].join(' ');
  const user = JSON.stringify(batch.map(p => ({ id: p.id, author: p.author, text: p.text.slice(0, 1200), link_title: p.link || undefined })));
  const res = await fetch(MODELS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    })
  });
  if (!res.ok) throw new Error(`GitHub Models HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  const parsed = JSON.parse(content || '{}');
  return Array.isArray(parsed.headlines) ? parsed.headlines : [];
}

function clean(headline) {
  return String(headline || '').replace(/^["“”'«»\s]+|["“”'«»\s]+$/g, '').replace(/\s*[.。]$/, '').replace(/\s+/g, ' ').trim().slice(0, 110);
}

async function main() {
  const config = await readJSON('config.json', {});
  if (!config.ai || !config.ai.headlines) { log('AI headlines are switched off in the editor. Nothing to do.'); return; }
  if (!process.env.GITHUB_TOKEN) { log('No GITHUB_TOKEN available.'); return; }

  const store = await readJSON('ai.json', {});
  const headlines = store.headlines && typeof store.headlines === 'object' ? store.headlines : {};
  const maxAge = ((config.feed && config.feed.max_age_hours) || 48) * 3600000;

  const jobs = (config.accounts || []).map(a => blueskyPosts(a).catch(e => { log(`Bluesky ${a.handle}: ${e.message}`); return []; }));
  if (config.x && config.x.enabled) {
    jobs.push(...(config.x.accounts || []).map(a => xPosts(a).catch(e => { log(`X @${a.handle}: ${e.message}`); return []; })));
  }
  const all = (await Promise.all(jobs)).flat().filter(p => p.id && Number.isFinite(p.time) && (p.text || p.link));
  const fresh = all.filter(p => Date.now() - p.time < maxAge && !headlines[p.id]);
  const unique = [...new Map(fresh.map(p => [p.id, p])).values()].sort((a, b) => b.time - a.time).slice(0, MAX_NEW_PER_RUN);
  log(`${all.length} posts found, ${unique.length} need a headline.`);

  let added = 0;
  if (unique.length) {
    try {
      const wanted = new Set(unique.map(p => p.id));
      const byId = new Map(unique.map(p => [p.id, p]));
      for (const item of await writeHeadlines(unique)) {
        const h = clean(item && item.headline);
        if (!item || !wanted.has(item.id) || h.length < 8) continue;
        headlines[item.id] = { headline: h, time: byId.get(item.id).time };
        added++;
      }
    } catch (err) {
      log(`Model call failed, keeping previous headlines. ${err.message}`);
    }
  }

  // Forget headlines of posts older than a week so the file stays small
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  let removed = 0;
  for (const [id, v] of Object.entries(headlines)) { if (!v || !v.time || v.time < cutoff) { delete headlines[id]; removed++; } }

  if (!added && !removed) { log('No change.'); return; }
  const out = { generated_at: new Date().toISOString(), model: MODEL, headlines };
  await writeFile('ai.json', JSON.stringify(out, null, 1) + '\n');
  log(`Saved: ${added} new, ${removed} removed, ${Object.keys(headlines).length} in total.`);
}

main().catch(err => { log(`Unexpected error: ${err.message}`); });
