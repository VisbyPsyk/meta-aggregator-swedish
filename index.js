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

const manifest = {
  id: 'org.stremio.swedish.meta.universal',
  version: '1.3.0',
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
      idPrefixes: ['tt']
    }
  ],
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
  if (sub.isHashMatch || sub.m === 'h') score += 1000;
  
  if (videoFilename && sub.filename) {
    const fnLow = videoFilename.toLowerCase();
    const subFnLow = sub.filename.toLowerCase();
    
    const keywords = [
      '2160p', '1080p', '720p', '4k', 'bluray', 'bdrip', 'brrip', 'web-dl', 
      'webrip', 'hdtv', 'yify', 'rarbg', 'eztv', 'flux', 'psa', 'remux', 
      'extended', 'unrated', 'proper', 'repack', 'x264', 'x265', 'h264', 'hevc'
    ];
    for (const kw of keywords) {
      if (fnLow.includes(kw) && subFnLow.includes(kw)) {
        score += 50;
      }
    }
  }
  score += parseInt(sub.g || '0', 10);
  return score;
};

const fetchMergedSubtitles = async (type, fullId, extra = {}) => {
  const proms = [];

  if (extra.videoHash) {
    proms.push(
      fetchOpenSubtitles(type, fullId, extra).then(subs => 
        subs.map(s => ({ ...s, isHashMatch: true }))
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
    if (subMap.has(key)) {
      const existing = subMap.get(key);
      if (sub.isHashMatch) existing.isHashMatch = true;
    } else {
      subMap.set(key, { ...sub });
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
  let clean = content.trim();
  clean = clean.replace(/^WEBVTT[^\n]*\n*/i, '');
  clean = clean.replace(/NOTE[^\n]*\n(?:[^\n]*\n)*/gi, '');
  clean = clean.replace(/STYLE[^\n]*\n(?:[^\n]*\n)*/gi, '');
  
  return clean.replace(/(\b\d{1,2}:)?(\d{2}:\d{2})[\.,](\d{3})\s*-->\s*(\b\d{1,2}:)?(\d{2}:\d{2})[\.,](\d{3})/g, (m, h1, ms1, ms2, h2, ms3, ms4) => {
    const hh1 = h1 ? h1.replace(':', '').padStart(2, '0') : '00';
    const hh2 = h2 ? h2.replace(':', '').padStart(2, '0') : '00';
    return `${hh1}:${ms1},${ms2} --> ${hh2}:${ms3},${ms4}`;
  });
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

    // Preserve line breaks safely across translation APIs
    const texts = subs.map(s => (s.text || '').replace(/\n/g, ' [BR] ').trim());
    const validIdx = texts.map((t, i) => (t ? i : -1)).filter(i => i !== -1);
    const toTranslate = validIdx.map(i => texts[i]);

    const translated = await translateText(toTranslate);

    let tIdx = 0;
    const newSubs = subs.map((s, i) => {
      if (validIdx.includes(i)) {
        const transText = translated[tIdx++] || s.text;
        return { ...s, text: transText.replace(/ \[BR\] /gi, '\n') };
      }
      return s;
    });

    const sweSrt = parser.toSrt(newSubs);
    TRANSLATED_CACHE.set(fileId, sweSrt);
    return sweSrt;
  } catch (e) {
    console.error('Error fetching/translating subtitle:', e.message);
    return null;
  }
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async (args) => {
  console.log(`[HANDLER] Subtitle request for ${args.type} - ID: ${args.id}`, args.extra || {});
  try {
    const fullId = args.id;
    const extra = args.extra || {};
    const baseUrl = getBaseUrl();

    const allSubs = await fetchMergedSubtitles(args.type, fullId, extra);
    if (!allSubs.length) return { subtitles: [] };

    const resultSubtitles = [];

    // 1. Native Swedish Subtitles (Sorted by syncScore descending)
    const nativeSubs = allSubs
      .filter(s => s.lang && (s.lang === 'swe' || s.lang === 'sv' || s.lang.startsWith('swe') || s.lang.startsWith('sv')))
      .sort((a, b) => b.syncScore - a.syncScore);

    nativeSubs.forEach((sub, idx) => {
      let badge = '🇸🇪 Swedish (Native)';
      if (sub.isHashMatch) {
        badge = '⚡ 🇸🇪 Swedish (Native - Hash Matched)';
      } else if (sub.syncScore > 20) {
        badge = '🇸🇪 Swedish (Native - Release Matched)';
      } else if (nativeSubs.length > 1) {
        badge = `🇸🇪 Swedish (Native #${idx + 1})`;
      }

      resultSubtitles.push({
        id: `native-sv-${idx}-${fullId}`,
        url: sub.url,
        lang: 'swe',
        label: badge,
        filename: sub.filename || 'swedish.srt',
        hearingImpaired: !!sub.hearingImpaired
      });
    });

    // 2. AI Auto-Translated Subtitles (from English or candidate languages sorted by syncScore)
    const engSubs = allSubs
      .filter(s => s.lang && (s.lang === 'eng' || s.lang === 'en' || s.lang.startsWith('eng') || s.lang.startsWith('en')))
      .sort((a, b) => b.syncScore - a.syncScore);

    const candidateSubs = engSubs.length > 0 ? engSubs : allSubs.sort((a, b) => b.syncScore - a.syncScore);

    // Pick top 2 best candidate subtitles for AI translation
    const topCandidates = candidateSubs.slice(0, 2);

    topCandidates.forEach((sub, idx) => {
      const langCode = (sub.lang || 'ENG').toUpperCase();
      const fileId = crypto.createHash('md5').update(`${fullId}_${sub.url}`).digest('hex');
      
      SOURCE_URL_CACHE.set(fileId, sub.url);

      const translatedUrl = `${baseUrl}/subtitles/translated/${fileId}.srt?src=${encodeURIComponent(sub.url)}&lang=${sub.lang || 'eng'}`;

      let badge = `🇸🇪 Swedish (AI Auto-Translated from ${langCode})`;
      if (sub.isHashMatch) {
        badge = `⚡ 🇸🇪 Swedish (AI Auto-Translated - Hash Matched)`;
      } else if (sub.syncScore > 20) {
        badge = `🇸🇪 Swedish (AI Auto-Translated - Release Matched)`;
      } else if (topCandidates.length > 1) {
        badge = `🇸🇪 Swedish (AI Auto-Translated #${idx + 1} from ${langCode})`;
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
        <span class="badge">STREMIO ADDON v1.3.0</span>
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
