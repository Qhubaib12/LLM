(() => {
  'use strict';
  const STORAGE_PREFIX = 'pes:v1:';
  const SETTINGS_KEY = 'pes:settings';
  const MAX_TEXT = 12000;
  const MAX_HTML = 100000;
  const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TITLE']);
  const pathCache = new WeakMap();
  let restoring = false;

  const key = () => STORAGE_PREFIX + location.href;
  const idle = (fn, timeout = 1200) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 80));
  const cssEscape = (v) => (window.CSS?.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
  const cloneAttrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
  const significant = (n) => n && !IGNORED_TAGS.has(n.nodeName) && !(n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim());

  function nodePath(node) {
    if (pathCache.has(node)) return pathCache.get(node);
    const parts = [];
    let cur = node;
    while (cur && cur !== document) {
      if (cur.nodeType === Node.DOCUMENT_TYPE_NODE) break;
      if (cur.nodeType === Node.TEXT_NODE) {
        const siblings = [...cur.parentNode.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE);
        parts.unshift(`text:${siblings.indexOf(cur)}`);
        cur = cur.parentNode;
        continue;
      }
      if (cur.nodeType === Node.ELEMENT_NODE) {
        if (cur.id && document.querySelectorAll(`#${cssEscape(cur.id)}`).length === 1) { parts.unshift(`#${cur.id}`); break; }
        const siblings = [...cur.parentNode.children].filter((n) => n.tagName === cur.tagName);
        parts.unshift(`${cur.tagName.toLowerCase()}:nth:${siblings.indexOf(cur)}`);
      }
      cur = cur.parentNode;
    }
    const path = parts.join('>');
    pathCache.set(node, path);
    return path;
  }

  function findPath(path) {
    if (!path) return null;
    let cur = document;
    for (const part of path.split('>')) {
      if (!part) continue;
      if (part[0] === '#') { cur = document.getElementById(part.slice(1)); continue; }
      if (part.startsWith('text:')) cur = [...cur.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)[Number(part.slice(5))];
      else {
        const [tag, , idx] = part.split(':');
        cur = [...cur.children].filter((n) => n.tagName.toLowerCase() === tag)[Number(idx)];
      }
      if (!cur) return null;
    }
    return cur === document ? document.documentElement : cur;
  }

  function fingerprint(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return `text:${node.nodeValue.trim().slice(0, 80)}`;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    return [node.tagName, node.id, node.className, node.getAttribute('data-testid'), node.getAttribute('name')].filter(Boolean).join('|').slice(0, 200);
  }

  function elementRecord(el) {
    return { tag: el.tagName.toLowerCase(), attrs: cloneAttrs(el), html: el.innerHTML.slice(0, MAX_HTML), text: el.textContent.slice(0, MAX_TEXT) };
  }

  function captureBaseline() {
    const map = new Map();
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => significant(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    let n;
    while ((n = walker.nextNode())) {
      const path = nodePath(n);
      map.set(path, n.nodeType === Node.TEXT_NODE ? { type: 'text', value: n.nodeValue, fp: fingerprint(n) } : { type: 'element', attrs: cloneAttrs(n), style: n.getAttribute('style') || '', fp: fingerprint(n) });
    }
    return map;
  }

  let baseline;
  function ensureBaseline() { if (!baseline) baseline = captureBaseline(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => idle(ensureBaseline)); else idle(ensureBaseline);

  function diff() {
    ensureBaseline();
    const current = captureBaseline();
    const operations = [];
    for (const [path, before] of baseline) {
      const now = current.get(path);
      if (!now) { operations.push({ op: 'remove', path, fp: before.fp }); continue; }
      if (before.type === 'text' && now.value !== before.value) operations.push({ op: 'text', path, value: now.value.slice(0, MAX_TEXT), fp: now.fp });
      if (before.type === 'element') {
        const attrPatch = {};
        const names = new Set([...Object.keys(before.attrs), ...Object.keys(now.attrs)]);
        for (const name of names) if (before.attrs[name] !== now.attrs[name]) attrPatch[name] = now.attrs[name] ?? null;
        if (Object.keys(attrPatch).length) operations.push({ op: 'attrs', path, attrs: attrPatch, fp: now.fp });
      }
    }
    for (const [path, now] of current) {
      if (baseline.has(path) || now.type !== 'element') continue;
      const el = findPath(path);
      if (!el || IGNORED_TAGS.has(el.tagName)) continue;
      const parentPath = nodePath(el.parentElement);
      const index = [...el.parentElement.children].indexOf(el);
      operations.push({ op: 'add', path, parentPath, index, element: elementRecord(el), fp: now.fp });
    }
    return { url: location.href, title: document.title, savedAt: new Date().toISOString(), operations: compact(operations) };
  }

  function compact(ops) {
    const byKey = new Map();
    for (const op of ops) byKey.set(`${op.op}:${op.path}`, op);
    return [...byKey.values()].slice(0, 3000);
  }

  function apply(snapshot) {
    if (!snapshot?.operations) return 0;
    restoring = true;
    let applied = 0;
    try {
      for (const op of snapshot.operations) {
        if (op.op === 'add') {
          if (findPath(op.path)) continue;
          const parent = findPath(op.parentPath);
          if (!parent) continue;
          const el = document.createElement(op.element.tag);
          for (const [k, v] of Object.entries(op.element.attrs || {})) el.setAttribute(k, v);
          el.innerHTML = op.element.html || '';
          parent.insertBefore(el, parent.children[op.index] || null); applied++; continue;
        }
        const target = findPath(op.path);
        if (!target) continue;
        if (op.op === 'remove') { target.remove(); applied++; }
        else if (op.op === 'text' && target.nodeType === Node.TEXT_NODE) { target.nodeValue = op.value; applied++; }
        else if (op.op === 'attrs' && target.nodeType === Node.ELEMENT_NODE) {
          for (const [k, v] of Object.entries(op.attrs || {})) v === null ? target.removeAttribute(k) : target.setAttribute(k, v);
          applied++;
        }
      }
    } finally { restoring = false; }
    return applied;
  }

  async function autoRestore() {
    try {
      const data = await chrome.storage.local.get([key(), SETTINGS_KEY]);
      const settings = data[SETTINGS_KEY] || {};
      if (settings.disabledUrls?.[location.href]) return;
      const snapshot = data[key()];
      if (!snapshot) return;
      const run = () => apply(snapshot);
      run();
      const observer = new MutationObserver(() => { if (!restoring) idle(run, 500); });
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      setTimeout(() => observer.disconnect(), 15000);
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        if (message.type === 'PES_CAPTURE') { const snapshot = diff(); sendResponse({ ok: true, snapshot }); return; }
        if (message.type === 'PES_RESTORE') { sendResponse({ ok: true, applied: apply(message.snapshot) }); return; }
        sendResponse({ ok: false, error: 'Unknown content message.' });
      } catch (error) { sendResponse({ ok: false, error: error.message }); }
    })();
    return true;
  });

  if (document.documentElement) autoRestore(); else document.addEventListener('DOMContentLoaded', autoRestore, { once: true });
})();
