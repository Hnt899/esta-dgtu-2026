// Кнопка скачивания: одиночного файла или ZIP-группы (с прогрессом и обработкой ошибок)
import React, { useState } from 'react';
import { downloadFile, downloadZip } from '../utils/zipBuilder';
import { collectFiles } from '../utils/fileTypes';

/**
 * @param {Object} props
 *  node      — файловый узел (для одиночного файла), ИЛИ
 *  nodes     — список узлов (для ZIP), ИЛИ dir — узел-папка (все файлы внутри)
 *  zipName   — имя архива
 *  label     — текст кнопки
 *  className — стили
 *  onProgress(text, 0..1) — внешний колбэк прогресса (необязательно)
 */
export default function DownloadButton({ node, nodes, dir, zipName, label, className = 'btn', onProgress }) {
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState('');

  const click = async (e) => {
    e.stopPropagation();
    setError('');
    setBusy(true);
    setPct(0);
    try {
      if (node) {
        await downloadFile(node);
      } else {
        const list = nodes || (dir ? collectFiles(dir) : []);
        if (!list.length) throw new Error('Нет файлов для архива');
        await downloadZip(list, zipName || 'materials', (p, text) => {
          setPct(p);
          if (onProgress) onProgress(text, p);
        });
      }
    } catch (err) {
      setError(err.message || 'Ошибка скачивания');
    } finally {
      setBusy(false);
      setPct(0);
    }
  };

  return (
    <span className="dl-wrap">
      <button className={className} onClick={click} disabled={busy} title={error || undefined}>
        {busy ? `Сборка… ${Math.round(pct * 100)}%` : label}
      </button>
      {busy && (
        <span className="mini-progress">
          <span style={{ width: `${Math.round(pct * 100)}%` }} />
        </span>
      )}
      {error && <span className="dl-error" role="alert">{error}</span>}
    </span>
  );
}
