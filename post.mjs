// Astar IG Story bot: Google Doc -> image -> Instagram Story
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DOC_ID = process.env.DOC_ID || '1x3JNQm_Dsa0v2c-lIbQBwchvNl_DEFXq9EKLZX0YZWc';
const IG_USER_ID = process.env.IG_USER_ID;
const TOKEN = process.env.IG_ACCESS_TOKEN;
const HOST = process.env.IG_GRAPH_HOST || 'graph.facebook.com';
const REPO = process.env.GITHUB_REPOSITORY; // owner/name, set by Actions
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 1);
const STATE = 'posted.json';
const GIT = 'git -c user.name=astar-bot -c user.email=bot@users.noreply.github.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const myt = d => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10); // Malaysia date
const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

async function fetchBlocks() {
  let raw;
  if (process.env.DOC_FILE) raw = readFileSync(process.env.DOC_FILE, 'utf8'); // local testing
  else {
    const r = await fetch(`https://docs.google.com/document/d/${DOC_ID}/export?format=txt`);
    if (!r.ok) throw new Error(`Doc fetch failed: ${r.status} (is the doc shared as "anyone with link"?)`);
    raw = await r.text();
  }
  const txt = raw.replace(/^﻿/, '').replace(/\r/g, '');
  const out = [];
  const re = /===\s*(\d{4}-\d{2}-\d{2})\s*START\s*===\s*([\s\S]*?)\s*===\s*END\s*===/gi;
  let m;
  while ((m = re.exec(txt))) {
    const text = m[2].replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!text || /SAMPLE JOB/i.test(text)) continue;
    out.push({ date: m[1], text, id: createHash('sha1').update(text).digest('hex').slice(0, 12) });
  }
  return out;
}

async function renderPng(page, text, file) {
  await page.evaluate(t => window.render(t), text);
  await page.locator('#s').screenshot({ path: file });
}

async function api(method, url, params) {
  const qs = new URLSearchParams({ ...params, access_token: TOKEN });
  const r = await fetch(method === 'GET' ? `${url}?${qs}` : url, {
    method,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : qs,
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(JSON.stringify(j.error || j));
  return j;
}

async function postStory(imageUrl) {
  const base = `https://${HOST}/v21.0`;
  const c = await api('POST', `${base}/${IG_USER_ID}/media`, { image_url: imageUrl, media_type: 'STORIES' });
  for (let i = 0; i < 20; i++) {
    const s = await api('GET', `${base}/${c.id}`, { fields: 'status_code' });
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Media status ' + s.status_code);
    await sleep(3000);
  }
  return api('POST', `${base}/${IG_USER_ID}/media_publish`, { creation_id: c.id });
}

async function waitUrl(url) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(url, { method: 'HEAD' });
    if (r.ok) return;
    await sleep(3000);
  }
  throw new Error('Image URL not reachable: ' + url);
}

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { posted: {} };
const today = myt(new Date());
const blocks = (await fetchBlocks()).filter(b => {
  const age = dayDiff(today, b.date);
  return age >= 0 && age <= MAX_AGE_DAYS && !state.posted[b.id];
});
console.log(`${today} MYT: ${blocks.length} new block(s) to post${DRY ? ' (dry run)' : ''}`);
if (!blocks.length) process.exit(0);

mkdirSync('stories', { recursive: true });
const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto(pathToFileURL(path.resolve('template.html')).href, { waitUntil: 'networkidle' });

let failed = 0;
for (const b of blocks) {
  const file = `stories/${b.date}-${b.id}.png`;
  await renderPng(page, b.text, file);
  console.log('rendered', file);
  if (DRY) continue;
  try {
    execSync(`git add "${file}" && ${GIT} commit -m "story ${b.id}" && git push`, { stdio: 'inherit' });
    const url = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file}`;
    await waitUrl(url);
    const res = await postStory(url);
    state.posted[b.id] = { date: b.date, at: new Date().toISOString(), media: res.id };
    writeFileSync(STATE, JSON.stringify(state, null, 2));
    console.log('posted', b.id, res.id);
  } catch (e) {
    failed++;
    console.error('FAILED', b.id, e.message);
  }
}
await browser.close();
if (!DRY) {
  try {
    execSync(`git add ${STATE} && ${GIT} commit -m "update state" && git push`, { stdio: 'inherit' });
  } catch {}
}
process.exit(failed ? 1 : 0);
