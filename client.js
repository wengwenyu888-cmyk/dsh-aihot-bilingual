/**
 * Client half of the `@local/aihot-bilingual` bundle.
 *
 * Registers a sidebar rail icon and a full main panel: the AIHOT bilingual
 * reader. The list shows AIHOT items; the detail view shows the English text
 * in large type with the Chinese reference in small type, paragraph by
 * paragraph, filled progressively while the Host translates. Clicking an
 * English word opens a popover with its meaning in that sentence, part of
 * speech, IPA and speech. Caches (item list, documents, word lookups and the
 * vocabulary book) live in localStorage, so reopening a read article is
 * instant.
 */
window.__ModuleLoader__.load({
  id: '@local/aihot-bilingual',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const PANEL_ID = 'aihot-bilingual';
    const LS_ITEMS = 'aihotBilingual.items.v1';
    const LS_DOC_PREFIX = 'aihotBilingual.doc.v1.';
    const LS_DOC_INDEX = 'aihotBilingual.docIndex.v1';
    const LS_VOCAB = 'aihotBilingual.vocab.v1';
    const LS_WORD_PREFIX = 'aihotBilingual.word.v1.';
    const DOC_CACHE_LIMIT = 60;
    const ITEMS_TTL_MS = 60000;

    const CATEGORY_ZH = {
      'ai-models': '模型',
      'ai-products': '产品',
      industry: '行业',
      paper: '论文',
      tip: '教程',
      opinion: '观点',
    };

    const DICT = {
      en: {
        panelLabel: 'AIHOT bilingual reader',
        tabNews: 'News',
        tabVocab: 'Vocabulary',
        refresh: 'Refresh',
        loadingItems: 'Loading AIHOT…',
        emptyItems: 'AIHOT has nothing right now.',
        back: 'Back',
        aiHotPage: 'AIHOT page',
        original: 'Original',
        retranslate: 'Re-translate',
        translating: 'Translating…',
        cached: 'From cache',
        saveWord: 'Save to vocabulary',
        saved: 'Saved',
        speak: 'Speak',
        meaning: 'In this sentence',
        vocabEmpty: 'No saved words yet. Click any English word while reading.',
        vocabExport: 'Export CSV',
        vocabClear: 'Clear',
        delete: 'Delete',
        dataSource: 'Data source',
        retry: 'Retry',
      },
      zh: {
        panelLabel: 'AIHOT 双语阅读',
        tabNews: '资讯',
        tabVocab: '生词本',
        refresh: '刷新',
        loadingItems: '正在加载 AIHOT…',
        emptyItems: 'AIHOT 暂无内容。',
        back: '返回',
        aiHotPage: 'AIHOT 页',
        original: '原文',
        retranslate: '重新翻译',
        translating: '正在翻译…',
        cached: '来自缓存',
        saveWord: '加入生词本',
        saved: '已收藏',
        speak: '朗读',
        meaning: '本句含义',
        vocabEmpty: '还没有收藏生词。阅读时点击任意英文单词即可收藏。',
        vocabExport: '导出 CSV',
        vocabClear: '清空',
        delete: '删除',
        dataSource: '数据来源',
        retry: '重试',
      },
    };

    /* ---------------------------------------------------------------- */
    /* Small utilities                                                   */
    /* ---------------------------------------------------------------- */

    function lsGet(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        return JSON.parse(raw);
      } catch {
        return fallback;
      }
    }

    function lsSet(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    }

    function lsRemove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    }

    function cacheDoc(id, doc) {
      const key = LS_DOC_PREFIX + id;
      lsSet(key, { savedAt: Date.now(), doc });
      const index = lsGet(LS_DOC_INDEX, []).filter((entry) => entry !== key);
      index.push(key);
      while (index.length > DOC_CACHE_LIMIT) {
        lsRemove(index.shift());
      }
      lsSet(LS_DOC_INDEX, index);
    }

    function loadDoc(id) {
      const hit = lsGet(LS_DOC_PREFIX + id, null);
      return hit && hit.doc ? hit : null;
    }

    function hashString(text) {
      let hash = 5381;
      for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
      return (hash >>> 0).toString(36);
    }

    function fmtTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function sentenceAround(text, index) {
      const isBoundary = (c) => c === '.' || c === '!' || c === '?';
      let start = index;
      while (start > 0) {
        const c = text[start - 1];
        if (isBoundary(c) && (start >= text.length || text[start] === ' ' || text[start] === '\n')) break;
        start -= 1;
      }
      let end = index;
      while (end < text.length) {
        const c = text[end];
        end += 1;
        if (isBoundary(c)) break;
      }
      let sentence = text.slice(start, end).trim();
      if (sentence.length > 400) {
        const from = Math.max(0, index - 180);
        const to = Math.min(text.length, index + 220);
        sentence = text.slice(from, to).trim();
      }
      return sentence;
    }

    function wordAtPoint(element, clientX, clientY) {
      let range = null;
      try {
        if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(clientX, clientY);
        else if (document.caretPositionFromPoint) {
          const position = document.caretPositionFromPoint(clientX, clientY);
          if (position) {
            range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
          }
        }
      } catch {
        return null;
      }
      if (!range || !element.contains(range.startContainer)) return null;
      const node = range.startContainer;
      const text = node.textContent ?? '';
      const offset = range.startOffset;
      const isWordChar = (c) => /[A-Za-z0-9'’-]/.test(c);
      let start = offset;
      let end = offset;
      while (start > 0 && isWordChar(text[start - 1])) start -= 1;
      while (end < text.length && isWordChar(text[end])) end += 1;
      if (end <= start) return null;
      const raw = text.slice(start, end).replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
      if (raw === '' || !/[A-Za-z]/.test(raw)) return null;
      let rect = null;
      try {
        const measure = document.createRange();
        measure.setStart(node, start);
        measure.setEnd(node, end);
        rect = measure.getBoundingClientRect();
      } catch {
        rect = null;
      }
      return { word: raw, start, rect };
    }

    function speak(text) {
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US';
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utterance);
      } catch {}
    }

    async function fetchItems(signal) {
      const response = await fetch('/api/aihot-bilingual/items?window=7d&limit=30', { signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data?.error ?? 'HTTP ' + response.status);
      return data;
    }

    async function fetchWord(word, sentence, context, signal) {
      const response = await fetch('/api/aihot-bilingual/word', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ word, sentence, context }),
        signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data?.error ?? 'HTTP ' + response.status);
      return data.data;
    }

    async function ensureWord(word, sentence, context, signal) {
      const key = LS_WORD_PREFIX + hashString(word.toLowerCase() + '|' + sentence);
      const cached = lsGet(key, null);
      if (cached) return cached;
      const data = await fetchWord(word, sentence, context, signal);
      lsSet(key, data);
      return data;
    }

    async function streamDoc(payload, onEvent, signal) {
      const response = await fetch('/api/aihot-bilingual/doc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
      if (!response.ok || !response.body) throw new Error('HTTP ' + response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt >= 0) {
          const line = buffer.slice(0, newlineAt).trim();
          buffer = buffer.slice(newlineAt + 1);
          if (line !== '') {
            try {
              onEvent(JSON.parse(line));
            } catch {}
          }
          newlineAt = buffer.indexOf('\n');
        }
      }
      const tail = buffer.trim();
      if (tail !== '') {
        try {
          onEvent(JSON.parse(tail));
        } catch {}
      }
    }

    function addVocab(entry) {
      const list = lsGet(LS_VOCAB, []);
      const key = entry.word.toLowerCase() + '|' + hashString(entry.sentence ?? '');
      if (list.some((existing) => existing.key === key)) return false;
      list.unshift({ ...entry, key, ts: Date.now() });
      lsSet(LS_VOCAB, list.slice(0, 500));
      return true;
    }

    const CSS = `
.aih-root{height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-height:0;}
.aih-header{display:flex;align-items:center;gap:10px;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-shrink:0;}
.aih-brand{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;}
.aih-tabs{display:flex;gap:4px;margin-left:auto;}
.aih-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 12px;border-radius:8px;cursor:pointer;font:inherit;font-size:13px;}
.aih-tab:hover{color:var(--dsw-alias-label-primary);}
.aih-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}
.aih-content{flex:1;overflow-y:auto;padding:16px 20px 24px;min-height:0;}
.aih-row{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin-bottom:10px;cursor:pointer;}
.aih-row:hover{border-color:var(--dsw-alias-border-l2);}
.aih-row-title{font-size:15px;font-weight:600;line-height:1.45;}
.aih-row-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;display:flex;gap:10px;flex-wrap:wrap;}
.aih-row-summary{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.55;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.aih-doc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.aih-back{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:3px 10px;cursor:pointer;font:inherit;font-size:12px;}
.aih-back:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.aih-doc-title{font-size:13px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:320px;}
.aih-title-en{font-size:22px;font-weight:700;line-height:1.35;margin:10px 0 2px;}
.aih-title-zh{font-size:14px;color:var(--dsw-alias-label-secondary);line-height:1.5;margin-bottom:8px;}
.aih-meta{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px;}
.aih-meta a{color:var(--dsw-alias-brand-primary);text-decoration:none;}
.aih-meta a:hover{text-decoration:underline;}
.aih-p-en{font-size:18px;line-height:1.7;margin:0;cursor:pointer;}
.aih-p-en.aih-h{font-weight:700;font-size:19px;}
.aih-p-en.aih-li{padding-left:14px;}
.aih-p-en.aih-quote{border-left:3px solid var(--dsw-alias-border-l2);padding-left:10px;color:var(--dsw-alias-label-secondary);}
.aih-p-zh{font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary);margin:2px 0 16px;}
.aih-p-zh.aih-h{font-weight:600;}
.aih-p-zh.aih-li{padding-left:14px;}
.aih-p-zh.aih-quote{border-left:3px solid var(--dsw-alias-border-l2);padding-left:10px;}
.aih-p-zh.aih-pending{opacity:.55;}
.aih-status{margin:16px 0;color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.aih-error{color:var(--dsw-alias-state-error-primary);}
.aih-warn{color:var(--dsw-alias-state-warn-primary);}
.aih-pop{position:fixed;z-index:80;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:10px 12px;width:320px;max-height:220px;overflow-y:auto;font-size:13px;}
.aih-pop-head{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;}
.aih-pop-word{font-weight:700;font-size:14px;}
.aih-pop-ipa{color:var(--dsw-alias-label-secondary);font-size:12px;}
.aih-pop-meaning{line-height:1.55;}
.aih-pop-foot{display:flex;gap:6px;margin-top:8px;align-items:center;}
.aih-iconbtn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 9px;cursor:pointer;font:inherit;font-size:12px;}
.aih-iconbtn:hover{border-color:var(--dsw-alias-border-l2);}
.aih-iconbtn[data-done="true"]{color:var(--dsw-alias-state-success-primary);}
.aih-footer{padding:10px 20px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:6px;flex-shrink:0;}
.aih-footer a{color:var(--dsw-alias-brand-primary);text-decoration:none;}
.aih-rail-btn{display:flex;align-items:center;justify-content:center;width:100%;border:none;background:transparent;color:inherit;cursor:pointer;padding:10px 0;}
.aih-rail-btn:hover{color:var(--dsw-alias-brand-primary);}
.aih-vocab-row{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);margin-bottom:8px;}
.aih-vocab-word{font-size:15px;font-weight:700;}
.aih-vocab-meaning{color:var(--dsw-alias-label-secondary);font-size:13px;margin-top:2px;line-height:1.5;}
.aih-vocab-src{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.aih-vocab-main{flex:1;min-width:0;}
.aih-muted{color:var(--dsw-alias-label-secondary);}
.aih-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:aih-spin 1s linear infinite;}
@keyframes aih-spin{to{transform:rotate(360deg)}}
`;

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        let translate = (key) => DICT.zh[key] ?? key;
        try {
          const locale = ctx.get('locale');
          if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
            locale.register('aihotBilingual', DICT);
            const bound = locale.bind('aihotBilingual');
            if (typeof bound === 'function') {
              translate = (key) => {
                try {
                  const value = bound(key);
                  return typeof value === 'string' && value !== '' ? value : DICT.zh[key] ?? key;
                } catch {
                  return DICT.zh[key] ?? key;
                }
              };
            }
          }
        } catch {}

        function selectPanel() {
          try {
            ctx.layout.selectPanel(PANEL_ID);
          } catch {
            try {
              ctx.get('layout')?.selectPanel?.(PANEL_ID);
            } catch {}
          }
        }

        function RailIcon() {
          return h(
            'svg',
            {
              viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true,
              style: { display: 'block', cursor: 'pointer', verticalAlign: 'middle' },
              onClick: (event) => {
                event.preventDefault();
                selectPanel();
              },
            },
            h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 }),
            h('path', { d: 'M7 9.5h5M7 12.5h10M7 15.5h10', stroke: 'currentColor', 'stroke-width': 1.6, fill: 'none', 'stroke-linecap': 'round' }),
            h('circle', { cx: 16.4, cy: 8.6, r: 2.7, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }),
            h('path', { d: 'M13.7 8.6h5.4M16.4 5.9v5.4M16.4 5.9c-1 0.9-1 4.4 0 5.4M16.4 5.9c1 0.9 1 4.4 0 5.4', stroke: 'currentColor', 'stroke-width': 1.1, fill: 'none' }),
          );
        }

        /* -------------------------------------------------------------- */
        /* List view                                                       */
        /* -------------------------------------------------------------- */

        function ListTab({ items, loading, error, onOpen, onRefresh }) {
          if (loading && !items) {
            return h('div', { className: 'aih-status' }, h('span', { className: 'aih-spin' }), translate('loadingItems'));
          }
          if (error && !items) {
            return h('div', { className: 'aih-status' }, h('span', { className: 'aih-error' }, error), h('button', { className: 'aih-iconbtn', onClick: onRefresh }, translate('retry')));
          }
          if (!items || items.length === 0) {
            return h('div', { className: 'aih-status' }, translate('emptyItems'));
          }
          return h(
            'div',
            null,
            items.map((item) =>
              h(
                'div',
                {
                  key: item.id,
                  className: 'aih-row',
                  onClick: () => onOpen(item),
                  role: 'button',
                  tabIndex: 0,
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') onOpen(item);
                  },
                },
                h('div', { className: 'aih-row-title' }, item.title),
                h(
                  'div',
                  { className: 'aih-row-meta' },
                  item.sourceName && h('span', null, item.sourceName),
                  item.category && h('span', null, CATEGORY_ZH[item.category] ?? item.category),
                  item.publishedAt && h('span', null, fmtTime(item.publishedAt)),
                ),
                item.summary && h('div', { className: 'aih-row-summary' }, item.summary),
              ),
            ),
          );
        }

        /* -------------------------------------------------------------- */
        /* Vocabulary tab                                                  */
        /* -------------------------------------------------------------- */

        function VocabTab({ entries, onChange }) {
          const exportCsv = () => {
            try {
              const rows = [['word', 'meaning', 'pos', 'ipa', 'sentence', 'article', 'savedAt']];
              for (const entry of entries) {
                rows.push([entry.word, entry.meaning, entry.pos ?? '', entry.ipa ?? '', entry.sentence ?? '', entry.article ?? '', new Date(entry.ts).toISOString()]);
              }
              const csv = '\ufeff' + rows.map((row) => row.map((cell) => '"' + String(cell).replaceAll('"', '""') + '"').join(',')).join('\r\n');
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'aihot-vocab.csv';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 2000);
            } catch {}
          };
          if (entries.length === 0) {
            return h('div', { className: 'aih-status' }, translate('vocabEmpty'));
          }
          return h(
            'div',
            null,
            h(
              'div',
              { className: 'aih-status' },
              h('button', { className: 'aih-iconbtn', onClick: exportCsv }, translate('vocabExport')),
              h(
                'button',
                {
                  className: 'aih-iconbtn',
                  onClick: () => {
                    lsSet(LS_VOCAB, []);
                    onChange();
                  },
                },
                translate('vocabClear'),
              ),
            ),
            entries.map((entry) =>
              h(
                'div',
                { key: entry.key, className: 'aih-vocab-row' },
                h(
                  'div',
                  { className: 'aih-vocab-main' },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 10, alignItems: 'baseline' } },
                    h('span', { className: 'aih-vocab-word' }, entry.word),
                    entry.ipa && h('span', { className: 'aih-muted', style: { fontSize: 12 } }, entry.ipa),
                    entry.pos && h('span', { className: 'aih-muted', style: { fontSize: 12 } }, entry.pos),
                  ),
                  h('div', { className: 'aih-vocab-meaning' }, entry.meaning),
                  entry.article && h('div', { className: 'aih-vocab-src' }, entry.article),
                ),
                h('button', { className: 'aih-iconbtn', onClick: () => speak(entry.word) }, '🔊'),
                h(
                  'button',
                  {
                    className: 'aih-iconbtn',
                    'aria-label': translate('delete'),
                    onClick: () => {
                      lsSet(LS_VOCAB, lsGet(LS_VOCAB, []).filter((existing) => existing.key !== entry.key));
                      onChange();
                    },
                  },
                  '✕',
                ),
              ),
            ),
          );
        }

        /* -------------------------------------------------------------- */
        /* Word popover                                                    */
        /* -------------------------------------------------------------- */

        function WordPopover({ info, onClose, onSaved }) {
          const rootRef = useRef(null);
          useEffect(() => {
            const onKey = (event) => {
              if (event.key === 'Escape') onClose();
            };
            const onDown = (event) => {
              const target = event.target;
              if (rootRef.current && rootRef.current.contains(target)) return;
              if (info.ref && info.ref.contains && info.ref.contains(target)) return;
              onClose();
            };
            document.addEventListener('keydown', onKey);
            document.addEventListener('mousedown', onDown, true);
            return () => {
              document.removeEventListener('keydown', onKey);
              document.removeEventListener('mousedown', onDown, true);
            };
          }, [onClose, info.ref]);

          const width = 320;
          const margin = 8;
          const left = Math.min(Math.max(margin, info.rect.left), window.innerWidth - width - margin);
          const below = info.rect.bottom + 8;
          const top = below + 220 > window.innerHeight ? Math.max(margin, info.rect.top - 228) : below;

          return h(
            'div',
            { className: 'aih-pop', ref: rootRef, style: { left, top, width } },
            h(
              'div',
              { className: 'aih-pop-head' },
              h('span', { className: 'aih-pop-word' }, info.word),
              info.data?.ipa && h('span', { className: 'aih-pop-ipa' }, info.data.ipa),
            ),
            info.error
              ? h('div', { className: 'aih-error' }, info.error)
              : info.data
                ? h(
                    'div',
                    null,
                    h('div', { className: 'aih-muted', style: { fontSize: 12 } }, translate('meaning')),
                    h('div', { className: 'aih-pop-meaning' }, info.data.meaning),
                    h(
                      'div',
                      { className: 'aih-pop-foot' },
                      info.data.pos && h('span', { className: 'aih-muted', style: { fontSize: 12 } }, info.data.pos),
                      h('button', { className: 'aih-iconbtn', onClick: () => speak(info.word) }, '🔊 ' + translate('speak')),
                      h(
                        'button',
                        {
                          className: 'aih-iconbtn',
                          'data-done': info.saved ? 'true' : 'false',
                          onClick: () => onSaved(),
                        },
                        info.saved ? '✓ ' + translate('saved') : '＋ ' + translate('saveWord'),
                      ),
                    ),
                  )
                : h('div', { className: 'aih-status', style: { margin: 0 } }, h('span', { className: 'aih-spin' }), translate('translating')),
          );
        }

        /* -------------------------------------------------------------- */
        /* Detail view                                                     */
        /* -------------------------------------------------------------- */

        function emptyDoc() {
          return { source: '', titleEn: '', titleZh: '', paras: [], status: 'loading', notes: [], translatedCount: 0, total: 0 };
        }

        function DocView({ item, onBack }) {
          const cached = useRef(loadDoc(item.id));
          const [runId, setRunId] = useState(0);
          const [doc, setDoc] = useState(() => {
            if (cached.current) {
              const d = cached.current.doc;
              return { ...emptyDoc(), ...d, status: 'ready' };
            }
            return emptyDoc();
          });
          const [error, setError] = useState('');
          const [popover, setPopover] = useState(null);
          const [fromCache] = useState(() => cached.current !== null);

          useEffect(() => {
            if (cached.current) return;
            const controller = new AbortController();
            const base = emptyDoc();
            (async () => {
              try {
                await streamDoc(
                  {
                    id: item.id,
                    title: item.title,
                    originalTitle: item.originalTitle,
                    summary: item.summary,
                    reason: item.reason,
                    originalUrl: item.originalUrl,
                  },
                  (event) => {
                    setDoc((prev) => applyEvent(prev, event));
                  },
                  controller.signal,
                );
              } catch (streamError) {
                if (!controller.signal.aborted) setError(String(streamError?.message ?? streamError));
              }
            })();
            return () => controller.abort();
          }, [item.id, runId]);

          function applyEvent(prev, event) {
            const next = { ...prev, paras: prev.paras.slice() };
            switch (event.event) {
              case 'meta': {
                next.source = event.source;
                next.titleEn = event.titleEn ?? '';
                next.titleZh = event.titleZh ?? '';
                next.paras = (event.paragraphs ?? []).map((para) => ({ type: para.type ?? 'p', en: para.en ?? '', zh: para.zh ?? '' }));
                next.total = next.paras.length;
                break;
              }
              case 'title': {
                if (next.source === 'en' && next.titleZh === '') next.titleZh = event.text;
                if (next.source === 'zh' && next.titleEn === '') next.titleEn = event.text;
                break;
              }
              case 'p': {
                const index = event.i;
                if (index >= 0 && index < next.paras.length) {
                  const para = { ...next.paras[index] };
                  if (next.source === 'en') para.zh = event.text;
                  else para.en = event.text;
                  next.paras[index] = para;
                  next.translatedCount = Math.max(next.translatedCount, index + 1);
                }
                break;
              }
              case 'warn': {
                next.notes = [...next.notes, event.message];
                break;
              }
              case 'error': {
                next.status = 'failed';
                next.notes = [...next.notes, event.message];
                break;
              }
              case 'done': {
                next.status = 'ready';
                setTimeout(() => {
                  cacheDoc(item.id, {
                    source: next.source,
                    titleEn: next.titleEn,
                    titleZh: next.titleZh,
                    paras: next.paras,
                    status: 'ready',
                    notes: [],
                    translatedCount: next.translatedCount,
                    total: next.total,
                  });
                });
                break;
              }
              default:
                break;
            }
            return next;
          }

          const onWordClick = useCallback(
            (event, para) => {
              if (!para.en) return;
              const found = wordAtPoint(event.currentTarget, event.clientX, event.clientY);
              if (!found) return;
              const sentence = sentenceAround(para.en, found.start);
              const rect = found.rect ?? event.currentTarget.getBoundingClientRect();
              const info = { word: found.word, rect, sentence, data: null, error: '', saved: false, ref: event.currentTarget };
              setPopover(info);
              ensureWord(found.word, sentence, para.en, undefined)
                .then((data) => {
                  setPopover((prev) => (prev && prev.word === found.word ? { ...prev, data } : prev));
                })
                .catch((fetchError) => {
                  setPopover((prev) => (prev && prev.word === found.word ? { ...prev, error: String(fetchError?.message ?? fetchError) } : prev));
                });
            },
            [],
          );

          const saveWord = () => {
            if (!popover || !popover.data) return;
            const ok = addVocab({
              word: popover.word,
              meaning: popover.data.meaning,
              pos: popover.data.pos,
              ipa: popover.data.ipa,
              sentence: popover.sentence,
              article: doc.titleEn || doc.titleZh || item.title,
            });
            setPopover({ ...popover, saved: true });
            void ok;
          };

          const pending = doc.status === 'loading';
          const showPending = (para) => pending || para === '';

          return h(
            'div',
            { className: 'aih-root' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'aih-header' },
              h('button', { className: 'aih-back', onClick: onBack }, '← ' + translate('back')),
              h('span', { className: 'aih-doc-title' }, item.title),
              fromCache && !pending && h('span', { className: 'aih-muted', style: { fontSize: 12 } }, '· ' + translate('cached')),
              h(
                'div',
                { className: 'aih-tabs' },
                h('button', { className: 'aih-tab', onClick: () => { lsRemove(LS_DOC_PREFIX + item.id); cached.current = null; setError(''); setDoc(emptyDoc()); setRunId((n) => n + 1); } }, translate('retranslate')),
              ),
            ),
            h(
              'div',
              { className: 'aih-content' },
              h('h1', { className: 'aih-title-en' }, doc.titleEn || (pending ? '…' : '')),
              h('div', { className: 'aih-title-zh' }, doc.titleZh || ''),
              h(
                'div',
                { className: 'aih-meta' },
                item.sourceName && h('span', null, item.sourceName),
                item.category && h('span', null, CATEGORY_ZH[item.category] ?? item.category),
                item.publishedAt && h('span', null, fmtTime(item.publishedAt)),
                item.aihotUrl && h('a', { href: item.aihotUrl, target: '_blank', rel: 'noreferrer' }, translate('aiHotPage')),
                item.originalUrl && h('a', { href: item.originalUrl, target: '_blank', rel: 'noreferrer' }, translate('original')),
              ),
              doc.paras.map((para, index) =>
                h(
                  'div',
                  { key: index },
                  h(
                    'p',
                    {
                      className: 'aih-p-en aih-' + para.type,
                      onClick: (event) => onWordClick(event, para),
                    },
                    para.en === '' ? (showPending(para.en) ? '　' : '') : para.en,
                  ),
                  h('p', { className: 'aih-p-zh aih-' + para.type + (para.zh === '' && pending ? ' aih-pending' : '') }, para.zh === '' ? (pending ? '……' : '') : para.zh),
                ),
              ),
              pending &&
                h(
                  'div',
                  { className: 'aih-status' },
                  h('span', { className: 'aih-spin' }),
                  `${translate('translating')} ${doc.translatedCount}/${doc.total || '…'}`,
                ),
              doc.status === 'failed' && h('div', { className: 'aih-status' }, h('span', { className: 'aih-warn' }, doc.notes.join('；') || error || '翻译失败')),
              error && doc.status !== 'failed' && h('div', { className: 'aih-status' }, h('span', { className: 'aih-error' }, error)),
            ),
            popover && h(WordPopover, { info: popover, onClose: () => setPopover(null), onSaved: saveWord }),
            h(
              'div',
              { className: 'aih-footer' },
              translate('dataSource'),
              h('a', { href: 'https://aihot.news', target: '_blank', rel: 'noreferrer' }, 'AIHOT · aihot.news'),
            ),
          );
        }

        /* -------------------------------------------------------------- */
        /* Panel                                                           */
        /* -------------------------------------------------------------- */

        function Panel() {
          const [tab, setTab] = useState('news');
          const [items, setItems] = useState(null);
          const [loading, setLoading] = useState(false);
          const [error, setError] = useState('');
          const [docItem, setDocItem] = useState(null);
          const [vocabVersion, setVocabVersion] = useState(0);

          const loadItems = useCallback(
            (force) => {
              const cachedItems = lsGet(LS_ITEMS, null);
              if (cachedItems?.items?.length) setItems(cachedItems.items);
              if (cachedItems?.items?.length && !force && Date.now() - cachedItems.fetchedAt < ITEMS_TTL_MS) return;
              setLoading(true);
              fetchItems()
                .then((data) => {
                  setItems(data.items);
                  setError('');
                  lsSet(LS_ITEMS, { fetchedAt: data.fetchedAt, items: data.items });
                })
                .catch((fetchError) => {
                  if (!cachedItems?.items?.length) setError(String(fetchError?.message ?? fetchError));
                })
                .finally(() => setLoading(false));
            },
            [],
          );

          useEffect(() => {
            loadItems(false);
          }, [loadItems]);

          const vocabEntries = lsGet(LS_VOCAB, []);

          if (docItem) {
            return h(DocView, { item: docItem, onBack: () => setDocItem(null) });
          }
          return h(
            'div',
            { className: 'aih-root' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'aih-header' },
              h('div', { className: 'aih-brand' }, h('span', { style: { fontSize: 18 } }, '🌐'), translate('panelLabel')),
              h(
                'div',
                { className: 'aih-tabs' },
                h('button', { className: 'aih-tab', 'data-active': tab === 'news' ? 'true' : 'false', onClick: () => { setTab('news'); loadItems(false); } }, translate('tabNews')),
                h('button', { className: 'aih-tab', 'data-active': tab === 'vocab' ? 'true' : 'false', onClick: () => setTab('vocab') }, translate('tabVocab') + (vocabEntries.length > 0 ? ' (' + vocabEntries.length + ')' : '')),
                h('button', { className: 'aih-tab', onClick: () => loadItems(true) }, '↻ ' + translate('refresh')),
              ),
            ),
            h(
              'div',
              { className: 'aih-content' },
              tab === 'news'
                ? h(ListTab, {
                    items,
                    loading,
                    error,
                    onOpen: (item) => setDocItem(item),
                    onRefresh: () => loadItems(true),
                  })
                : h(VocabTab, { entries: vocabEntries, onChange: () => setVocabVersion((n) => n + 1) }),
            ),
            h(
              'div',
              { className: 'aih-footer' },
              translate('dataSource'),
              h('a', { href: 'https://aihot.news', target: '_blank', rel: 'noreferrer' }, 'AIHOT · aihot.news'),
            ),
          );
        }

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 55, label: translate('panelLabel') }, RailIcon),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel));
      },
    };
  },
});
