// Сборка ZIP-архивов на лету (в браузере) через JSZip.
// Готовые ZIP в репозитории НЕ хранятся — они собираются из распакованных папок materials/.

import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { loadFileBuffer } from './materials';
import { getMime } from './fileTypes';

/**
 * Собрать ZIP из списка файловых узлов дерева.
 * @param {Array}  fileNodes  — [{ name, path, loader, size }, ...]
 * @param {string} zipName    — имя итогового архива (без .zip добавим сами)
 * @param {Function} onProgress — (0..1, текстСтатуса) => void
 * @returns {Promise<Blob>}
 */
export async function buildZip(fileNodes, zipName, onProgress = () => {}) {
  const zip = new JSZip();
  const totalBytes = fileNodes.reduce((s, f) => s + (f.size || 0), 0) || 1;
  let loadedBytes = 0;
  let done = 0;

  for (const node of fileNodes) {
    // Путь внутри архива сохраняем таким же, как в materials/ (с подпапками)
    zip.file(node.path, await loadFileBuffer(node));
    loadedBytes += node.size || 0;
    done += 1;
    onProgress(
      Math.min(0.95, loadedBytes / totalBytes),
      `Загружено ${done} из ${fileNodes.length} файлов`
    );
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE', mimeType: 'application/zip' },
    (meta) => {
      // compression STORE — документы и картинки уже сжаты, это ускоряет сборку
      onProgress(0.95 + 0.05 * (meta.percent / 100), 'Упаковка архива…');
    }
  );
  onProgress(1, 'Готово');
  return blob;
}

/** Собрать и сразу отдать ZIP на скачивание. */
export async function downloadZip(fileNodes, zipName, onProgress) {
  const blob = await buildZip(fileNodes, zipName, onProgress);
  saveAs(blob, zipName.endsWith('.zip') ? zipName : zipName + '.zip');
}

/** Скачать одиночный файл (как есть). */
export async function downloadFile(node) {
  const buffer = await loadFileBuffer(node);
  saveAs(new Blob([buffer], { type: getMime(node.name) }), node.name);
}
