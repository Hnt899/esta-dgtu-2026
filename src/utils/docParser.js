// Лёгкий (без WASM) парсер старых бинарных документов Word 97–2003 (.doc, OLE2/CFB).
// Читает текст из WordDocument-стрима через FIB -> table stream (0Table/1Table) -> Clx -> PlcPcd.
// Используется как «мгновенный» режим чтения; полноценный HTML с форматированием даёт LibreOffice WASM
// (см. docConverter.js), который грузится лениво только по кнопке пользователя.

/** Простой TextDecoder с фолбэком (cp1251 нужен для не-Unicode записей старых .doc). */
function makeDecoder(enc) {
  try {
    return new TextDecoder(enc);
  } catch {
    // Браузер без поддержки codepage — декодируем вручную (таблица кириллицы cp1251)
    return {
      decode(buf) {
        const b = new Uint8Array(buf);
        let s = '';
        for (let i = 0; i < b.length; i++) {
          const c = b[i];
          if (enc !== 'windows-1251' || c < 0x80) s += String.fromCharCode(c);
          else s += CP1251[c - 0x80] || '?';
        }
        return s;
      },
    };
  }
}

// Символы cp1251 начиная с 0x80 (кириллица + общая типографика)
const CP1251 =
  '\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a' +
  '\u040c\u040b\u040f\u0452\u2013\u2014\u0455\u2116\u201a\u0456\u0457\u201e\u0459\u203a' +
  '\u045a\u045c\u045b\u045f\xa0\u045e\u040e\u0408¡\u0405¦§¨©ª«¬\xad®¯°±²³´µ¶·¸¹º»¼½¾¿' +
  '\u0415\u0410ЂЃ\u0414\u0415ЖЗ\u0419КЉЛ\u041dОПР\u0421Т\u0423Ж\u0425ЦЧ\u0428ЩЪЫЬЭЮЯ' +
  '\u0435\u0430ђѓ\u0434\u0435жз\u0439кљл\u043dоп\u0441т\u0443\u0444хцч\u0448щъыьэюя';

/** Разобрать контейнер OLE2 (Compound File Binary) и вернуть карту имён стримов. */
export function parseOle2(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);

  // Сигнатура D0 CF 11 E0 A1 B1 1A E1
  if (!(u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0)) return null;

  const sectorShift = dv.getUint16(30, true);   // обычно 9 -> сектор 512 байт
  const miniShift = dv.getUint16(32, true);     // обычно 6 -> мини-сектор 64 байта
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniShift;
  const numFatSectors = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  const numMiniFat = dv.getUint32(64, true);
  const difatStart = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);

  // Читаем цепочку секторов (FAT/DIFAT/MINI-FAT) по старым ссылкам
  const readChain = (start, fatReader) => {
    const out = [];
    let s = start >>> 0;
    const guard = new Set();
    // конец цепочки — значения >= 0xFFFFFFFA (ENDOFCHAIN/FREESECT и пр.)
    while (s < 0xfffffffa && !guard.has(s)) {
      guard.add(s);
      out.push(s);
      s = fatReader(s) >>> 0;
    }
    return out;
  };

  // DIFAT: первые 109 записей в заголовке, далее — по секторам
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = dv.getUint32(76 + i * 4, true);
    if (v >= 0xfffffffa) break; // FREESECT/ENDOFCHAIN
    difat.push(v >>> 0);
  }
  let nextDifat = difatStart >>> 0;
  let guard = 0;
  while (nextDifat < 0xfffffffa && guard++ < 4096) {
    const base = (nextDifat + 1) * sectorSize;
    if (base + sectorSize > buffer.byteLength) break;
    for (let i = 0; i < (sectorSize - 4) / 4; i++) {
      const v = dv.getUint32(base + i * 4, true);
      if (v < 0xfffffffa) difat.push(v >>> 0);
    }
    nextDifat = dv.getUint32(base + sectorSize - 4, true) >>> 0;
  }

  // FAT
  const fat = new Map();
  for (const fs of difat.slice(0, numFatSectors)) {
    const base = (fs + 1) * sectorSize;
    const count = Math.min((base + sectorSize <= buffer.byteLength ? sectorSize : buffer.byteLength - base) / 4, sectorSize / 4);
    for (let i = 0; i < count; i++) fat.set(fs * (sectorSize / 4) + i, dv.getUint32(base + i * 4, true));
  }
  const fatGet = (idx) => fat.get(idx) ?? 0xffffffff;

  // MiniFAT
  const miniFat = new Map();
  {
    const sectors = readChain(miniFatStart, fatGet);
    sectors.forEach((sec, k) => {
      const base = (sec + 1) * sectorSize;
      for (let i = 0; i < sectorSize / 4; i++) miniFat.set(k * (sectorSize / 4) + i, dv.getUint32(base + i * 4, true));
    });
  }
  const miniFatGet = (idx) => miniFat.get(idx) ?? 0xffffffff;

  // Корневый стрим мини-SFAT (цепочка сектора начала root entry)
  const dataAt = (secIdx) => (secIdx + 1) * sectorSize;

  // Directory entries (по 128 байт на запись)
  const dirSectors = readChain(dirStart, fatGet);
  const entries = [];
  for (const sec of dirSectors) {
    const base = dataAt(sec);
    for (let off = 0; off + 128 <= sectorSize && base + off + 128 <= buffer.byteLength; off += 128) {
      const nameLen = dv.getUint16(base + off + 64, true); // в байтах, включая \0
      if (nameLen >= 2 && nameLen <= 64) {
        const name = new TextDecoder('utf-16le').decode(new Uint8Array(buffer, base + off, nameLen - 2));
        const type = u8[base + off + 66]; // 0 free, 1 storage, 2 root
        const startSec = dv.getUint32(base + off + 116, true);
        const size = dv.getUint32(base + off + 120, true);
        entries.push({ name, type, startSec: startSec >>> 0, size });
      }
    }
  }
  // Тип записи каталога: 5 = Root Entry (из него берём размер для потоков < 4096)
  const root = entries.find((e) => e.type === 5);
  if (!root) return null;

  // Читаем потоки ПО СЕКТОРАМ (без аллокации цепочек целиком — файлы бывают ~100 МБ).
  // Возвращает функцию чтения диапазона [from, to) байт потока в новый Uint8Array.
  const readBigStream = (startSec, size) => readBigRange(startSec, 0, size);
  const readMiniStream = (startSec, size) => readMiniRange(startSec, 0, size);
  const readBigRange = (startSec, from, len) => {
    const out = new Uint8Array(len);
    let sec = startSec >>> 0;
    let logical = 0;
    const guard = new Set();
    while (sec < 0xfffffffa && logical < from + len && !guard.has(sec)) {
      guard.add(sec);
      const take = Math.min(sectorSize, from + len - logical);
      if (logical >= from) {
        const base = (sec + 1) * sectorSize;
        const avail = Math.max(0, Math.min(take, buffer.byteLength - base));
        if (avail > 0) out.set(new Uint8Array(buffer, base, avail), logical - from);
      }
      logical += sectorSize;
      sec = fatGet(sec) >>> 0;
    }
    return out;
  };
  // Мини-потоки лежат внутри корневого стрима: его секторы образуют «виртуальный» массив
  const rootChain = readChain(root.startSec, fatGet);
  const readMiniRange = (startSec, from, len) => {
    const out = new Uint8Array(len);
    let ms = startSec >>> 0;
    let logical = 0;                                    // текущее смещение в потоке
    const guard = new Set();
    while (ms < 0xfffffffa && logical < from + len && !guard.has(ms)) {
      guard.add(ms);
      const secIdx = Math.floor(logical / sectorSize);
      const inSec = logical % sectorSize;
      const take = Math.min(miniSectorSize, from + len - logical);
      if (logical >= from && secIdx < rootChain.length) {
        const base = dataAt(rootChain[secIdx]) + inSec; // мини-сектор не пересекает границы секторов FAT
        if (base + take <= buffer.byteLength) out.set(new Uint8Array(buffer, base, take), logical - from);
      }
      logical += miniSectorSize;
      ms = miniFatGet(ms) >>> 0;
    }
    return out;
  };

  const map = {};
  for (const e of entries) {
    // type 1 == stream (некоторые генераторы пишут 2); фильтруем по имени в любом случае
    if ((e.type === 1 || e.type === 2) && (e.name === 'WordDocument' || e.name === '1Table' || e.name === '0Table')) {
      const isBig = e.size >= miniCutoff;
      const stream = {
        size: e.size,
        bytes: null, // кэш полного содержимого (лениво)
        load() {
          if (!this.bytes) this.bytes = isBig ? readBigStream(e.startSec, e.size) : readMiniStream(e.startSec, e.size);
          return this.bytes;
        },
        // диапазон [from, from+len) без обязательной полной аллокации
        read(from, len) {
          from = Math.max(0, Math.min(from | 0, e.size));
          len = Math.max(0, Math.min(len | 0, e.size - from));
          return isBig ? readBigRange(e.startSec, from, len) : readMiniRange(e.startSec, from, len);
        },
      };
      map[e.name] = stream;
    }
  }
  return map.WordDocument ? map : null;
}

/** Извлечь текст из .doc-потоков (результат parseOle2). '' если разбор не удался. */
export function extractDocText(streams) {
  const wd = streams && streams.WordDocument;
  const table = streams['1Table'] || streams['0Table'];
  if (!wd || !table || wd.size < 0x200) return '';

  // FIB в начале WordDocument-стрима
  const fibBuf = wd.read(0, 0x200);
  const fib = new DataView(fibBuf.buffer, fibBuf.byteOffset, fibBuf.byteLength);
  if (fib.getUint16(0, true) !== 0xa5ec) return ''; // не Word binary
  const fWhichTblStm = (fib.getUint16(10, true) & 0x0200) >> 9;
  const tbl = streams[fWhichTblStm ? '1Table' : '0Table'] || table;

  // FibRgFcLcb97: fcClx/lcbClx лежат в WordDocument-стриме (смещения от конца FIB):
  //   offset = csw*2 + cslw*4 + cbRgFcLcb*2 + 0x1a2/0x1a6
  const csw = fib.getUint16(32, true);
  const cslw = fib.getUint16(34, true);
  const cbRgFcLcb = fib.getUint16(36, true);
  const offClx = csw * 2 + cslw * 4 + cbRgFcLcb * 2;
  if (offClx + 0x1aa > wd.size) return '';
  const rgfc = wd.read(offClx, 0x1aa + 8);
  const rgdv = new DataView(rgfc.buffer, rgfc.byteOffset, rgfc.byteLength);
  const fcClx = rgdv.getUint32(0x01a2, true);
  const lcbClx = rgdv.getUint32(0x01a6, true);
  if (!lcbClx || fcClx + lcbClx > tbl.size) return '';

  const clx = tbl.read(fcClx, lcbClx);

  // Обходим Clx: пропускаем записи Prc (clxt=1), ищем Pcdt (clxt=2)
  let p = 0;
  let plcpcd = null;
  while (p < clx.length) {
    const clxt = clx[p];
    const tdv = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);
    if (clxt === 1) {
      const cb = tdv.getUint16(p + 1, true);
      p += 3 + cb;
    } else if (clxt === 2) {
      const lcb = tdv.getUint32(p + 1, true);
      plcpcd = { start: p + 5, len: Math.min(lcb, clx.length - p - 5) };
      break;
    } else break;
  }
  if (!plcpcd || plcpcd.len < 16) return '';

  // PlcPcd: (n+1) x FC (uint32) + n x PCD (8 байт)
  const n = Math.floor((plcpcd.len - 4) / 12);
  if (n < 1) return '';
  const pdv = new DataView(clx.buffer, clx.byteOffset, clx.byteLength);

  const utf16 = makeDecoder('utf-16le');
  const cp1251 = makeDecoder('windows-1251');
  const parts = [];

  for (let i = 0; i < n; i++) {
    const pcdOff = plcpcd.start + (n + 1) * 4 + i * 8;
    if (pcdOff + 8 > clx.length) break;
    const fcRaw = pdv.getUint32(pcdOff + 2, true);
    const fCompressed = (fcRaw & 0x40000000) !== 0;
    const realFc = fCompressed ? (fcRaw & 0x3fffffff) * 2 : (fcRaw & 0x3fffffff);
    const ccp = pdv.getUint32(pcdOff + 6, true) & 0x3fffffff; // число символов
    if (!ccp || realFc <= 0 || realFc >= wd.size) continue;

    if (fCompressed) {
      const bytes = wd.read(realFc, ccp);
      parts.push(cp1251.decode(bytes));
    } else {
      const bytes = wd.read(realFc, ccp * 2);
      parts.push(utf16.decode(bytes));
    }
  }

  let text = parts.join('');
  // Управляющие символы Word: \r — абзац, \x07 — конец ячейки/строки таблицы, остальное выкинуть
  text = text.replace(/[\x00-\x06\x08\x0b\x0c\x0e-\x1f]/g, '');
  text = text.replace(/\x07/g, '\n');
  text = text.replace(/\r/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

/** Признак RTF-файла с расширением .doc (иногда встречается). */
export function looksLikeRtf(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength));
  return head[0] === 0x7b && head[1] === 0x5c && head[2] === 0x72 && head[3] === 0x74 && head[4] === 0x66;
}

/** Примитивный RTF → текст: убираем контрольные группы, оставляем литералы. */
export function rtfToPlainText(text) {
  let out = '';
  let i = 0;
  const skipGroup = () => {
    // пропускаем содержимое до закрывающей } с учётом вложенности
    let depth = 1;
    i++;
    while (i < text.length && depth > 0) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      i++;
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') { i++; continue; }
    if (ch === '}') { i++; continue; }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === "'") {
        const hex = parseInt(text.substr(i + 2, 2), 16);
        if (!isNaN(hex)) out += String.fromCharCode(hex);
        i += 4;
        continue;
      }
      if (next === '\\') { out += '\\'; i += 2; continue; }
      if (next === '{') { out += '{'; i += 2; continue; }
      if (next === '}') { out += '}'; i += 2; continue; }
      if (next === '*') { skipGroup(); continue; }
      // словесная команда
      let j = i + 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j++;
      const word = text.slice(i + 1, j);
      while (j < text.length && /[0-9- ]/.test(text[j])) j++;
      if (text[j] === ' ') j++;
      i = j;
      if (word === 'par' || word === 'line' || word === 'tab') out += word === 'tab' ? '\t' : '\n';
      else if (word === 'cell' || word === 'row') out += '\n';
      continue;
    }
    out += ch;
    i++;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
