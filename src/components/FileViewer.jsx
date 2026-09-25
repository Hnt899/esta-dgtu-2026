// Просмотр файлов в браузере: PDF (pdf.js), DOCX (mammoth), PPTX (текст слайдов через Web Worker),
// XLSX (SheetJS), изображения (лайтбокс), текст, аудио/видео. Прочее — кнопка «Скачать».
import React, { useEffect, useRef, useState } from 'react';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { loadFileBuffer } from '../utils/materials';
import { getFileKind, getMime, VIEWERS } from '../utils/fileTypes';
import DownloadButton from './DownloadButton.jsx';
import PptxWorker from '../workers/pptxWorker.js?worker&inline';

/** Хук: загрузить файл и вернуть object-URL (с освобождением памяти). */
function useObjectUrl(node) {
  const [state, setState] = useState({ url: '', loading: true, error: '' });
  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setState({ url: '', loading: true, error: '' });
    (async () => {
      try {
        const buffer = await loadFileBuffer(node);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: getMime(node.name) }));
        setState({ url: objectUrl, loading: false, error: '' });
      } catch (e) {
        if (!cancelled) setState({ url: '', loading: false, error: String(e.message || e) });
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [node]);
  return state;
}

/* ---------------- PDF через pdf.js (canvas-рендер всех страниц) ---------------- */
function PdfView({ node }) {
  const containerRef = useRef(null);
  const [pagesDone, setPagesDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // pdf.js v4 — ES-модуль; worker инлайнится Vite (?worker&inline) — один HTML/JS-бандл
        const pdfjs = await import('pdfjs-dist');
        const PdfWorkerCtor = (await import('pdfjs-dist/build/pdf.worker.min.mjs?worker&inline')).default;
        pdfjs.GlobalWorkerOptions.workerPort = new PdfWorkerCtor();

        const buffer = await loadFileBuffer(node);
        if (cancelled) return;
        const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
        if (cancelled) return;
        setTotal(doc.numPages);

        const container = containerRef.current;
        container.innerHTML = '';

        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          const wrap = document.createElement('div');
          wrap.className = 'pdf-page';
          const canvas = document.createElement('canvas');
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const cssWidth = Math.max(280, Math.min(container.clientWidth - 32, 900));
          const scale = (cssWidth / viewport.width) * dpr;
          const scaled = page.getViewport({ scale });
          canvas.width = Math.floor(scaled.width);
          canvas.height = Math.floor(scaled.height);
          canvas.style.width = Math.floor(scaled.width / dpr) + 'px';
          container.appendChild(wrap); // резerving место — ширина уже доступна
          wrap.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaled }).promise;
          const label = document.createElement('div');
          label.className = 'pdf-page-label';
          label.textContent = `Страница ${i} из ${doc.numPages}`;
          wrap.appendChild(label);
          setPagesDone(i);
        }
      } catch (e) {
        if (!cancelled) setError('Не удалось отобразить PDF: ' + (e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [node]);

  return (
    <div className="viewer">
      {error && <ErrorBox text={error} node={node} />}
      {!error && pagesDone < total && (
        <div className="loading">Рендер страниц: {pagesDone} из {total}…</div>
      )}
      {!error && !total && <div className="loading">Загрузка PDF…</div>}
      <div ref={containerRef} className="pdf-container" />
    </div>
  );
}

/* ---------------- DOCX через mammoth.js (режим чтения) ---------------- */
function DocxView({ node }) {
  const [html, setHtml] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(''); setHtml('');
    (async () => {
      try {
        const buffer = await loadFileBuffer(node);
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          { convertImage: mammoth.images.imgElement(async (image) => {
              // картинки из docx — в data-url
              const buf = await image.read();
              const bytes = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              return { src: `data:${image.contentType};base64,${btoa(binary)}` };
            }) }
        );
        if (!cancelled) setHtml(result.value);
      } catch (e) {
        if (!cancelled) setError('Не удалось открыть DOCX: ' + (e.message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [node]);

  if (error) return <div className="viewer"><ErrorBox text={error} node={node} /></div>;
  if (loading) return <div className="viewer"><div className="loading">Чтение документа…</div></div>;
  return (
    <div className="viewer docx-doc" dangerouslySetInnerHTML={{ __html: html || '<p><em>Документ пуст.</em></p>' }} />
  );
}

/* ---------------- PPTX: извлечение текста слайдов через Web Worker ---------------- */
function PptxView({ node }) {
  const [slides, setSlides] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSlides(null); setError('');
    (async () => {
      try {
        const buffer = await loadFileBuffer(node);
        const worker = new PptxWorker();
        worker.onmessage = (e) => {
          if (cancelled) return;
          if (e.data.ok) setSlides(e.data.slides);
          else setError('Не удалось разобрать PPTX: ' + e.data.error);
          worker.terminate();
        };
        worker.onerror = () => { if (!cancelled) setError('Ошибка воркера PPTX'); worker.terminate(); };
        worker.postMessage(buffer, [buffer]);
      } catch (e) {
        if (!cancelled) setError(String(e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [node]);

  if (error) return <div className="viewer"><ErrorBox text={error + ' Попробуйте скачать файл.'} node={node} /></div>;
  if (!slides) return <div className="viewer"><div className="loading">Чтение презентации…</div></div>;
  return (
    <div className="viewer pptx-doc">
      <p className="pptx-note">Режим чтения: показан текст слайдов (без оформления и картинок).</p>
      {slides.map((paras, i) => (
        <section key={i} className="pptx-slide">
          <h4>Слайд {i + 1}</h4>
          {paras.length ? paras.map((t, j) => <p key={j}>{t}</p>) : <p><em>(слайд без текста)</em></p>}
        </section>
      ))}
    </div>
  );
}

/* ---------------- XLSX через SheetJS ---------------- */
function XlsxView({ node }) {
  const [sheets, setSheets] = useState(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setSheets(null); setError(''); setActive(0);
    (async () => {
      try {
        const buffer = await loadFileBuffer(node);
        const wb = XLSX.read(buffer, { type: 'array' });
        const data = wb.SheetNames.map((name) => ({
          name,
          html: XLSX.utils.sheet_to_html(wb.Sheets[name], { header: '', footer: '' }),
        }));
        if (!cancelled) setSheets(data);
      } catch (e) {
        if (!cancelled) setError('Не удалось открыть таблицу: ' + (e.message || e));
      }
    })();
    return () => { cancelled = true; };
  }, [node]);

  if (error) return <div className="viewer"><ErrorBox text={error} node={node} /></div>;
  if (!sheets) return <div className="viewer"><div className="loading">Чтение таблицы…</div></div>;
  return (
    <div className="viewer xlsx-doc">
      <div className="xlsx-tabs">
        {sheets.map((s, i) => (
          <button key={i} className={`xlsx-tab${i === active ? ' active' : ''}`} onClick={() => setActive(i)}>
            {s.name}
          </button>
        ))}
      </div>
      <div className="xlsx-table" dangerouslySetInnerHTML={{ __html: sheets[active].html }} />
    </div>
  );
}

/* ---------------- Изображение + лайтбокс ---------------- */
function ImageView({ node }) {
  const { url, loading, error } = useObjectUrl(node);
  const [zoom, setZoom] = useState(false);
  useEffect(() => setZoom(false), [node]);

  if (error) return <div className="viewer"><ErrorBox text={error} node={node} /></div>;
  if (loading) return <div className="viewer"><div className="loading">Загрузка изображения…</div></div>;
  return (
    <div className="viewer img-view">
      <img src={url} alt={node.name} className="img-main" onClick={() => setZoom(true)} title="Клик — увеличить" />
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(false)} role="dialog" aria-label="Просмотр изображения">
          <img src={url} alt={node.name} />
          <span className="lightbox-close">✕ Закрыть</span>
        </div>
      )}
    </div>
  );
}

/* ---------------- Текстовые файлы ---------------- */
function TextView({ node }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setText(''); setError(''); setLoading(true);
    (async () => {
      try {
        const buffer = await loadFileBuffer(node);
        let decoded = new TextDecoder('utf-8').decode(buffer);
        // Если вместо кириллицы «кракозябры» — пробуем windows-1251
        if (/\uFFFD/.test(decoded.slice(0, 2000))) {
          try { decoded = new TextDecoder('windows-1251').decode(buffer); } catch { /* оставляем как есть */ }
        }
        if (!cancelled) setText(decoded);
      } catch (e) { if (!cancelled) setError(String(e.message || e)); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [node]);
  if (error) return <div className="viewer"><ErrorBox text={error} node={node} /></div>;
  if (loading) return <div className="viewer"><div className="loading">Загрузка…</div></div>;
  return <pre className="viewer text-doc">{text}</pre>;
}

/* ---------------- Аудио / Видео ---------------- */
function MediaView({ node, kind }) {
  const { url, loading, error } = useObjectUrl(node);
  if (error) return <div className="viewer"><ErrorBox text={error} node={node} /></div>;
  if (loading) return <div className="viewer"><div className="loading">Загрузка…</div></div>;
  return (
    <div className="viewer media-view">
      {kind === VIEWERS.AUDIO
        ? <audio src={url} controls />
        : <video src={url} controls className="media-video" />}
    </div>
  );
}

/* ---------------- Ошибки / неподдерживаемые форматы ---------------- */
function ErrorBox({ text, node }) {
  return (
    <div className="unsupported">
      <p>⚠️ {text || 'Файл не найден или повреждён.'}</p>
      <DownloadButton node={node} label="Скачать" className="btn btn-primary" />
    </div>
  );
}

function UnsupportedView({ node }) {
  return (
    <div className="viewer unsupported">
      <p>
        Формат <b>{node.name.split('.').pop().toUpperCase()}</b> не поддерживается для просмотра в браузере.
      </p>
      <p className="muted">Файл можно скачать и открыть в Word / LibreOffice / другом приложении.</p>
      <DownloadButton node={node} label="Скачать файл" className="btn btn-primary" />
    </div>
  );
}

/* ---------------- Обёртка: хлебные крошки + выбор просмотрщика ---------------- */
export default function FileViewer({ node, breadcrumbs, onCrumb }) {
  if (!node) {
    return (
      <div className="viewer welcome">
        <h2>Добро пожаловать! 👋</h2>
        <p>Выберите файл в дереве слева, чтобы открыть его в браузере.</p>
        <ul>
          <li>📕 PDF, 📗 DOCX, 📙 PPTX, 📘 XLSX, 🖼 изображения — читаются прямо здесь;</li>
          <li>⬇ любой файл и целую дисциплину можно скачать (ZIP собирается на лету);</li>
          <li>☑ отметьте файлы галочками и нажмите «Скачать выбранное».</li>
        </ul>
      </div>
    );
  }

  const kind = getFileKind(node.name);
  let content;
  switch (kind) {
    case VIEWERS.PDF:   content = <PdfView key={node.path} node={node} />; break;
    case VIEWERS.DOCX:  content = <DocxView key={node.path} node={node} />; break;
    case VIEWERS.PPTX:  content = <PptxView key={node.path} node={node} />; break;
    case VIEWERS.XLSX:  content = <XlsxView key={node.path} node={node} />; break;
    case VIEWERS.IMAGE: content = <ImageView key={node.path} node={node} />; break;
    case VIEWERS.TEXT:  content = <TextView key={node.path} node={node} />; break;
    case VIEWERS.AUDIO:
    case VIEWERS.VIDEO: content = <MediaView key={node.path} node={node} kind={kind} />; break;
    default:            content = <UnsupportedView key={node.path} node={node} />;
  }

  return (
    <div className="file-viewer">
      <header className="viewer-header">
        <nav className="breadcrumbs" aria-label="Хлебные крошки">
          {breadcrumbs.map((b, i) => (
            <React.Fragment key={i}>
              {i > 0 && <span className="crumb-sep">/</span>}
              {i < breadcrumbs.length - 1
                ? <button className="crumb" onClick={() => onCrumb(b)}>{b.name}</button>
                : <span className="crumb crumb-current">{b.name}</span>}
            </React.Fragment>
          ))}
        </nav>
        <DownloadButton node={node} label="⬇ Скачать" className="btn" />
      </header>
      {content}
    </div>
  );
}
