// Древовидный проводник материалов (аккордеон дисциплин + вложенные папки).
// Поддерживает любой уровень вложенности, чекбоксы выбора, поиск и скачивание ZIP.
import React, { useState } from 'react';
import DownloadButton from './DownloadButton.jsx';
import { downloadFile } from '../utils/zipBuilder';
import { getFileBadge, getFileKind, formatSize, matchesQuery, VIEWERS } from '../utils/fileTypes';

/** Иконка файла — цветной бейдж по расширению. */
function FileIcon({ name }) {
  const kind = getFileKind(name);
  const cls =
    kind === VIEWERS.PDF ? 'badge-pdf' :
    kind === VIEWERS.DOCX ? 'badge-doc' :
    kind === VIEWERS.PPTX ? 'badge-ppt' :
    kind === VIEWERS.XLSX ? 'badge-xls' :
    kind === VIEWERS.IMAGE ? 'badge-img' :
    kind === VIEWERS.TEXT ? 'badge-txt' :
    kind === VIEWERS.AUDIO || kind === VIEWERS.VIDEO ? 'badge-media' :
    'badge-other';
  return <span className={`f-badge ${cls}`}>{getFileBadge(name)}</span>;
}

/** Один узел дерева (папка или файл), рекурсивно. */
function TreeNodeBase({ node, depth, selectedPath, onSelect, checked, onToggleCheck, query }) {
  // При поиске скрываем узлы, не подходящие под запрос
  if (query && !matchesQuery(node, query)) return null;

  if (node.type === 'file') {
    const active = selectedPath === node.path;
    return (
      <div
        className={`tree-row tree-file${active ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onSelect(node)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onSelect(node)}
      >
        <input
          type="checkbox"
          className="tree-check"
          checked={!!checked[node.path]}
          onChange={() => onToggleCheck(node.path)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Выбрать ${node.name}`}
        />
        <FileIcon name={node.name} />
        <span className="tree-name" title={node.path}>{node.name}</span>
        {node.size != null && <span className="tree-size">{formatSize(node.size)}</span>}
        <button
          className="btn btn-small"
          onClick={(e) => { e.stopPropagation(); downloadFile(node).catch(() => {}); }}
          title="Скачать файл"
        >
          ⬇
        </button>
      </div>
    );
  }

  // Папка: раскрывается по клику (аккордеон). Дисциплины (depth 0) открыты по умолчанию при поиске.
  const [open, setOpen] = useState(depth === 0 ? false : false || !!query);
  const isOpen = open || !!query; // при поиске всё раскрыто

  return (
    <div className="tree-node">
      <div
        className={`tree-row tree-dir${depth === 0 ? ' tree-subject' : ''}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => setOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((v) => !v)}
        aria-expanded={isOpen}
      >
        <span className="tree-arrow">{isOpen ? '▾' : '▸'}</span>
        <span className="tree-folder">{depth === 0 ? '📚' : '📁'}</span>
        <span className="tree-name">{node.name}</span>
        <DownloadButton
          dir={node}
          zipName={`${node.name}.zip`}
          label={depth === 0 ? 'Скачать предмет (.zip)' : '.zip'}
          className={`btn btn-small${depth === 0 ? ' btn-zip' : ''}`}
        />
      </div>
      {isOpen && node.children.map((child) => (
        <TreeNode
          key={child.path}
          node={child}
          depth={depth + 1}
          selectedPath={selectedPath}
          onSelect={onSelect}
          checked={checked}
          onToggleCheck={onToggleCheck}
          query={query}
        />
      ))}
    </div>
  );
}

// Сбрасываем локальное состояние раскрытия при смене режима поиска,
// но сам компонент не перемонтируется между обычными кликами.
function TreeNode(props) {
  return <TreeNodeBase key={props.query ? 'q' : 'n'} {...props} />;
}

export default function FileTree({ disciplines, selectedPath, onSelect, checked, onToggleCheck, query }) {
  return (
    <nav className="file-tree" aria-label="Дерево учебных материалов">
      {disciplines.map((d) => (
        <TreeNode
          key={d.path}
          node={d}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
          checked={checked}
          onToggleCheck={onToggleCheck}
          query={query}
        />
      ))}
      {disciplines.length === 0 && <div className="empty-hint">Ничего не найдено.</div>}
    </nav>
  );
}
