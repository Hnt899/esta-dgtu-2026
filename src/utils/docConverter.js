// Конвертер старых .doc (Word 97–2003) в HTML на клиенте.
// Определяем реальный формат по сигнатуре (magic bytes), а не по расширению.
//   - "PK" (0x50 0x4B)   -> на самом деле .docx (ZIP) -> mammoth
//   - "D0 CF 11 E0"      -> настоящий бинарный .doc (OLE2) -> docParser
//   - "{\rtf"            -> RTF -> rtfToPlainText
//   - "<html"/"<!doctype"-> HTML с расширением .doc

import { loadFileBuffer } from './materials';
import { parseOle2, extractDocText, looksLikeRtf, rtfToPlainText } from './docParser';
import mammoth from 'mammoth';

const DB_NAME = 'esta-dgtu-doc-cache';
const STORE = 'html';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).get(key);
      rq.onsuccess = () => resolve(rq.result || null);
      rq.onerror = () => reject(rq.error);
      setTimeout(() => resolve(null), 3000);
    });
  } catch { return null; }
}

async function cacheSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      setTimeout(resolve, 3000);
    });
  } catch { /* кэш не критичен */ }
}

function cacheKey(node) {
  return `light|${node.path}|${node.size ?? 0}`;
}

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function textToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n');
}

function detectFormat(u8) {
  if (u8[0] === 0x50 && u8[1] === 0x4b) return 'zip-docx';
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return 'ole2';
  if (u8[0] === 0x7b && u8[1] === 0x5c && u8[2] === 0x72 && u8[3] === 0x74) return 'rtf';
  const head = new TextDecoder('utf-8').decode(u8.slice(0, 1024)).toLowerCase();
  if (head.includes('<html') || head.includes('<!doctype') || head.includes('<body')) return 'html';
  return 'unknown';
}

export async function convertDocLight(fileNode) {
  const cached = await cacheGet(cacheKey(fileNode));
  if (cached && cached.html) return { ok: true, ...cached };

  const buffer = await loadFileBuffer(fileNode);
  const u8 = new Uint8Array(buffer);
  const format = detectFormat(u8);

  if (format === 'zip-docx') {
    try {
      const result = await mammoth.convertToHtml(
        { arrayBuffer: buffer },
        {
          convertImage: mammoth.images.imgElement(async (image) => {
            const buf = await image.read();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { src: `data:${image.contentType};base64,${btoa(binary)}` };
          }),
        }
      );
      const html = result.value;
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const res = { ok: true, html, text };
      cacheSet(cacheKey(fileNode), res);
      return res;
    } catch {
      return { ok: false, reason: 'mammoth-failed' };
    }
  }

  if (format === 'ole2') {
    const streams = parseOle2(buffer);
    if (streams) {
      const text = extractDocText(streams);
      if (text && text.length > 20) {
        const html = textToHtml(text);
        const res = { ok: true, html, text };
        cacheSet(cacheKey(fileNode), res);
        return res;
      }
    }
    return { ok: false, reason: 'ole2-no-text' };
  }

  if (format === 'rtf' || looksLikeRtf(buffer)) {
    const raw = new TextDecoder('windows-1251').decode(buffer);
    const text = rtfToPlainText(raw);
    if (text.length > 20) {
      const res = { ok: true, html: textToHtml(text), text };
      cacheSet(cacheKey(fileNode), res);
      return res;
    }
    return { ok: false, reason: 'rtf-empty' };
  }

  if (format === 'html') {
    const html = new TextDecoder('utf-8').decode(buffer);
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const res = { ok: true, html, text };
    cacheSet(cacheKey(fileNode), res);
    return res;
  }

  return { ok: false, reason: 'unknown-format' };
}