try {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile();
  }
} catch (e) {
  // .env file missing or process.env already set by host
}
try {
  await import('dotenv/config');
} catch (e) {
  // dotenv package not installed or unnecessary in production
}
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import pkg from 'stremio-addon-sdk';
const { addonBuilder, getRouter } = pkg;
import axios from 'axios';
import srtParser2 from 'srt-parser-2';
import { AsyncLocalStorage } from 'async_hooks';

const Parser = srtParser2.default || srtParser2;
const asyncLocalStorage = new AsyncLocalStorage();

const PORT = process.env.PORT || 3000;
const DEEPL_KEY = process.env.DEEPL_API_KEY;
const AZURE_KEY = process.env.AZURE_TRANSLATOR_KEY;
const AZURE_REGION = process.env.AZURE_TRANSLATOR_REGION;

// Official working Stremio OpenSubtitles v3 addon endpoint
const OS_V3_ADDON = 'https://opensubtitles-v3.strem.io';

// Helper to resolve request base URL dynamically across Render, Cloud Run, Localhost, and custom proxies
function getBaseUrl() {
  const store = asyncLocalStorage.getStore();
  if (store && store.baseUrl) {
    return store.baseUrl;
  }
  if (process.env.HOST_URL) {
    return process.env.HOST_URL.replace(/\/$/, '');
  }
  return `http://localhost:${PORT}`;
}

// Simple bounded LRU Cache to manage memory usage
class LRUCache {
  constructor(limit = 500) {
    this.limit = limit;
    this.cache = new Map();
  }
  get(key) {
    if (!this.cache.has(key)) return null;
    const val = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.limit) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, val);
  }
  has(key) {
    return this.cache.has(key);
  }
}

const TRANSLATED_CACHE = new LRUCache(500);
const SOURCE_URL_CACHE = new LRUCache(1000);
const CANDIDATE_CACHE = new LRUCache(200);
const TRANSLATING_PROMISES = new Map();

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

const manifest = {
  id: 'org.stremio.swedish.meta.universal',
  version: '1.4.0',
  name: '🇸🇪 Swedish Universal Subtitles',
  description: 'Native Swedish subtitles + AI Auto-Translation fallback (DeepL / Azure / Free Google Translate). Fast & optimized for TV and Web.',
  logo: 'https://cdn.jsdelivr.net/gh/hakanburok/stremio-addons@main/logos/swedish-flag.png',
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  resources: [
    {
      name: 'subtitles',
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      extra: [
        { name: 'videoHash', isRequired: false },
        { name: 'videoSize', isRequired: false },
        { name: 'filename', isRequired: false }
      ]
    }
  ],
  extraSupported: ['videoHash', 'videoSize', 'filename'],
  behaviorHints: { configurable: false, adult: false, p2p: false }
};

const buildStremioSubUrl = (type, id, extra = {}) => {
  const extraSegments = [];
  if (extra.videoHash) extraSegments.push(`videoHash=${extra.videoHash}`);
  if (extra.videoSize) extraSegments.push(`videoSize=${extra.videoSize}`);
  
  const extraPath = extraSegments.length > 0 ? `/${extraSegments.join('&')}` : '';
  return `${OS_V3_ADDON}/subtitles/${type}/${id}${extraPath}.json`;
};

const fetchOpenSubtitles = async (type, id, extra = {}) => {
  const url = buildStremioSubUrl(type, id, extra);
  try {
    const { data } = await axios.get(url, { 
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Stremio Universal Subtitles)' }
    });
    return data.subtitles || [];
  } catch (err) {
    console.warn(`[OpenSubtitles] Error fetching for ${type} ${id}:`, err.message);
    return [];
  }
};

const scoreSubtitle = (sub, videoFilename) => {
  let score = 0;
  
  // 1. Strict Hash match (100% exact frame-sync for this specific video file)
  if (sub.isHashMatch || sub.m === 'h') {
    score += 5000;
  }

  // 2. Download count weight (Popularity - most downloaded release is almost always the main YIFY/BluRay/WEB-DL sync)
  const downloads = parseInt(sub.g || '0', 10);
  score += Math.min(downloads * 15, 1500);

  // 3. UTF-8 encoding preference
  if (sub.SubEncoding === 'UTF-8') {
    score += 50;
  }

  // 4. Filename matching
  if (videoFilename && sub.filename) {
    const fnLow = videoFilename.toLowerCase();
    const subFnLow = sub.filename.toLowerCase();
    
    const keywords = [
      '2160p', '1080p', '720p', '4k', 'bluray', 'bdrip', 'brrip', 'web-dl', 
      'webrip', 'hdtv', 'yify', 'rarbg', 'eztv', 'flux', 'psa', 'remux', 
      'extended', 'unrated', 'proper', 'repack', 'x264', 'x265', 'h264', 'hevc',
      'sparks', 'amiable', 'evo', 'ntb', 'qxr', 'utr', 'vxt', 'ion10', 'tgx'
    ];
    for (const kw of keywords) {
      if (fnLow.includes(kw) && subFnLow.includes(kw)) {
        score += 60;
      }
    }

    const cleanFn = fnLow.replace(/[^a-z0-9]/g, ' ');
    const cleanSubFn = subFnLow.replace(/[^a-z0-9]/g, ' ');
    const fnWords = cleanFn.split(/\s+/).filter(w => w.length > 2);
    for (const word of fnWords) {
      if (cleanSubFn.includes(word)) {
        score += 20;
      }
    }
  }
  
  return score;
};

const fetchMergedSubtitles = async (type, fullId, extra = {}) => {
  const proms = [];

  if (extra.videoHash) {
    proms.push(
      fetchOpenSubtitles(type, fullId, extra).then(subs => 
        subs.map(s => ({ ...s, isHashMatch: s.m === 'h' }))
      )
    );
  }

  proms.push(
    fetchOpenSubtitles(type, fullId).then(subs => 
      subs.map(s => ({ ...s, isHashMatch: s.m === 'h' }))
    )
  );

  const results = await Promise.all(proms);
  const combined = results.flat();

  const subMap = new Map();
  for (const sub of combined) {
    const key = sub.url || sub.id;
    if (!key) continue;
    
    const isHashMatch = sub.isHashMatch || sub.m === 'h';

    if (subMap.has(key)) {
      const existing = subMap.get(key);
      if (isHashMatch) existing.isHashMatch = true;
    } else {
      subMap.set(key, { ...sub, isHashMatch });
    }
  }

  const uniqueSubs = Array.from(subMap.values());
  const videoFilename = extra.filename || '';

  return uniqueSubs.map(sub => ({
    ...sub,
    syncScore: scoreSubtitle(sub, videoFilename)
  }));
};

const fixSrtTimecodes = (content) => {
  if (!content || typeof content !== 'string') return '';
  let clean = content.trim();
  clean = clean.replace(/^WEBVTT[^\n]*\n*/i, '');
  clean = clean.replace(/NOTE[^\n]*\n(?:[^\n]*\n)*/gi, '');
  clean = clean.replace(/STYLE[^\n]*\n(?:[^\n]*\n)*/gi, '');
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  return clean.replace(/(\b\d{1,2}:)?(\d{2}:\d{2})[\.,](\d{3})\s*-->\s*(\b\d{1,2}:)?(\d{2}:\d{2})[\.,](\d{3})/g, (m, h1, ms1, ms2, h2, ms3, ms4) => {
    const hh1 = h1 ? h1.replace(':', '').padStart(2, '0') : '00';
    const hh2 = h2 ? h2.replace(':', '').padStart(2, '0') : '00';
    return `${hh1}:${ms1},${ms2} --> ${hh2}:${ms3},${ms4}`;
  });
};

const removeAssTags = (text) => {
  if (!text) return '';
  return text
    // 1. Remove curly-brace ASS tags: {\an8}, {\pos(100,200)}, {\b1}, {\c&H...&}, {\fad(...)}, etc.
    .replace(/\{[^}]*\}/g, '')
    // 2. Remove unbraced/escaped ASS alignment tags: \an8, \an1-9, an8, AN8, \an1..9
    .replace(/(?:\\|\b)[aA][nN][1-9]\b[:\-]?/gi, '')
    // 3. Remove ASS position tags: \pos(x,y) or pos(x,y)
    .replace(/(?:\\|\b)pos\(\d+,\d+\)/gi, '')
    // 4. Remove unbraced ASS style tags
    .replace(/\\(?:b|i|u|fn|fs|c|1c|2c|3c|4c|alpha|1a|2a|3a|4a|k|K|kf|ko|q|r)\b[^\s\\]*/gi, '');
};

const cleanSubTagFormatting = (text) => {
  if (!text) return '';
  let cleaned = removeAssTags(text);

  // Remove standalone mangled ASS alignment artifacts like 'an8', '[an8]', '(an8)', 'AN8'
  cleaned = cleaned
    .replace(/^\s*\[?\(?[aA][nN][1-9]\)?\]?[:\-]?\s*/gi, '')
    .replace(/\s*\[?\(?[aA][nN][1-9]\)?\]?[:\-]?\s*$/gi, '')
    .replace(/\s+\[?\(?[aA][nN][1-9]\)?\]?\s+/gi, ' ')
    .replace(/\s*\[\s*BR\s*\]\s*/gi, '\n')
    .replace(/<\s*\/\s*([a-z]+)\s*>/gi, '</$1>')
    .replace(/<\s*([a-z]+)(\s+[^>]*)?>/gi, '<$1$2>');
  
  return cleaned.trim();
};

// Batch Translation Engines
const translateBatchDeepL = async (texts) => {
  const CHUNK_SIZE = 50;
  const results = [];
  const isFreeKey = DEEPL_KEY.endsWith(':fx');
  const deeplEndpoint = isFreeKey
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const params = new URLSearchParams();
    chunk.forEach(t => params.append('text', t));
    params.append('target_lang', 'SV');
    params.append('tag_handling', 'xml');
    
    const { data } = await axios.post(deeplEndpoint, params, {
      headers: { Authorization: `DeepL-Auth-Key ${DEEPL_KEY}` },
      timeout: 20000
    });
    results.push(...data.translations.map(t => t.text));
  }
  return results;
};

const translateBatchAzure = async (texts) => {
  const url = `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=sv`;
  const body = texts.map(t => ({ Text: t }));
  const headers = { 'Ocp-Apim-Subscription-Key': AZURE_KEY, 'Content-Type': 'application/json' };
  if (AZURE_REGION) headers['Ocp-Apim-Subscription-Region'] = AZURE_REGION;
  
  const { data } = await axios.post(url, body, { headers, timeout: 25000 });
  return data.map(item => item.translations?.[0]?.text || '');
};

const translateBatchGoogle = async (texts, targetLang = 'sv') => {
  const CHUNK_SIZE = 50;
  const results = [];
  
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const joined = chunk.join('\n|||\n');
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + targetLang + '&dt=t&q=' + encodeURIComponent(joined);
      const res = await axios.get(url, { timeout: 12000 });
      const translatedFull = res.data[0].map(x => x[0]).join('');
      const translatedParts = translatedFull.split(/\s*\|\|\|\s*/);
      
      if (translatedParts.length === chunk.length) {
        results.push(...translatedParts);
      } else {
        // Fallback item by item in parallel if delimiter split count differs
        const itemProms = chunk.map(async item => {
          try {
            const itemUrl = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' + targetLang + '&dt=t&q=' + encodeURIComponent(item);
            const itemRes = await axios.get(itemUrl, { timeout: 5000 });
            return itemRes.data[0].map(x => x[0]).join('');
          } catch {
            return item;
          }
        });
        results.push(...await Promise.all(itemProms));
      }
    } catch (err) {
      console.warn('Google Translate chunk failed, returning original:', err.message);
      results.push(...chunk);
    }
  }
  return results;
};

const translateBatchMyMemory = async (texts, targetLang = 'sv') => {
  const itemProms = texts.map(async item => {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(item)}&langpair=en|${targetLang}`;
      const res = await axios.get(url, { timeout: 4000 });
      return res.data?.responseData?.translatedText || item;
    } catch {
      return item;
    }
  });
  return await Promise.all(itemProms);
};

const translateText = async (texts) => {
  if (!texts || !texts.length) return texts;

  if (DEEPL_KEY) {
    try {
      return await translateBatchDeepL(texts);
    } catch (e) {
      console.warn('DeepL Translation failed, falling back to Google:', e.message);
    }
  }

  if (AZURE_KEY) {
    try {
      return await translateBatchAzure(texts);
    } catch (e) {
      console.warn('Azure Translation failed, falling back to Google:', e.message);
    }
  }

  // Free Google Translate Engine fallback
  try {
    return await translateBatchGoogle(texts);
  } catch (e) {
    console.warn('Google Translate failed, falling back to MyMemory:', e.message);
  }

  // Free MyMemory API fallback
  try {
    return await translateBatchMyMemory(texts);
  } catch (e) {
    console.warn('MyMemory failed, returning original:', e.message);
    return texts;
  }
};

const getOrTranslateSubtitle = async (sourceUrl, fileId) => {
  if (TRANSLATED_CACHE.has(fileId)) {
    return TRANSLATED_CACHE.get(fileId);
  }

  if (TRANSLATING_PROMISES.has(fileId)) {
    return await TRANSLATING_PROMISES.get(fileId);
  }

  const translationPromise = (async () => {
    try {
      const { data: rawContent } = await axios.get(sourceUrl, { 
        responseType: 'text', 
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (Stremio Subtitle Translator)' }
      });
      
      if (!rawContent || typeof rawContent !== 'string') return null;

      // Clean up WEBVTT or SRT formatting quirks and fix timecodes
      const cleanContent = fixSrtTimecodes(rawContent);

      const parser = new Parser();
      const subs = parser.fromSrt(cleanContent);
      if (!subs || !subs.length) {
        // If parsing failed, cache raw content as fallback
        TRANSLATED_CACHE.set(fileId, rawContent);
        return rawContent;
      }

      // Clean ASS control tags (e.g. {\an8}, \an8) and preserve line breaks safely across translation APIs
      const texts = subs.map(s => {
        const textWithoutAss = removeAssTags(s.text || '');
        return textWithoutAss.replace(/\n/g, ' [BR] ').trim();
      });
      const validIdx = texts.map((t, i) => (t ? i : -1)).filter(i => i !== -1);
      const toTranslate = validIdx.map(i => texts[i]);

      const translated = await translateText(toTranslate);

      let tIdx = 0;
      const newSubs = subs.map((s, i) => {
        if (validIdx.includes(i)) {
          const transText = translated[tIdx++] || s.text;
          return { ...s, text: cleanSubTagFormatting(transText) };
        }
        return s;
      });

      const sweSrt = parser.toSrt(newSubs);
      TRANSLATED_CACHE.set(fileId, sweSrt);
      return sweSrt;
    } catch (e) {
      console.error('Error fetching/translating subtitle:', e.message);
      return null;
    } finally {
      TRANSLATING_PROMISES.delete(fileId);
    }
  })();

  TRANSLATING_PROMISES.set(fileId, translationPromise);
  return await translationPromise;
};

const getOrCleanNativeSubtitle = async (sourceUrl, fileId) => {
  if (TRANSLATED_CACHE.has(fileId)) {
    return TRANSLATED_CACHE.get(fileId);
  }

  try {
    const { data: rawContent } = await axios.get(sourceUrl, {
      responseType: 'text',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Stremio Subtitle Cleaner)' }
    });

    if (!rawContent || typeof rawContent !== 'string') return null;

    const cleanContent = fixSrtTimecodes(rawContent);
    const parser = new Parser();
    const subs = parser.fromSrt(cleanContent);
    if (!subs || !subs.length) {
      TRANSLATED_CACHE.set(fileId, rawContent);
      return rawContent;
    }

    const cleanedSubs = subs.map(s => ({
      ...s,
      text: cleanSubTagFormatting(s.text)
    }));

    const cleanSrt = parser.toSrt(cleanedSubs);
    TRANSLATED_CACHE.set(fileId, cleanSrt);
    return cleanSrt;
  } catch (e) {
    console.error('Error fetching/cleaning native subtitle:', e.message);
    return null;
  }
};

const evaluateSubMetadata = async (sub, type, videoFilename = '') => {
  try {
    const res = await axios.get(sub.url, { responseType: 'text', timeout: 3500 });
    if (!res.data || typeof res.data !== 'string') return null;

    const parser = new Parser();
    const cues = parser.fromSrt(res.data);
    if (!cues || !cues.length) return null;

    const minCues = type === 'movie' ? 80 : 30;
    if (cues.length < minCues) return null;

    let firstSec = 99999;
    for (const c of cues) {
      if (!c.startTime) continue;
      const parts = c.startTime.split(':');
      if (parts.length === 3) {
        const sec = parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseFloat(parts[2].replace(',', '.'));
        if (sec < 5 && cues.length > 1 && /rip|sub|by|enjoy|credit/i.test(c.text)) continue;
        firstSec = sec;
        break;
      }
    }

    if (firstSec > 900) return null;

    let score = 0;
    if (sub.isHashMatch || sub.m === 'h') score += 10000;

    if (type === 'movie' && cues.length >= 800 && cues.length <= 2500) score += 500;
    if (type === 'series' && cues.length >= 250 && cues.length <= 1500) score += 500;

    if (firstSec >= 10 && firstSec <= 60) score += 400;

    if (videoFilename && (sub.filename || sub.url)) {
      const fnLow = videoFilename.toLowerCase();
      const subFnLow = (sub.filename || sub.url).toLowerCase();
      const keywords = [
        '2160p', '1080p', '720p', '4k', 'bluray', 'bdrip', 'brrip', 'web-dl', 
        'webrip', 'hdtv', 'yify', 'rarbg', 'eztv', 'flux', 'psa', 'remux', 
        'extended', 'unrated', 'proper', 'repack', 'x264', 'x265', 'h264', 'hevc',
        'sparks', 'amiable', 'evo', 'ntb', 'qxr', 'utr', 'vxt', 'ion10', 'tgx'
      ];
      for (const kw of keywords) {
        if (fnLow.includes(kw) && subFnLow.includes(kw)) score += 100;
      }
    }

    const downloads = parseInt(sub.g || '0', 10);
    score += Math.min(downloads * 5, 300);

    const mins = Math.floor(firstSec / 60).toString().padStart(2, '0');
    const secs = Math.floor(firstSec % 60).toString().padStart(2, '0');
    const timeStr = `${mins}:${secs}`;

    return { ...sub, firstSec, timeStr, cueCount: cues.length, score };
  } catch (e) {
    return null;
  }
};

const evaluateAndSelectCandidates = async (subs, type, fullId, videoFilename = '') => {
  const cacheKey = `${type}_${fullId}_${videoFilename}_${subs.length}`;
  if (CANDIDATE_CACHE.has(cacheKey)) {
    return CANDIDATE_CACHE.get(cacheKey);
  }

  const rawCandidates = subs.slice(0, 20);
  const evalResults = await Promise.all(rawCandidates.map(s => evaluateSubMetadata(s, type, videoFilename)));
  const valid = evalResults.filter(Boolean).sort((a, b) => b.score - a.score);

  if (!valid.length) {
    const fallback = subs.slice(0, 2);
    CANDIDATE_CACHE.set(cacheKey, fallback);
    return fallback;
  }

  const candidates = [valid[0]];

  for (let i = 1; i < valid.length; i++) {
    const item = valid[i];
    const isDistinct = candidates.every(
      c => Math.abs(c.firstSec - item.firstSec) >= 4 || Math.abs(c.cueCount - item.cueCount) / c.cueCount > 0.15
    );
    if (isDistinct) {
      candidates.push(item);
      if (candidates.length >= 3) break;
    }
  }

  if (candidates.length < 2 && valid.length > 1) {
    candidates.push(valid[1]);
  }
  if (candidates.length < 3 && valid.length > 2 && !candidates.includes(valid[2])) {
    candidates.push(valid[2]);
  }

  CANDIDATE_CACHE.set(cacheKey, candidates);
  return candidates;
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  console.log(`[HANDLER] Subtitle request for ${args.type} - ID: ${args.id}`, args.extra || {});
  try {
    const fullId = args.id;
    const extra = args.extra || {};
    const baseUrl = getBaseUrl();
    const videoFilename = extra.filename || '';

    const allSubs = await fetchMergedSubtitles(args.type, fullId, extra);
    if (!allSubs.length) return { subtitles: [] };

    const resultSubtitles = [];

    // 1. Native Swedish Subtitles
    const nativeRaw = allSubs
      .filter(s => s.lang && (s.lang === 'swe' || s.lang === 'sv' || s.lang.startsWith('swe') || s.lang.startsWith('sv')))
      .sort((a, b) => b.syncScore - a.syncScore);

    if (nativeRaw.length > 0) {
      const nativeCandidates = await evaluateAndSelectCandidates(nativeRaw, args.type, fullId, videoFilename);
      nativeCandidates.forEach((sub, idx) => {
        const fileId = crypto.createHash('md5').update(`native_${fullId}_${sub.url}_${idx}`).digest('hex');
        SOURCE_URL_CACHE.set(fileId, sub.url);
        const cleanNativeUrl = `${baseUrl}/subtitles/native/${fileId}.srt?src=${encodeURIComponent(sub.url)}`;

        let badge = '🇸🇪 Swedish (Native)';
        if (sub.isHashMatch || sub.m === 'h') {
          badge = idx === 0 ? '⚡ 🇸🇪 Swedish (Native - Hash Matched)' : `⚡ 🇸🇪 Swedish (Native - Hash Matched #${idx + 1})`;
        } else if (idx === 0) {
          badge = '🇸🇪 Swedish (Native - Primary Sync)';
        } else {
          badge = `🇸🇪 Swedish (Native - Alt Sync Option #${idx + 1}${sub.timeStr ? ' ~' + sub.timeStr : ''})`;
        }

        resultSubtitles.push({
          id: `native-sv-${idx}-${fileId}`,
          url: cleanNativeUrl,
          lang: 'swe',
          label: badge,
          filename: sub.filename || 'swedish.srt',
          hearingImpaired: !!sub.hearingImpaired
        });
      });
    }

    // 2. AI Auto-Translated Subtitles (from English or candidate languages)
    const engRaw = allSubs
      .filter(s => s.lang && (s.lang === 'eng' || s.lang === 'en' || s.lang.startsWith('eng') || s.lang.startsWith('en')))
      .sort((a, b) => b.syncScore - a.syncScore);

    const targetRaw = engRaw.length > 0 ? engRaw : allSubs.sort((a, b) => b.syncScore - a.syncScore);

    if (targetRaw.length > 0) {
      const aiCandidates = await evaluateAndSelectCandidates(targetRaw, args.type, fullId, videoFilename);

      aiCandidates.forEach((sub, idx) => {
        const langCode = (sub.lang || 'ENG').toUpperCase();
        const fileId = crypto.createHash('md5').update(`${fullId}_${sub.url}_${idx}`).digest('hex');
        
        SOURCE_URL_CACHE.set(fileId, sub.url);

        const translatedUrl = `${baseUrl}/subtitles/translated/${fileId}.srt?src=${encodeURIComponent(sub.url)}&lang=${sub.lang || 'eng'}`;

        let badge = `🇸🇪 Swedish (AI Auto-Translated from ${langCode})`;
        if (sub.isHashMatch || sub.m === 'h') {
          badge = idx === 0 ? `⚡ 🇸🇪 Swedish (AI Auto-Translated - Hash Matched)` : `⚡ 🇸🇪 Swedish (AI Auto-Translated - Hash Matched #${idx + 1})`;
        } else if (idx === 0) {
          badge = `🇸🇪 Swedish (AI Auto-Translated - Primary Sync)`;
        } else {
          badge = `🇸🇪 Swedish (AI Auto-Translated - Alt Sync Option #${idx + 1}${sub.timeStr ? ' ~' + sub.timeStr : ''})`;
        }

        resultSubtitles.push({
          id: `ai-sv-${idx}-${fileId}`,
          url: translatedUrl,
          lang: 'swe',
          label: badge,
          filename: `SV_AI_${langCode}_${sub.filename || 'sub.srt'}`,
          hearingImpaired: !!sub.hearingImpaired
        });
      });
    }

    return { subtitles: resultSubtitles };
  } catch (err) {
    console.error('Subtitles handler exception:', err);
    return { subtitles: [] };
  }
});

const app = express();

// Global CORS Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'User-Agent']
}));

// Request Context & Base URL Store Middleware
app.use((req, res, next) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const baseUrl = `${proto}://${host}`;

  asyncLocalStorage.run({ baseUrl, req }, () => {
    next();
  });
});

// Request Logging
app.use((req, res, next) => {
  console.log(`[HTTP ${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

app.get('/health', (_, res) => res.status(200).send('OK'));

app.get('/', (req, res) => {
  const baseUrl = getBaseUrl();
  const manifestUrl = `${baseUrl}/manifest.json`;
  const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://');
  const activeEngine = DEEPL_KEY ? 'DeepL API' : (AZURE_KEY ? 'Azure Translator' : 'Free Google Translate Engine');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>🇸🇪 Swedish Universal Subtitles Stremio Addon</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 2rem; display: flex; justify-content: center; align-items: center; min-height: 100vh; box-sizing: border-box; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; max-width: 600px; width: 100%; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        h1 { margin-top: 0; color: #38bdf8; font-size: 1.5rem; display: flex; align-items: center; gap: 0.5rem; }
        p { color: #94a3b8; line-height: 1.6; }
        .badge { display: inline-block; padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: bold; background: #0284c7; color: #fff; margin-bottom: 1rem; }
        .btn-group { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 1.5rem; }
        a.btn { text-decoration: none; padding: 0.75rem 1.25rem; border-radius: 8px; font-weight: 600; font-size: 0.95rem; transition: background 0.2s; display: inline-flex; align-items: center; justify-content: center; }
        .btn-primary { background: #0284c7; color: #ffffff; }
        .btn-primary:hover { background: #0369a1; }
        .btn-secondary { background: #334155; color: #e2e8f0; }
        .btn-secondary:hover { background: #475569; }
        .info-box { background: #0f172a; border-radius: 8px; padding: 1rem; margin-top: 1.5rem; font-family: monospace; font-size: 0.85rem; color: #cbd5e1; word-break: break-all; }
        .status { margin-top: 1rem; font-size: 0.85rem; color: #a1a1aa; border-top: 1px solid #334155; padding-top: 1rem; }
        .status-item { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
        .status-val { font-weight: 600; color: #4ade80; }
        .status-val.info { color: #38bdf8; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge">STREMIO ADDON v1.4.0</span>
        <h1>🇸🇪 Swedish Universal Subtitles</h1>
        <p>Native Swedish subtitles with AI auto-translation fallback for Movies & TV Series. Fully optimized for Stremio TV, Android, iOS, Web, and Desktop.</p>

        <div class="info-box">
          Manifest URL: ${manifestUrl}
        </div>

        <div class="btn-group">
          <a class="btn btn-primary" href="${stremioUrl}">Install in Stremio</a>
          <a class="btn btn-secondary" href="${manifestUrl}" target="_blank">View Manifest JSON</a>
        </div>

        <div class="status">
          <div class="status-item">
            <span>Status:</span>
            <span class="status-val">Online & Ready</span>
          </div>
          <div class="status-item">
            <span>Active Translation Engine:</span>
            <span class="status-val info">${activeEngine}</span>
          </div>
          <div class="status-item">
            <span>Subtitle Provider:</span>
            <span class="status-val info">OpenSubtitles v3 (Official)</span>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// Native Swedish Subtitle endpoint (cleans formatting & ASS tags)
app.get('/subtitles/native/:fileId.srt', async (req, res) => {
  const { fileId } = req.params;
  const sourceUrl = req.query.src || SOURCE_URL_CACHE.get(fileId);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  if (TRANSLATED_CACHE.has(fileId)) {
    return res.status(200).send(TRANSLATED_CACHE.get(fileId));
  }

  if (!sourceUrl) {
    return res.status(404).send('Subtitle source URL not found or link expired.');
  }

  try {
    const srtData = await getOrCleanNativeSubtitle(sourceUrl, fileId);
    if (!srtData) {
      return res.status(500).send('Failed to fetch native subtitle.');
    }
    return res.status(200).send(srtData);
  } catch (err) {
    console.error('Error serving native subtitle:', err.message);
    return res.status(500).send('Error processing subtitle file.');
  }
});

// Subtitle file endpoint optimized for Stremio TV & Players (ExoPlayer, VLC, WebOS, Tizen)
app.get('/subtitles/translated/:fileId.srt', async (req, res) => {
  const { fileId } = req.params;
  const sourceUrl = req.query.src || SOURCE_URL_CACHE.get(fileId);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');

  if (TRANSLATED_CACHE.has(fileId)) {
    return res.status(200).send(TRANSLATED_CACHE.get(fileId));
  }

  if (!sourceUrl) {
    return res.status(404).send('Subtitle source URL not found or link expired.');
  }

  try {
    const srtData = await getOrTranslateSubtitle(sourceUrl, fileId);
    if (!srtData) {
      return res.status(500).send('Failed to fetch or translate subtitle.');
    }
    return res.status(200).send(srtData);
  } catch (err) {
    console.error('Error serving translated subtitle:', err.message);
    return res.status(500).send('Error processing subtitle file.');
  }
});

// Mount Stremio SDK router
app.use(getRouter(builder.getInterface()));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`🚀 Swedish Universal Subtitles Addon Active on Port ${PORT}`);
  console.log(`🔗 OpenSubtitles Provider: ${OS_V3_ADDON}`);
  console.log(`===================================================`);
});
