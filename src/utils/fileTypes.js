// Утилиты определения типа файла по расширению и построения дерева из import.meta.glob

// Поддерживаемые для просмотра в браузере форматы
export const VIEWERS = {
  PDF: 'pdf',
  DOCX: 'docx',
  PPTX: 'pptx',
  XLSX: 'xlsx',
  IMAGE: 'image',
  TEXT: 'text',
  AUDIO: 'audio',
  VIDEO: 'video',
  NONE: 'none', // не поддерживается — только скачивание
};

const EXT_MAP = {
  pdf: VIEWERS.PDF,
  docx: VIEWERS.DOCX,
  doc: VIEWERS.NONE,      // старый бинарный .doc браузером не читается
  pptx: VIEWERS.PPTX,
  ppt: VIEWERS.NONE,
  xlsx: VIEWERS.XLSX,
  xls: VIEWERS.XLSX,     // SheetJS понимает и старый .xls
  xlsm: VIEWERS.XLSX,
  csv: VIEWERS.TEXT,
  txt: VIEWERS.TEXT,
  md: VIEWERS.TEXT,
  json: VIEWERS.TEXT,
  xml: VIEWERS.TEXT,
  html: VIEWERS.TEXT,
  png: VIEWERS.IMAGE,
  jpg: VIEWERS.IMAGE,
  jpeg: VIEWERS.IMAGE,
  gif: VIEWERS.IMAGE,
  bmp: VIEWERS.IMAGE,
  webp: VIEWERS.IMAGE,
  svg: VIEWERS.IMAGE,
  ico: VIEWERS.IMAGE,
  mp3: VIEWERS.AUDIO,
  wav: VIEWERS.AUDIO,
  ogg: VIEWERS.AUDIO,
  mp4: VIEWERS.VIDEO,
  webm: VIEWERS.VIDEO,
  avi: VIEWERS.NONE,     // avi обычно не воспроизводится браузером
  mov: VIEWERS.VIDEO,
  zip: VIEWERS.NONE,
  rar: VIEWERS.NONE,
  '7z': VIEWERS.NONE,
  exe: VIEWERS.NONE,
};

/** Вернуть нижний регистр расширения файла (без точки). */
export function getExtension(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

/** Определить тип просмотрщика по имени файла. */
export function getFileKind(name) {
  return EXT_MAP[getExtension(name)] || VIEWERS.NONE;
}

/** Короткая метка типа для иконки в дереве (DOCX, PDF, ...). */
export function getFileBadge(name) {
  const ext = getExtension(name);
  if (!ext) return 'FILE';
  return ext.toUpperCase().slice(0, 5);
}

/** Человекочитаемый размер файла. */
export function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

// MIME-типы для Blob'ов при скачивании/просмотре
const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
};

export function getMime(name) {
  return MIME[getExtension(name)] || 'application/octet-stream';
}

/**
 * Построить дерево папок из результата import.meta.glob.
 * @param {Object} globResult  — { '/materials/Предмет/файл.docx': () => import(...) }
 * @param {Object} sizeMap     — { '/materials/...': размерВБайтах } (из glob с query: '?url&import')
 * @returns {Array} список корневых узлов-дисциплин
 *
 * Узел дерева:
 *  { type: 'dir'|'file', name, path, children?, loader?, size? }
 */
export function buildTree(globResult, sizeMap) {
  const root = { type: 'dir', name: '', path: '', children: {} };

  for (const key of Object.keys(globResult)) {
    // key вида '/materials/Предмет/Подпапка/файл.docx'
    const rel = key.replace(/^\/+materials\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    let node = root;
    parts.forEach((part, idx) => {
      const isFile = idx === parts.length - 1;
      if (!node.children[part]) {
        node.children[part] = isFile
          ? {
              type: 'file',
              name: part,
              path: parts.slice(0, idx + 1).join('/'),
              loader: globResult[key],
              size: sizeMap ? sizeMap[key] : undefined,
            }
          : { type: 'dir', name: part, path: parts.slice(0, idx + 1).join('/'), children: {} };
      }
      node = node.children[part];
    });
  }

  // Объекты -> отсортированные массивы: сначала папки, затем файлы (по алфавиту)
  const toArray = (dir) => {
    const kids = Object.values(dir.children).map((n) =>
      n.type === 'dir' ? { ...n, children: toArray(n) } : n
    );
    kids.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, 'ru');
    });
    return kids;
  };

  return toArray(root);
}

/** Найти все файловые узлы внутри узла (рекурсивно). */
export function collectFiles(node) {
  if (node.type === 'file') return [node];
  const out = [];
  for (const child of node.children || []) out.push(...collectFiles(child));
  return out;
}

/** Проверка: содержит ли путь/имя подстроку поиска (без учёта регистра). */
export function matchesQuery(node, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (node.name.toLowerCase().includes(q)) return true;
  if (node.path && node.path.toLowerCase().includes(q)) return true;
  if (node.type === 'dir') {
    return (node.children || []).some((c) => matchesQuery(c, q));
  }
  return false;
}
