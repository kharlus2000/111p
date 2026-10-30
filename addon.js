'use strict';

const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: '*' }));

// Endereço do site e porta local do addon.
const BASE_URL = (process.env.XVIDEOS_BASE_URL || 'https://www.xvideos.com').replace(/\/$/, '');
const PORT = Number(process.env.PORT || 7014);
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);
const CATALOG_PAGE_SIZE = 100;       // O Stremio usa skip em blocos de 100.
const SOURCE_PAGE_SIZE = 24;         // Tamanho aproximado de uma página do site.
const MAX_SOURCE_PAGES = 7;          // Limite para evitar buscas sem fim.
const CACHE_TTL_MS = 5 * 60 * 1000;
const FALLBACK_POSTER = 'https://img.icons8.com/clouds/200/video.png';

// A reprodução via resolvedor Python é opcional e configurável.
// Não fixamos IP de rede local: 192.168.x.x muda de uma máquina para outra.
const PYTHON_PROXY = process.env.PYTHON_PROXY || '';

const CATEGORIES = {
  'Recentes': '/new',
  'Brasileiro': '/c/brazilian-69',
  'Anal': '/tags/anal',
  'Squirting': '/tags/squirting',
  'Amador': '/tags/amateur',
  'Pau Grande': '/tags/big-cock',
  'Gozada': '/tags/cumshot',
  'Dupla Penetração': '/tags/double-penetration'
};

const metaCache = new Map();
const streamUrlCache = new Map();
const playableCache = new Map();
const pageCache = new Map();
let lastCatalogDiagnostic = { at: null, status: 'ainda não executado' };

const builder = new addonBuilder({
  id: 'org.zimaos.xvideos.catalog',
  version: '18.0.0',
  name: 'xVideos Sniper',
  description: 'Catálogo com busca, categorias, capas e paginação compatível com Stremio.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie'],
  idPrefixes: ['xv:'],
  catalogs: [{
    type: 'movie',
    id: 'xv_catalog',
    name: 'xVideos HD',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'genre', isRequired: false, options: Object.keys(CATEGORIES) },
      { name: 'skip', isRequired: false }
    ]
  }],
  behaviorHints: { adult: true }
});

function normalizeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim(), BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function getVideoIdentity(href) {
  const normalized = normalizeUrl(href);
  if (!normalized) return null;
  try {
    const pathname = new URL(normalized).pathname;
    // Aceita formatos antigos e novos: /video123/..., /video.abc123/...
    const match = pathname.match(/\/(video\.?([a-z0-9]+))(?:\/|$)/i);
    if (!match) return null;
    return { key: match[2].toLowerCase(), url: normalized };
  } catch (_) {
    return null;
  }
}

function firstSrcsetUrl(value) {
  if (!value) return null;
  return String(value).split(',')[0].trim().split(/\s+/)[0];
}

function getImageFromElement($, root) {
  const candidates = [];
  $(root).find('img, source').each((_, element) => {
    const node = $(element);
    candidates.push(
      node.attr('data-src'), node.attr('data-original'), node.attr('data-lazy-src'),
      node.attr('data-thumb'), node.attr('data-image'), node.attr('src'),
      firstSrcsetUrl(node.attr('data-srcset')), firstSrcsetUrl(node.attr('srcset'))
    );
  });
  for (const candidate of candidates) {
    const url = normalizeUrl(candidate);
    if (url && !/(transparent|placeholder|blank\.gif|loading)/i.test(url)) return url;
  }
  return null;
}

function extractVideos(html, sourcePage = 1) {
  const $ = cheerio.load(html);
  const found = new Map();

  // Estratégia principal: links com URL real de vídeo, sem depender de uma classe CSS.
  $('a[href]').each((_, anchor) => {
    const href = $(anchor).attr('href');
    const identity = getVideoIdentity(href);
    if (!identity || found.has(identity.key)) return;

    const link = $(anchor);
    const card = link.closest(
      '.thumb-block, .thumb, .thumb-container, .thumb-inside, .mozaique > div, article, [class*="thumb"]'
    );
    const root = card.length ? card : link.parent().parent();
    const image = getImageFromElement($, root) || getImageFromElement($, link);
    const title = String(
      link.attr('title') || link.attr('aria-label') ||
      root.find('.title, .thumb-title, [class*="title"]').first().text() ||
      root.find('img').first().attr('alt') || link.text() || ''
    ).replace(/\s+/g, ' ').trim();

    if (!title || title.length < 2) return;

    const id = `xv:${identity.key}`;
    const meta = {
      id,
      type: 'movie',
      name: title.slice(0, 250),
      poster: image || FALLBACK_POSTER,
      posterShape: 'landscape',
      description: `Encontrado na página ${sourcePage}`
    };
    found.set(identity.key, { meta, url: identity.url });
  });

  // Alguns layouts colocam o link no próprio cartão e o título/imagem em elementos irmãos.
  return [...found.values()];
}

function buildSourcePageUrl(extra, page) {
  const search = String(extra.search || '').trim();
  if (search) {
    const url = new URL('/', BASE_URL);
    url.searchParams.set('k', search);
    url.searchParams.set('p', String(page));
    return url.href;
  }

  const genre = CATEGORIES[extra.genre] ? extra.genre : 'Recentes';
  const path = CATEGORIES[genre];
  if (genre === 'Recentes') return new URL(`/new/${page}`, BASE_URL).href;
  return new URL(`${path.replace(/\/$/, '')}/${page}`, BASE_URL).href;
}

async function fetchHTML(url) {
  const response = await axios.get(url, {
    timeout: REQUEST_TIMEOUT,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: status => status >= 200 && status < 400,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Referer': `${BASE_URL}/`
    }
  });
  return { html: response.data, status: response.status, finalUrl: response.request?.res?.responseUrl || url };
}

function cleanExtractedUrl(value) {
  if (!value) return null;
  let candidate = String(value).trim();
  candidate = candidate
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/^https\\:/i, 'https:')
    .replace(/^http\\:/i, 'http:');
  candidate = candidate.replace(/[\s"'<>]+$/g, '');
  if (!/^https?:\/\//i.test(candidate)) return null;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch (_) {
    return null;
  }
}

function extractPlayableSources(html) {
  const text = String(html || '');
  const candidates = [];
  const patterns = [
    { kind: 'MP4 SD', regex: /html5player\.setVideoUrlLow\s*\(\s*(['"])(.*?)\1\s*\)/gis, group: 2, rank: 1 },
    { kind: 'MP4 HD', regex: /html5player\.setVideoUrlHigh\s*\(\s*(['"])(.*?)\1\s*\)/gis, group: 2, rank: 2 },
    { kind: 'HLS', regex: /html5player\.setVideoHLS\s*\(\s*(['"])(.*?)\1\s*\)/gis, group: 2, rank: 3 },
    { kind: 'MP4', regex: /["']contentUrl["']\s*:\s*["'](https?:\\?\/\\?\/[^"']+?\.mp4(?:\?[^"']*)?)["']/gis, group: 1, rank: 1 }
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const url = cleanExtractedUrl(match[pattern.group || 2]);
      if (!url) continue;
      const lower = url.toLowerCase();
      const isHls = /\.m3u8(?:[?#]|$)/i.test(lower) || pattern.kind === 'HLS';
      const isMp4 = /\.mp4(?:[?#]|$)/i.test(lower);
      if (!isHls && !isMp4) continue;
      candidates.push({ title: pattern.kind, url, rank: pattern.rank, type: isHls ? 'hls' : 'mp4' });
    }
  }

  // Remove duplicados; o site pode repetir o mesmo endereço em Low e High.
  const unique = new Map();
  for (const item of candidates.sort((a, b) => a.rank - b.rank)) {
    if (!unique.has(item.url)) unique.set(item.url, item);
  }
  return [...unique.values()];
}

async function resolveVideoStreams(pageUrl) {
  const cached = playableCache.get(pageUrl);
  if (cached && Date.now() - cached.at < 2 * 60 * 1000) return cached.streams;

  const { html } = await fetchHTML(pageUrl);
  const streams = extractPlayableSources(html);
  playableCache.set(pageUrl, { at: Date.now(), streams });
  return streams;
}

async function getSourcePage(extra, page) {
  const url = buildSourcePageUrl(extra, page);
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const { html, status, finalUrl } = await fetchHTML(url);
  const items = extractVideos(html, page);
  pageCache.set(url, { at: Date.now(), items });
  lastCatalogDiagnostic = {
    at: new Date().toISOString(), status: 'ok', httpStatus: status,
    requestedUrl: url, finalUrl, htmlBytes: Buffer.byteLength(String(html)), extracted: items.length,
    pageTitle: cheerio.load(html)('title').first().text().trim().slice(0, 200)
  };
  console.log(`[CATÁLOGO] página ${page}: HTTP ${status}; ${items.length} itens extraídos.`);
  return items;
}

async function loadCatalogPage(extra) {
  const skip = Math.max(0, Number.parseInt(extra.skip, 10) || 0);
  const firstSourcePage = Math.floor(skip / SOURCE_PAGE_SIZE) + 1;
  const offsetInFirstPage = skip % SOURCE_PAGE_SIZE;
  const needed = CATALOG_PAGE_SIZE + offsetInFirstPage;
  const collected = new Map();

  for (let i = 0; i < MAX_SOURCE_PAGES && collected.size < needed; i++) {
    const sourcePage = firstSourcePage + i;
    const items = await getSourcePage(extra, sourcePage);
    for (const item of items) {
      if (!collected.has(item.meta.id)) collected.set(item.meta.id, item);
    }
    // Uma página vazia encerra a busca; página curta pode ser resultado de bloqueio/layout.
    if (items.length === 0) break;
  }

  const all = [...collected.values()];
  const selected = all.slice(offsetInFirstPage, offsetInFirstPage + CATALOG_PAGE_SIZE);
  for (const item of selected) {
    metaCache.set(item.meta.id, item.meta);
    streamUrlCache.set(item.meta.id, item.url);
  }
  return selected.map(item => item.meta);
}

builder.defineCatalogHandler(async ({ extra = {} }) => {
  try {
    const metas = await loadCatalogPage(extra);
    console.log(`[CATÁLOGO] devolvendo ${metas.length} itens ao Stremio (skip=${extra.skip || 0}).`);
    return { metas };
  } catch (error) {
    lastCatalogDiagnostic = {
      at: new Date().toISOString(), status: 'erro',
      message: error.message,
      httpStatus: error.response?.status || null,
      url: error.config?.url || null,
      responsePreview: typeof error.response?.data === 'string'
        ? error.response.data.slice(0, 500) : null
    };
    console.error('[ERRO CATÁLOGO]', lastCatalogDiagnostic);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ id }) => {
  if (metaCache.has(id)) return { meta: metaCache.get(id) };
  const key = String(id || '').startsWith('xv:') ? String(id).slice(3) : '';
  if (!/^[a-z0-9]+$/i.test(key)) return { meta: null };
  return {
    meta: {
      id, type: 'movie', name: `Vídeo ${key}`,
      poster: FALLBACK_POSTER, posterShape: 'landscape'
    }
  };
});

builder.defineStreamHandler(async ({ id }) => {
  const pageUrl = streamUrlCache.get(id);
  if (!pageUrl) {
    console.warn(`[STREAM] URL da página não está no cache para ${id}. Atualize o catálogo e tente novamente.`);
    return { streams: [] };
  }

  try {
    const sources = await resolveVideoStreams(pageUrl);
    if (!sources.length) {
      console.warn(`[STREAM] Nenhum MP4/HLS encontrado na página ${pageUrl}`);
      return { streams: [] };
    }

    const streams = sources.map((source, index) => ({
      title: `▶ ${source.title}${sources.length > 1 ? ` (${index + 1})` : ''}`,
      url: source.url,
      behaviorHints: {
        bingeGroup: 'xv-sniper',
        proxyHeaders: { request: { Referer: pageUrl, Origin: BASE_URL } }
      }
    }));

    console.log(`[STREAM] ${streams.length} fonte(s) extraída(s) para ${id}.`);
    return { streams };
  } catch (error) {
    console.error(`[STREAM] Falha ao extrair fontes de ${pageUrl}:`, error.message);
    return { streams: [] };
  }
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', addon: 'xVideos Sniper', version: '18.0.0', port: PORT, node: process.version });
});

// Diagnóstico acessível pelo navegador: http://IP-DA-MAQUINA:7014/diagnostico
app.get('/diagnostico', async (_req, res) => {
  try {
    const { html, status, finalUrl } = await fetchHTML(buildSourcePageUrl({}, 1));
    const $ = cheerio.load(html);
    const extracted = extractVideos(html, 1);
    res.json({
      addon: 'xVideos Sniper 18.0.0', httpStatus: status, finalUrl,
      pageTitle: $('title').first().text().trim(), htmlBytes: Buffer.byteLength(String(html)),
      videoLinksFound: $('a[href]').filter((_, a) => !!getVideoIdentity($(a).attr('href'))).length,
      extractedCount: extracted.length,
      samples: extracted.slice(0, 5).map(x => ({ id: x.meta.id, name: x.meta.name, poster: x.meta.poster })),
      lastCatalogDiagnostic
    });
  } catch (error) {
    res.status(502).json({
      status: 'falha ao acessar o site', message: error.message,
      httpStatus: error.response?.status || null,
      responsePreview: typeof error.response?.data === 'string' ? error.response.data.slice(0, 500) : null
    });
  }
});

app.use('/', getRouter(builder.getInterface()));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log('================================================');
    console.log(' xVideos Sniper 18.0.0 iniciado');
    console.log(` Node: ${process.version}`);
    console.log(` Manifesto: http://localhost:${PORT}/manifest.json`);
    console.log(` Diagnóstico: http://localhost:${PORT}/diagnostico`);
    console.log('================================================');
  });
}

module.exports = { app, extractVideos, extractPlayableSources, buildSourcePageUrl, getVideoIdentity };
