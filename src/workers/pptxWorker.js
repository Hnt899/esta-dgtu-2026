// Web Worker: извлечение текста слайдов из PPTX без тяжёлых зависимостей.
// PPTX — это ZIP; читаем ppt/slides/slideN.xml и вытаскиваем <a:t>.

async function decompressRaw(data) {
  // DEFLATE-распаковка через нативный DecompressionStream (современные браузеры)
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}

function crc32(buf, table) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

self.onmessage = async (e) => {
  try {
    const bytes = new Uint8Array(e.data);
    const dv = new DataView(e.data);

    // Ищем End of Central Directory (подпись 0x06054b50) с конца файла
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('Не удалось найти конец ZIP-структуры');

    const cdCount = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true); // начало Central Directory
    const entries = [];

    for (let n = 0; n < cdCount; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const crc = dv.getUint32(p + 16, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries.push({ name, method, crc, compSize, localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }

    // Только слайды, отсортированные по номеру
    const slides = entries
      .filter((en) => /^ppt\/slides\/slide\d+\.xml$/.test(en.name))
      .sort((a, b) => parseInt(a.name.match(/\d+/)[0]) - parseInt(b.name.match(/\d+/)[0]));

    const decoder = new TextDecoder('utf-8');
    const result = [];

    for (const s of slides) {
      // Локальный заголовок файла
      const lh = s.localOff;
      const nameLen = dv.getUint16(lh + 26, true);
      const extraLen = dv.getUint16(lh + 28, true);
      const dataStart = lh + 30 + nameLen + extraLen;
      const raw = bytes.subarray(dataStart, dataStart + s.compSize);

      let xmlBytes;
      if (s.method === 0) xmlBytes = raw;
      else if (s.method === 8) xmlBytes = new Uint8Array(await decompressRaw(raw));
      else throw new Error('Неизвестный метод сжатия: ' + s.method);

      // Проверка контрольной суммы
      if (crc32(xmlBytes, CRC_TABLE) !== s.crc) throw new Error('Повреждён поток: ' + s.name);

      const xml = decoder.decode(xmlBytes);
      // Блоки абзацев <a:p>…</a:p>, внутри — текстовые ранги <a:t>…</a:t>
      const paragraphs = [];
      for (const pm of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)) {
        let text = '';
        for (const tm of pm[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)) {
          text += tm[1];
        }
        text = text
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
          .replace(/&amp;/g, '&')
          .trim();
        if (text) paragraphs.push(text);
      }
      result.push(paragraphs);
    }

    self.postMessage({ ok: true, slides: result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
