'use strict';
// Новости с сайта: news.json (свой формат) или RSS/Atom. Последний ответ кэшируется для офлайна.
const fsp = require('fs').promises;
const path = require('path');
const dl = require('./download');

const MAX_ITEMS = 50;

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** HTML → обычный текст с абзацами (разметку в лаунчере не исполняем). */
function htmlToText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const firstImg = (html) => {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(decodeEntities(html || ''));
  return m ? m[1] : null;
};

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1] : null;
};
const attr = (xml, name, a) => {
  const m = new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, 'i').exec(xml);
  return m ? decodeEntities(m[1]) : null;
};

function parseFeed(xml) {
  const items = [];
  const rss = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const it of rss) {
    const body = tag(it, 'content:encoded') || tag(it, 'description') || '';
    items.push({
      id: decodeEntities(tag(it, 'guid') || tag(it, 'link') || tag(it, 'title')).trim(),
      title: htmlToText(tag(it, 'title')),
      date: tag(it, 'pubDate') || tag(it, 'dc:date'),
      text: htmlToText(body),
      url: decodeEntities(tag(it, 'link') || '').trim() || null,
      image: attr(it, 'enclosure', 'url') || attr(it, 'media:content', 'url') || attr(it, 'media:thumbnail', 'url') || firstImg(body),
      tag: htmlToText(tag(it, 'category')) || null,
    });
  }
  const atom = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const it of atom) {
    const body = tag(it, 'content') || tag(it, 'summary') || '';
    items.push({
      id: decodeEntities(tag(it, 'id') || attr(it, 'link', 'href') || tag(it, 'title')).trim(),
      title: htmlToText(tag(it, 'title')),
      date: tag(it, 'published') || tag(it, 'updated'),
      text: htmlToText(body),
      url: attr(it, 'link', 'href'),
      image: attr(it, 'media:thumbnail', 'url') || firstImg(body),
      tag: attr(it, 'category', 'term'),
    });
  }
  return items;
}

function normalize(list, baseUrl) {
  const abs = (u) => {
    if (!u) return null;
    try {
      const url = new URL(u, baseUrl);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  return list
    .filter((n) => n && (n.title || n.text))
    .map((n) => {
      const d = n.date ? new Date(n.date) : null;
      const date = d && !isNaN(d) ? d.toISOString() : null;
      return {
        id: String(n.id || `${n.title}-${n.date}`),
        title: String(n.title || '').slice(0, 200),
        date,
        text: String(n.text || '').slice(0, 20000),
        url: abs(n.url),
        image: abs(n.image),
        tag: n.tag ? String(n.tag).slice(0, 40) : null,
        pinned: !!n.pinned,
      };
    })
    .sort((a, b) => (b.pinned - a.pinned) || String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, MAX_ITEMS);
}

async function fetchNews(url, root) {
  const cache = path.join(root, 'news-cache.json');
  if (!url) return { items: [], offline: false, error: 'not_configured' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': dl.UA, 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let raw;
    if (/^\s*[[{]/.test(text)) {
      const j = JSON.parse(text);
      raw = (Array.isArray(j) ? j : j.news || j.items || []).map((n) => ({ ...n, text: n.text != null ? n.text : htmlToText(n.html || n.content || '') }));
    } else {
      raw = parseFeed(text);
    }
    const items = normalize(raw, res.url || url);
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(cache, JSON.stringify(items));
    return { items, offline: false };
  } catch (e) {
    try {
      return { items: JSON.parse(await fsp.readFile(cache, 'utf8')), offline: true, error: e.message };
    } catch {
      return { items: [], offline: true, error: e.message };
    }
  }
}

module.exports = { fetchNews, parseFeed, htmlToText };
