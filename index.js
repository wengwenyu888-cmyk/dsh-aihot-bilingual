/**
 * Host half of the `@local/aihot-bilingual` bundle.
 *
 * Serves three same-origin HTTP routes under `/api/aihot-bilingual`:
 *   GET  /items   — slim AIHOT item list (anonymous JSON API, UA `aihot-api/2.0.0`)
 *   POST /doc     — one bilingual document as NDJSON events (progressive fill)
 *   POST /word    — one English word's meaning in its sentence context (JSON)
 *
 * Translations call the harness `llm` service with the user's default model,
 * so no extra API key is needed. English originals are fetched from the item's
 * source link; when extraction fails or the source is Chinese, the AIHOT
 * Chinese text becomes the base and English is translated from it. Whichever
 * side is the translation, English paragraphs and Chinese paragraphs stay in a
 * strict one-to-one, in-order correspondence.
 */

const AIHOT_BASE = 'https://aihot.news';
const AIHOT_UA = 'aihot-api/2.0.0';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ROUTE_PREFIX = '/api/aihot-bilingual';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ARTICLE_MAX_BYTES = 3 * 1024 * 1024;
const MAX_PARAGRAPHS = 120;
const MAX_SOURCE_CHARS = 40000;
const CHUNK_PARAGRAPHS = 16;
const CHUNK_OVERLAP = 2;
const LLM_TIMEOUT_MS = 180000;
const LLM_MAX_TOKENS = 8000;
const DEBUG_RAW = false;

const THINK_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
const THINK_CLOSE = String.fromCharCode(60) + '/' + 'think' + String.fromCharCode(62);

/**
 * Some providers stream the model's thinking inside text deltas, and models
 * often restate the JSON output template while thinking. Everything before
 * the last closing think tag is dropped; while a think block is still open,
 * nothing is considered visible yet.
 */
function stripThinking(text) {
  const close = text.lastIndexOf(THINK_CLOSE);
  if (close >= 0) return text.slice(close + THINK_CLOSE.length);
  if (text.includes(THINK_OPEN)) return '';
  return text;
}

export const inject = ['llm', 'agentDefaultModel'];

export function apply(ctx) {
  const api = createApi(ctx);
  ctx.inject(['webServer'], (web) => {
    web.effect(
      () =>
        web.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            api.handle(req, res).catch((error) => {
              if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              }
              try {
                res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
              } catch {}
            });
          },
        }),
      'aihot-bilingual: api routes',
    );
  });
}

function createApi(ctx) {
  /** @type {Promise<{provider: string, model: string}> | null} */
  let routePromise = null;

  function resolveRoute() {
    if (!routePromise) {
      routePromise = (async () => {
        let provider;
        let model;
        try {
          const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
          const p = typeof selection?.provider === 'string' ? selection.provider : selection?.provider?.id;
          const m = typeof selection?.model === 'string' ? selection.model : selection?.model?.id;
          if (p && m) {
            provider = p;
            model = m;
          }
        } catch {}
        if (!provider) {
          const providers = ctx.llm.listProviders();
          provider = providers[0]?.id;
        }
        if (provider && !model) {
          const models = await ctx.llm.listModels(provider).catch(() => []);
          model = models[0]?.id;
        }
        if (!provider || !model) throw new Error('没有可用的模型（未配置任何模型提供商）');
        return { provider, model };
      })().catch((error) => {
        routePromise = null;
        throw error;
      });
    }
    return routePromise;
  }

  /**
   * One assistant-style model call, collecting streamed text deltas.
   * @param {{ system?: string, user: string, signal?: AbortSignal, onDelta?: (delta: string, full: string) => void }} input
   */
  async function llmText({ system, user, signal, onDelta }) {
    const { provider, model } = await resolveRoute();
    const messages = [];
    if (system) messages.push({ role: 'system', content: [{ type: 'text', text: system }] });
    messages.push({ role: 'user', content: [{ type: 'text', text: user }] });
    const stream = ctx.llm.stream({
      provider,
      model,
      messages,
      maxTokens: LLM_MAX_TOKENS,
      signal,
    });
    let text = '';
    for await (const chunk of stream) {
      if (signal?.aborted) break;
      if (chunk.type === 'text-delta') {
        text += chunk.text;
        onDelta?.(chunk.text, text);
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || '模型调用失败');
      } else if (chunk.type === 'finish' && chunk.reason?.kind === 'aborted') {
        break;
      }
    }
    return text;
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const path = url.pathname;
    if (req.method === 'GET' && path === ROUTE_PREFIX + '/items') return handleItems(res, url);
    if (req.method === 'POST' && path === ROUTE_PREFIX + '/doc') return handleDoc(req, res);
    if (req.method === 'POST' && path === ROUTE_PREFIX + '/word') return handleWord(req, res);
    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  function sendJson(res, status, value) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }

  function readBody(req, cap) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > cap) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function readJsonBody(req) {
    const raw = (await readBody(req, MAX_BODY_BYTES)).toString('utf8');
    return raw.trim() === '' ? {} : JSON.parse(raw);
  }

  /* ------------------------------------------------------------------ */
  /* GET /items                                                          */
  /* ------------------------------------------------------------------ */

  async function handleItems(res, url) {
    const window = url.searchParams.get('window') === '24h' ? '24h' : '7d';
    const limitRaw = Number(url.searchParams.get('limit') ?? 30);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 30, 1), 30);
    const target = `${AIHOT_BASE}/api/v1/items?mode=selected&window=${window}&limit=${limit}`;
    try {
      const response = await fetch(target, {
        headers: { 'user-agent': AIHOT_UA, accept: 'application/json', 'accept-encoding': 'gzip, br' },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        sendJson(res, 502, { ok: false, error: `AIHOT 返回 ${response.status}` });
        return;
      }
      const data = await response.json();
      const items = (Array.isArray(data?.items) ? data.items : []).map((it) => ({
        id: String(it.id ?? ''),
        title: String(it.title ?? ''),
        originalTitle: it.originalTitle == null ? '' : String(it.originalTitle),
        summary: String(it.summary ?? ''),
        reason: String(it.reason ?? ''),
        sourceName: String(it.source?.name ?? ''),
        category: it.category == null ? '' : String(it.category),
        publishedAt: it.publishedAt == null ? '' : String(it.publishedAt),
        aihotUrl: String(it.links?.aihot ?? ''),
        originalUrl: String(it.links?.original ?? ''),
      }));
      sendJson(res, 200, { ok: true, fetchedAt: Date.now(), items });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: 'AIHOT 暂时不可用：' + String(error?.message ?? error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* POST /doc                                                           */
  /* ------------------------------------------------------------------ */

  async function handleDoc(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'bad json: ' + String(error?.message ?? error) });
      return;
    }
    const item = {
      id: String(body.id ?? ''),
      title: String(body.title ?? ''),
      originalTitle: body.originalTitle == null ? '' : String(body.originalTitle),
      summary: String(body.summary ?? ''),
      reason: String(body.reason ?? ''),
      originalUrl: String(body.originalUrl ?? ''),
    };
    if (item.id === '') {
      sendJson(res, 400, { ok: false, error: 'id 必填' });
      return;
    }

    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    });
    const send = (event) => {
      try {
        res.write(JSON.stringify(event) + '\n');
      } catch {}
    };
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      await buildDoc(item, send, abort.signal);
      if (!abort.signal.aborted) send({ event: 'done' });
    } catch (error) {
      if (!abort.signal.aborted) send({ event: 'error', message: String(error?.message ?? error) });
    } finally {
      try {
        res.end();
      } catch {}
    }
  }

  /**
   * Build the bilingual document and stream NDJSON events:
   *   {event:'meta', source, titleEn, titleZh, paragraphs:[{type, en?, zh?}]}
   *   {event:'title', text}         — the translated title
   *   {event:'p', i, text}          — translation for paragraph index i
   *   {event:'warn', message}       — non-fatal issue (e.g. count mismatch)
   *   {event:'error', message}      — fatal
   */
  async function buildDoc(item, send, signal) {
    const extracted = item.originalUrl === '' ? null : await fetchOriginal(item.originalUrl);
    const extractedUseful =
      extracted !== null && extracted.paragraphs.length > 0 && countLatin(extracted.text) >= 400;

    let source;
    let titleEn = '';
    let titleZh = '';
    let baseParas = [];
    if (extractedUseful && extracted.cjkDominant === false) {
      source = 'en';
      titleEn = (extracted.title || item.originalTitle || '').trim() || item.title;
      baseParas = extracted.paragraphs;
    } else if (extractedUseful && extracted.cjkDominant === true) {
      source = 'zh';
      titleZh = (extracted.title || item.title).trim();
      baseParas = extracted.paragraphs;
    } else {
      source = 'zh';
      titleZh = item.title;
      const summary = item.summary.trim();
      const reason = item.reason.trim();
      if (summary !== '') baseParas.push({ type: 'p', text: summary });
      if (reason !== '') baseParas.push({ type: 'p', text: reason });
    }

    baseParas = baseParas.slice(0, MAX_PARAGRAPHS);
    // Drop a leading heading that merely repeats the page title.
    if (baseParas.length > 0 && baseParas[0].type === 'h') {
      const head = baseParas[0].text.replace(/\s+/g, ' ').trim().toLowerCase();
      const titleText = (source === 'en' ? titleEn : titleZh).replace(/\s+/g, ' ').trim().toLowerCase();
      if (titleText !== '' && (head === titleText || titleText.startsWith(head) || head.startsWith(titleText))) {
        baseParas = baseParas.slice(1);
      }
    }
    let budget = MAX_SOURCE_CHARS;
    baseParas = baseParas.filter((para) => {
      budget -= para.text.length;
      return budget >= 0;
    });

    send({
      event: 'meta',
      source,
      titleEn,
      titleZh,
      paragraphs: baseParas.map((para) => ({
        type: para.type,
        ...(source === 'en' ? { en: para.text } : { zh: para.text }),
      })),
    });

    if (baseParas.length === 0) return;

    const sourceTitle = source === 'en' ? titleEn : titleZh;

    const translation = await translateParagraphs({
      direction: source === 'en' ? 'en2zh' : 'zh2en',
      title: sourceTitle,
      paragraphs: baseParas.map((para) => para.text),
      signal,
      onItem: (index, text) => send({ event: 'p', i: index, text }),
      onTitle: (text) => send({ event: 'title', text }),
    });
    if (DEBUG_RAW) {
      send({ event: 'debug', raw: String(translation?.raw ?? '').slice(0, 1600) });
    }
  }

  async function translateParagraphs({ direction, title, paragraphs, signal, onItem, onTitle }) {
    const chunks = [];
    for (let start = 0; start < paragraphs.length; start += CHUNK_PARAGRAPHS) {
      chunks.push(paragraphs.slice(start, start + CHUNK_PARAGRAPHS));
    }
    let translatedTail = '';
    let lastRaw = '';
    for (let ci = 0; ci < chunks.length; ci++) {
      if (signal?.aborted) break;
      const chunk = chunks[ci];
      const offset = ci * CHUNK_PARAGRAPHS;
      const parser = createStreamParser((index, text) => onItem(offset + index, text), chunk.length);
      let text = '';
      try {
        text = await llmText({
          system: systemPrompt(direction),
          user: userPrompt(direction, title, chunk, translatedTail, offset, paragraphs.length),
          signal,
          onDelta: (_delta, full) => {
            lastRaw = full;
            parser.feed(full);
          },
        });
      } catch (error) {
        if (signal?.aborted) break;
        if (ci === 0) throw error;
        translatedTail = '';
        continue;
      }
      if (signal?.aborted) break;
      parser.feed(text);
      parser.finish();
      const fixed = parser.getResult();
      if (typeof fixed.title === 'string' && fixed.title.trim() !== '') onTitle(fixed.title.trim());
      chunk.forEach((sourcePara, local) => {
        const translated = fixed.paragraphs[local];
        if (typeof translated === 'string' && translated.trim() !== '') onItem(offset + local, translated.trim());
      });
      translatedTail = chunk.slice(Math.max(0, chunk.length - CHUNK_OVERLAP)).join('\n');
      if (translatedTail.length > 1200) translatedTail = translatedTail.slice(0, 1200);
    }
    return { raw: lastRaw };
  }

  function systemPrompt(direction) {
    if (direction === 'en2zh') {
      return [
        '你是一位资深中英双语编辑，为正在学习英语的中文读者把英文 AI 新闻整篇译成自然的中文。',
        '规则：',
        '1) 结合全文语境意译，像人写的中文科技新闻，禁止逐词直译的翻译腔。',
        '2) 公司、产品、模型、人物等专有名词保留英文原文；非常常见的可写成「中文（英文）」。',
        '3) 数字、代码、命令、链接原样保留；列表条目保持列表的简洁感。',
        '4) 标题译成简洁有力的中文新闻标题。',
        '5) 输出严格为 JSON：{"title":"整篇标题的中文译文","paragraphs":["第1段译文","第2段译文",...]}',
        '6) paragraphs 数组必须与输入段落一一对应：数量相同、顺序相同，不得合并、拆分、增删。',
        '7) 只输出这一个 JSON，不要任何解释，不要 Markdown 代码块。',
      ].join('\n');
    }
    return [
      'You are a senior bilingual editor. Translate the whole Chinese AI-news article into natural, idiomatic English for a Chinese reader who is learning English.',
      'Rules:',
      '1) Translate the article as a whole with full context; write it like a human English tech-news editor. No word-by-word stiffness.',
      '2) Keep proper nouns (companies, products, models, people) in their original form.',
      '3) Keep numbers, code, commands and links as-is; keep list items concise.',
      '4) The output must be exactly this JSON: {"title":"<full title translated to English>","paragraphs":["<paragraph 1>",...]}',
      '5) paragraphs must map one-to-one to the input paragraphs: same count, same order, no merging or splitting.',
      '6) Output only this JSON. No explanations, no Markdown fences.',
    ].join('\n');
  }

  function userPrompt(direction, title, chunk, translatedTail, offset, total) {
    const lines = [];
    if (direction === 'en2zh') {
      lines.push('标题：', title, '', `正文共 ${total} 段，下面是第 ${offset + 1}–${offset + chunk.length} 段（编号只是说明，输出时不带编号）：`);
    } else {
      lines.push('Title:', title, '', `The article has ${total} paragraphs; below are paragraphs ${offset + 1}–${offset + chunk.length} (the numbers are just markers, do not include them in the output):`);
    }
    chunk.forEach((text, index) => {
      lines.push(`[${offset + index + 1}] ${text}`);
    });
    if (translatedTail !== '') {
      if (direction === 'en2zh') {
        lines.push('', '（前文最后几段的原文，仅供理解语境，不要翻译输出它们）', translatedTail);
      } else {
        lines.push('', '(The last paragraphs of the earlier part are given for context only; do not translate them.)', translatedTail);
      }
    }
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* POST /word                                                          */
  /* ------------------------------------------------------------------ */

  async function handleWord(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad json' });
      return;
    }
    const word = String(body.word ?? '').trim();
    const sentence = String(body.sentence ?? '').trim().slice(0, 600);
    const context = String(body.context ?? '').trim().slice(0, 1200);
    if (word === '' || sentence === '') {
      sendJson(res, 400, { ok: false, error: 'word 和 sentence 必填' });
      return;
    }
    try {
      const raw = await llmText({
        system:
          '你是英汉词典助手。给定一个英文单词和它出现的英文句子（以及所在段落作为上下文），给出该词在这个上下文里的准确中文释义。' +
          '严格输出 JSON（不要解释、不要 Markdown 代码块）：' +
          '{"meaning":"这个词在该句中的中文释义，简短准确","pos":"中文词性，如 名词/动词/形容词/副词/短语","ipa":"美式音标，形如 /wɜːrd/，无法确定时给空字符串"}',
        user: `单词：${word}\n句子：${sentence}\n上下文段落：${context === '' ? sentence : context}`,
        signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      });
      const data = parseLooseJson(raw);
      if (data === null || typeof data.meaning !== 'string') throw new Error('模型返回格式异常');
      sendJson(res, 200, {
        ok: true,
        data: {
          word,
          meaning: String(data.meaning),
          pos: String(data.pos ?? ''),
          ipa: String(data.ipa ?? ''),
        },
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: '释义查询失败：' + String(error?.message ?? error) });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Original article fetch + extraction                                 */
  /* ------------------------------------------------------------------ */

  async function fetchOriginal(url) {
    let response;
    try {
      response = await fetch(url, {
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      return null;
    }
    try {
      if (!response.ok) return null;
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('html')) return null;
      const buffer = await response.arrayBuffer();
      const slice = buffer.byteLength > ARTICLE_MAX_BYTES ? buffer.slice(0, ARTICLE_MAX_BYTES) : buffer;
      const html = new TextDecoder('utf-8').decode(slice);
      return extractArticle(html);
    } catch {
      return null;
    } finally {
      // Body is already consumed by arrayBuffer(); cancelling a locked stream
      // returns a REJECTED promise instead of throwing, and that unhandled
      // rejection kills the whole DSH host process.
      const body = response.body;
      if (body !== null && body !== undefined && !body.locked) {
        try {
          const pending = body.cancel();
          if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch {}
      }
    }
  }

  const ENTITY_MAP = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•',
    copy: '©', reg: '®', trade: '™', times: '×', laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£',
  };

  function decodeEntities(text) {
    return text
      .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body.startsWith('#x') || body.startsWith('#X')) {
          const code = parseInt(body.slice(2), 16);
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        if (body.startsWith('#')) {
          const code = parseInt(body.slice(1), 10);
          return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        const mapped = ENTITY_MAP[body.toLowerCase()];
        return mapped === undefined ? whole : mapped;
      })
      .replace(/[ \t]+/g, ' ');
  }

  const BLOCKING_TAGS =
    /<(script|style|noscript|svg|iframe|form|template|button|select)\b[\s\S]*?<\/\1\s*>/gi;
  const COMMENTS = /<!--[\s\S]*?-->/g;
  const HEAD_SECTION = /<head\b[\s\S]*?<\/head\s*>/gi;

  function extractArticle(html) {
    let title = '';
    const ogTitle = /<meta[^>]+property=["']og:title["'][^>]*>/i.exec(html);
    if (ogTitle) {
      const content = /content=["']([^"']*)["']/i.exec(ogTitle[0]);
      if (content) title = decodeEntities(content[1]).trim();
    }
    if (title === '') {
      const titleTag = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
      if (titleTag) title = decodeEntities(titleTag[1]).trim();
    }
    if (title.length > 200) title = title.slice(0, 200);

    let scope = html;
    let articleMatch = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(html);
    if (articleMatch === null) {
      const mainMatch = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(html);
      if (mainMatch !== null) articleMatch = mainMatch;
    }
    if (articleMatch !== null) {
      scope = articleMatch[0];
    } else {
      scope = html.replace(HEAD_SECTION, '');
    }
    scope = scope.replace(COMMENTS, ' ').replace(BLOCKING_TAGS, ' ');

    const paragraphs = [];
    const blockRe = /<(p|h1|h2|h3|h4|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
    let match;
    while ((match = blockRe.exec(scope)) !== null) {
      if (paragraphs.length >= MAX_PARAGRAPHS) break;
      const tag = match[1].toLowerCase();
      let text = decodeEntities(match[2].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (text === '') continue;
      if (isBoilerplate(text)) continue;
      const type = tag.startsWith('h') ? 'h' : tag === 'li' ? 'li' : tag === 'blockquote' ? 'quote' : 'p';
      if (type === 'p' && text.length < 40) continue;
      paragraphs.push({ type, text });
    }
    const text = paragraphs.map((para) => para.text).join('\n');
    return {
      title,
      paragraphs,
      text,
      cjkDominant: countCJK(text) > countLatin(text),
    };
  }

  function isBoilerplate(text) {
    const short = text.length < 160;
    if (!short) return false;
    return /cookie|subscribe|newsletter|sign in|sign up|log in|advertisement|accept all|manage preferences|share this|follow us|all rights reserved|see original|skip to (main |)content|toggle navigation|skip navigation/i.test(text);
  }

  function countLatin(text) {
    return (text.match(/[A-Za-z]/g) ?? []).length;
  }
  function countCJK(text) {
    return (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  }

  /* ------------------------------------------------------------------ */
  /* JSON streaming helpers                                              */
  /* ------------------------------------------------------------------ */

  function stripFences(text) {
    let out = text.trim();
    out = out.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    return out;
  }

  /**
   * Incremental scanner for `{"title":"...","paragraphs":["...","..."]}`.
   * Calls onItem(localIndex, parsedString) for each completed array element.
   */
  function createStreamParser(onItem, maxItems) {
    let state = 'findKey';
    let stringBuf = '';
    let escape = false;
    let depth = 0;
    let title = null;
    let count = 0;
    let fullRaw = '';
    let scanned = 0;
    let consumed = 0;
    let filterState = 'out';
    let filterBuf = '';

    /**
     * Feed the accumulated model output. Feeds may overlap (every delta
     * carries the full text so far); only the unprocessed suffix is accepted.
     * While the JSON has not started (`findKey`), think blocks streamed inside
     * text deltas are dropped; after it starts, everything passes through.
     */
    function feed(text) {
      const fresh = text.length > consumed ? text.slice(consumed) : '';
      if (consumed < text.length) consumed = text.length;
      for (let i = 0; i < fresh.length; i++) pushChar(fresh[i]);
    }

    function pushChar(ch) {
      if (state !== 'findKey') {
        accept(ch);
        return;
      }
      filterBuf += ch;
      if (filterState === 'think') {
        if (filterBuf.endsWith(THINK_CLOSE)) {
          filterState = 'out';
          filterBuf = '';
        } else if (filterBuf.length > THINK_CLOSE.length) {
          filterBuf = filterBuf.slice(-THINK_CLOSE.length);
        }
        return;
      }
      if (filterBuf.endsWith(THINK_OPEN)) {
        filterState = 'think';
        filterBuf = '';
        return;
      }
      if (filterBuf.length > THINK_OPEN.length) {
        const flush = filterBuf.slice(0, filterBuf.length - THINK_OPEN.length);
        filterBuf = filterBuf.slice(-THINK_OPEN.length);
        accept(flush);
      }
    }

    function accept(text) {
      fullRaw += text;
      if (state === 'findKey') {
        const probe = fullRaw.lastIndexOf('"paragraphs"');
        if (probe >= 0) {
          const bracket = fullRaw.indexOf('[', probe);
          if (bracket >= 0 && bracket < fullRaw.length) {
            state = 'array';
            scanned = bracket + 1;
            if (filterBuf !== '') {
              const pending = filterBuf;
              filterBuf = '';
              filterState = 'out';
              accept(pending);
            }
          }
        }
      }
      if (title === null) {
        let lastMatch = null;
        const titleRe = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
        let m;
        while ((m = titleRe.exec(fullRaw)) !== null) lastMatch = m;
        if (lastMatch) {
          try {
            title = JSON.parse('"' + lastMatch[1] + '"');
          } catch {}
        }
      }
      for (let i = scanned; i < fullRaw.length; i++) {
        scanned = i + 1;
        step(fullRaw[i]);
      }
    }

    function step(ch) {
      switch (state) {
        case 'array': {
          if (escape) {
            escape = false;
            if (depth === 1) stringBuf += ch;
            break;
          }
          if (ch === '\\') {
            escape = true;
            if (depth === 1) stringBuf += ch;
            break;
          }
          if (ch === '"') {
            if (depth === 0) {
              depth = 1;
              stringBuf = '';
            } else {
              depth = 0;
              emit();
            }
            break;
          }
          if (depth === 1) {
            stringBuf += ch;
            break;
          }
          if (ch === '{' || ch === '[') {
            depth = 9;
            break;
          }
          if (ch === '}' || ch === ']' || ch === ',') {
            if (depth === 9) {
              depth = 0;
              break;
            }
            if (ch === ']') {
              state = 'done';
              break;
            }
            state = 'between';
            break;
          }
          break;
        }
        case 'between': {
          if (ch === '"') {
            depth = 1;
            stringBuf = '';
            state = 'array';
            break;
          }
          if (ch === ']') {
            state = 'done';
            break;
          }
          if (ch === ',' || ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') break;
          depth = 9;
          state = 'array';
          break;
        }
        default:
          break;
      }
    }

    function emit() {
      const element = '"' + stringBuf + '"';
      stringBuf = '';
      try {
        const value = JSON.parse(element);
        if (typeof value === 'string') {
          onItem(count, value);
          count += 1;
          if (Number.isFinite(maxItems) && count >= maxItems) state = 'done';
        }
      } catch {}
    }

    function finish() {
      if (filterBuf !== '' && state === 'findKey') {
        const rest = filterBuf;
        filterBuf = '';
        accept(rest);
      }
    }
    function getResult() {
      let fixedTitle = title;
      let paragraphs = [];
      const candidates = [stripFences(fullRaw)];
      const first = candidates[0];
      const openAt = first.indexOf(THINK_OPEN);
      const closeAt = first.lastIndexOf(THINK_CLOSE);
      if (closeAt >= 0) candidates.push(first.slice(closeAt + THINK_CLOSE.length));
      if (openAt >= 0) candidates.push(first.slice(0, openAt));
      for (const candidate of candidates) {
        if (paragraphs.length > 0) break;
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.title === 'string') fixedTitle = parsed.title;
            if (Array.isArray(parsed.paragraphs)) {
              paragraphs = parsed.paragraphs.filter((entry) => typeof entry === 'string');
            }
          }
        } catch {}
      }
      return { title: fixedTitle, paragraphs, count };
    }
    return { feed, finish, getResult };
  }

  function parseLooseJson(text) {
    const cleaned = stripFences(stripThinking(text));
    try {
      return JSON.parse(cleaned);
    } catch {}
    const start = cleaned.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '{') depth += 1;
      if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  return { handle };
}
