// Конвертер старых .doc (Word 97–2003) в HTML на клиенте — ГИБРИДНЫЙ ПОДХОД:
//
//  1) Лёгкий путь (мгновенный): собственный парсер OLE2 (docParser.js) извлекает чистый текст
//     без скачивания тяжёлых зависимостей. Показывается сразу с кнопкой «Полное форматирование».
//  2) Тяжёлый путь (ленивый WASM): LibreOffice, собранный в WebAssembly (@bentopdf/libreoffice-wasm),
//     конвертирует .doc → HTML с сохранением форматирования. ~50 МБ ассетов скачиваются ТОЛЬКО
//     когда пользователь сам нажал кнопку — при старте приложения ничего не грузится.
//  3) RTF-файлы с расширением .doc распознаются по сигнатуре и читаются напрямую.
//  4) Результат кэшируется в IndexedDB, повторное открытие того же файла — мгновенное.

import { loadFileBuffer } from './materials';
import { parseOle2, extractDocText, looksLikeRtf, rtfToPlainText } from './docParser';

/* ------------------------------------------------------------------ */
/* Кэш результатов в IndexedDB (localStorage не подходит — квота ~5 МБ) */
/* ------------------------------------------------------------------ */

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
      setTimeout(() => resolve(null), 3000); // страховка от зависания
    });
  } catch {
    return null; // нет IndexedDB — работаем без кэша
  }
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
  } catch {
    /* кэш не критичен */
  }
}

/** Ключ кэша: путь + размер + режим (light/full) — при изменении файла кэш сам обновится. */
function cacheKey(node, mode) {
  return `${mode}|${node.path}|${node.size ?? 0}`;
}

/* ------------------------------------------------------------------ */
/* Лёгкий путь: мгновенное извлечение текста                          */
/* ------------------------------------------------------------------ */

/** Экранирование для безопасной вставки текста в innerHTML */
export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Текст -> простой HTML (абзацы). */
function textToHtml(text) {
  return text.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`).join('\n');
}

/**
 * Быстрый разбор .doc без WASM.
 * @returns {Promise<{ok:boolean, html?:string, text?:string, reason?:string}>}
 */
export async function convertDocLight(fileNode) {
  // Сначала заглянем в кэш — вдруг уже читали этот файл
  const cached = await cacheGet(cacheKey(fileNode, 'light'));
  if (cached && cached.html) return { ok: true, ...cached };

  const buffer = await loadFileBuffer(fileNode);

  // Вариант «на самом деле это RTF»
  if (looksLikeRtf(buffer)) {
    const raw = new TextDecoder('windows-1251').decode(buffer);
    const text = rtfToPlainText(raw);
    if (text.length > 20) {
      const res = { ok: true, html: textToHtml(text), text };
      cacheSet(cacheKey(fileNode, 'light'), res);
      return res;
    }
    return { ok: false, reason: 'rtf-empty' };
  }

  // Настоящий бинарный Word 97–2003 (OLE2)
  const streams = parseOle2(buffer);
  if (!streams) return { ok: false, reason: 'not-ole2' };
  const text = extractDocText(streams);
  if (!text || text.length < 20) return { ok: false, reason: 'no-text' };

  const html = textToHtml(text);
  const res = { ok: true, html, text };
  cacheSet(cacheKey(fileNode, 'light'), res); // кладём в фон, не ждём
  return res;
}

/* ------------------------------------------------------------------ */
/* Тяжёлый путь: LibreOffice WASM (ленивая загрузка по клику)          */
/* ------------------------------------------------------------------ */

// URL ассетов через ?url — Vite отдаёт их как статические файлы (в dist/assets/*) и НЕ инлайнит
// в JS (файлы больше порога inline). Импорт сделан ленивой функцией: запросы к /assets/*
// начинаются ТОЛЬКО когда пользователь нажал «Полное форматирование».
async function assetUrls() {
  const [workerMod, sofficeJs, sofficeWasm, sofficeData, sofficeWorkerJs] = await Promise.all([
    import('@bentopdf/libreoffice-wasm/assets/browser.worker.global.js?url'),
    import('@bentopdf/libreoffice-wasm/assets/soffice.js?url'),
    import('@bentopdf/libreoffice-wasm/assets/soffice.wasm.gz?url'),
    import('@bentopdf/libreoffice-wasm/assets/soffice.data.gz?url'),
    import('@bentopdf/libreoffice-wasm/assets/soffice.worker.js?url'),
  ]);
  return {
    worker: workerMod.default,
    sofficeJs: sofficeJs.default,
    sofficeWasm: sofficeWasm.default,
    sofficeData: sofficeData.default,
    sofficeWorkerJs: sofficeWorkerJs.default,
  };
}

let workerPromise = null; // один воркер на сессию: WASM инициализируется один раз

/** Создать (или переиспользовать) готовый к работе LibreOffice-воркер. */
function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const urls = await assetUrls();
      const worker = new Worker(urls.worker, { type: 'classic' });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Таймаут инициализации LibreOffice WASM')), 300000);
        const onMsg = (e) => {
          const t = e.data && e.data.type;
          if (t === 'loaded') {
            // воркер-скрипт загружен — можно слать init со ссылками на WASM-ассеты
            worker.postMessage({
              type: 'init',
              id: 'init-1',
              sofficeJs: urls.sofficeJs,
              sofficeWasm: urls.sofficeWasm,
              sofficeData: urls.sofficeData,
              sofficeWorkerJs: urls.sofficeWorkerJs,
              enableProgressTracking: true, // прогресс скачивания ~50 МБ ассетов
            });
          } else if (t === 'ready') {
            clearTimeout(timer);
            worker.removeEventListener('message', onMsg);
            resolve();
          } else if (t === 'progress' && e.data.id === 'init-1') {
            // phase-level прогресс инициализации (download-wasm / download-data / compile ...)
            onProgress(e.data.progress.percent, e.data.progress.message || 'Инициализация LibreOffice…');
          } else if (t === 'error') {
            clearTimeout(timer);
            worker.removeEventListener('message', onMsg);
            reject(new Error(e.data.error || 'Ошибка инициализации WASM'));
          }
        };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', (err) => {
          clearTimeout(timer);
          reject(new Error(err.message || 'Ошибка загрузки воркера'));
        });
      });
      return worker;
    })().catch((err) => {
      workerPromise = null; // дадим шанс пересоздать воркер при следующей попытке
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Конвертировать .doc → HTML через LibreOffice WASM.
 * @param {Object} fileNode   узел дерева материалов
 * @param {Function} onProgress (percent 0..100, message) => void
 */
export async function convertDocFull(fileNode, onProgress = () => {}) {
  const cached = await cacheGet(cacheKey(fileNode, 'full'));
  if (cached && cached.html) {
    onProgress(100, 'Из кэша');
    return cached.html;
  }

  // Данные документа и воркер грузим параллельно
  const [buffer, worker] = await Promise.all([loadFileBuffer(fileNode), getWorker(onProgress)]);

  const html = await new Promise((resolve, reject) => {
    const id = 'conv-' + Date.now();
    const timer = setTimeout(() => {
      worker.removeEventListener('message', onMsg);
      reject(new Error('Таймаут конвертации .doc'));
    }, 120000);
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.id !== id && d.type !== 'error') return;
      if (d.type === 'progress') {
        onProgress(d.progress.percent, d.progress.message);
      } else if (d.type === 'result') {
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        const bytes = d.data instanceof Uint8Array ? d.data : new Uint8Array(d.data);
        resolve(new TextDecoder('utf-8').decode(bytes));
      } else if (d.type === 'error') {
        clearTimeout(timer);
        worker.removeEventListener('message', onMsg);
        reject(new Error(d.error || 'LibreOffice не смог открыть документ'));
      }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({
      type: 'convert',
      id,
      inputData: new Uint8Array(buffer),
      inputExt: 'doc',
      outputFormat: 'html',
    });
  });

  cacheSet(cacheKey(fileNode, 'full'), { html }); // фоновое кэширование
  return html;
}
