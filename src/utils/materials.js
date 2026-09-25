// Загрузка списка учебных материалов через import.meta.glob (Vite).
// ВАЖНО: папка materials/архивы/ исключена — ZIP-архивы не хранятся в репозитории,
// приложение собирает их на лету через JSZip (см. utils/zipBuilder.js).

import { buildTree } from './fileTypes';

// Ленивые импорты всех файлов (кроме архивов и служебных .db).
// Каждая запись — функция () => import(...), возвращающая модуль с ?url (mod.default = URL файла).
// В glob-паттерне сразу исключаем materials/архивы/ и готовые .zip — они не должны
// попасть ни в дерево, ни в сборку dist.
const loaders = import.meta.glob([
  '/materials/**/*',
  '!/materials/архивы/**',
  '!/materials/**/*.zip',
], {
  query: '?url',
  import: 'default',
  eager: false,
});

// Метаданные (размер) тех же файлов — берём из manifest Vite без скачивания самих файлов.
const meta = import.meta.glob([
  '/materials/**/*',
  '!/materials/архивы/**',
  '!/materials/**/*.zip',
], {
  query: '?url&import',
  import: 'default',
  eager: true,
});

// Дополнительная страховка: служебные файлы (.db) и случайные пути с «архивы».
const EXCLUDED = /(^|\/)архивы\//; // materials/архивы/ — не участвует
const SKIP_EXT = /\.(zip|db)$/i;    // готовые архивы и служебные базы

const cleanLoaders = {};
const sizeMap = {};
for (const key of Object.keys(loaders)) {
  if (EXCLUDED.test(key) || SKIP_EXT.test(key)) continue;
  cleanLoaders[key] = loaders[key];
  const m = meta[key]; // { file, src, size }
  if (m && typeof m === 'object') sizeMap[key] = m.size;
}

/**
 * Загрузить файл как ArrayBuffer (для JSZip, mammoth, pdf.js, SheetJS).
 */
export async function loadFileBuffer(fileNode) {
  const url = await fileNode.loader(); // ?url -> строка-ссылка на ассет
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось загрузить файл (${resp.status})`);
  return await resp.arrayBuffer();
}

/**
 * Загрузить файл как Blob с правильным MIME (для скачивания / iframe / картинок).
 */
export async function loadFileBlob(fileNode) {
  const buffer = await loadFileBuffer(fileNode);
  return buffer; // ArrayBuffer удобен всем библиотекам; Blob строим при необходимости
}

/** Построить дерево дисциплин (корневые узлы — папки предметов). */
export function getDisciplines() {
  return buildTree(cleanLoaders, sizeMap);
}

export const TOTAL_FILE_COUNT = Object.keys(cleanLoaders).length;
