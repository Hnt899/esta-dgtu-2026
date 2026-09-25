// Главный компонент SPA: заголовок, поиск, панель скачивания ZIP, дерево + просмотр.
import React, { useEffect, useMemo, useState } from 'react';
import FileTree from './components/FileTree.jsx';
import FileViewer from './components/FileViewer.jsx';
import DownloadButton from './components/DownloadButton.jsx';
import { getDisciplines, TOTAL_FILE_COUNT } from './utils/materials';
import { collectFiles } from './utils/fileTypes';

const LS_LAST_FILE = 'esta-dgtu:lastFile';
const LS_THEME = 'esta-dgtu:theme';

export default function App() {
  // Дерево дисциплин строим один раз (glob-ключи известны на этапе сборки)
  const disciplines = useMemo(() => getDisciplines(), []);

  const [selectedPath, setSelectedPath] = useState('');   // путь открытого файла
  const [checked, setChecked] = useState({});             // чекбоксы «Скачать выбранное»
  const [query, setQuery] = useState('');                 // поиск по названиям
  const [dark, setDark] = useState(() => localStorage.getItem(LS_THEME) === 'dark');
  const [treeOpen, setTreeOpen] = useState(false);        // мобильная панель дерева
  const [zipProgress, setZipProgress] = useState(null);   // { text, pct } для большого глобального прогресса

  // Индекс всех файлов по пути — чтобы восстановить последний открытый файл из localStorage
  const fileIndex = useMemo(() => {
    const map = {};
    for (const d of disciplines) for (const f of collectFiles(d)) map[f.path] = f;
    return map;
  }, [disciplines]);

  // Восстановление последнего открытого файла
  useEffect(() => {
    const last = localStorage.getItem(LS_LAST_FILE);
    if (last && fileIndex[last]) setSelectedPath(last);
  }, [fileIndex]);

  // Тёмная тема
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem(LS_THEME, dark ? 'dark' : 'light');
  }, [dark]);

  const selectedNode = selectedPath ? fileIndex[selectedPath] : null;

  // Хлебные крошки: Дисциплина / Папка / ... / Файл
  const breadcrumbs = useMemo(() => {
    if (!selectedPath) return [];
    const parts = selectedPath.split('/');
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }, [selectedPath]);

  const selectFile = (node) => {
    setSelectedPath(node.path);
    localStorage.setItem(LS_LAST_FILE, node.path);
    setTreeOpen(false); // на мобильных после выбора файла закрываем панель
    window.scrollTo({ top: 0 });
  };

  const toggleCheck = (path) =>
    setChecked((c) => {
      const n = { ...c };
      if (n[path]) delete n[path]; else n[path] = true;
      return n;
    });

  const checkedList = useMemo(
    () => Object.keys(checked).filter((p) => fileIndex[p]).map((p) => fileIndex[p]),
    [checked, fileIndex]
  );

  // Все файлы всех дисциплин — для «Скачать всё»
  const allFiles = useMemo(() => {
    let out = [];
    for (const d of disciplines) out = out.concat(collectFiles(d));
    return out;
  }, [disciplines]);

  // Клик по хлебной крошке-папке: просто подсвечиваем дерево (файл сбрасывать не будем — оставим в истории)
  const onCrumb = (b) => {
    if (fileIndex[b.path]) selectFile(fileIndex[b.path]);
  };

  return (
    <div className="app">
      {/* ---------- Шапка ---------- */}
      <header className="topbar">
        <button
          className="btn btn-menu"
          onClick={() => setTreeOpen((v) => !v)}
          aria-label="Показать/скрыть список предметов"
        >
          ☰
        </button>
        <div className="topbar-title">
          <h1>Учебные материалы ДГТУ</h1>
          <p className="subtitle">
            2026–2027 учебный год, профиль Уголовно-правовой, 1 курс,
            40.03.01 Юриспруденция (ЮЗЮS) — бакалавр (сокращённая)
          </p>
        </div>
        <button
          className="btn btn-theme"
          onClick={() => setDark((v) => !v)}
          title="Переключить тему"
        >
          {dark ? '☀️' : '🌙'}
        </button>
      </header>

      {/* ---------- Панель инструментов ---------- */}
      <div className="toolbar">
        <input
          type="search"
          className="search"
          placeholder="🔍 Поиск по названию файла или папки…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск материалов"
        />
        <span className="counter muted">
          Дисциплин: {disciplines.length} · Файлов: {TOTAL_FILE_COUNT}
        </span>
        <DownloadButton
          nodes={checkedList}
          zipName="Выбранное"
          label={`⬇ Скачать выбранное (${checkedList.length})`}
          className="btn btn-primary"
          onProgress={(text, p) => setZipProgress({ text, pct: p })}
        />
        <DownloadButton
          nodes={allFiles}
          zipName="Все материалы ДГТУ 2026-2027"
          label="⬇ Скачать всё"
          className="btn"
          onProgress={(text, p) => setZipProgress({ text, pct: p })}
        />
      </div>

      {/* ---------- Глобальный прогресс сборки ZIP ---------- */}
      {zipProgress && (
        <div className="zip-progress" role="status">
          <div className="zip-progress-bar" style={{ width: `${Math.round(zipProgress.pct * 100)}%` }} />
          <span className="zip-progress-text">{zipProgress.text}</span>
        </div>
      )}

      {/* ---------- Основная область: дерево + просмотр ---------- */}
      <main className={`layout${treeOpen ? ' tree-open' : ''}`}>
        <aside className={`sidebar${treeOpen ? ' open' : ''}`} aria-label="Список дисциплин">
          <FileTree
            disciplines={disciplines}
            selectedPath={selectedPath}
            onSelect={selectFile}
            checked={checked}
            onToggleCheck={toggleCheck}
            query={query}
          />
        </aside>
        {/* Затемнение под деревом на мобильных */}
        {treeOpen && <div className="backdrop" onClick={() => setTreeOpen(false)} />}
        <section className="content">
          <FileViewer node={selectedNode} breadcrumbs={breadcrumbs} onCrumb={onCrumb} />
        </section>
      </main>

      <footer className="footer muted">
        ZIP-архивы собираются прямо в браузере (JSZip) и не хранятся в репозитории.
      </footer>
    </div>
  );
}
