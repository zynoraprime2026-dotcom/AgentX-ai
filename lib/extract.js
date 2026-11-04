// Text extraction for knowledge-base uploads, with no third-party deps.
// Supports .txt/.md/.csv/.json/.html directly, .docx via the zip container,
// and .pdf via FlateDecode stream inflation + text-operator scraping.
const zlib = require('zlib');

// Decompression must have a ceiling: a small, crafted file could otherwise
// inflate to gigabytes and take the instance down.
const MAX_INFLATE = 16 * 1024 * 1024;
const inflate = (buf) => zlib.inflateSync(buf, { maxOutputLength: MAX_INFLATE });
const inflateRaw = (buf) => zlib.inflateRawSync(buf, { maxOutputLength: MAX_INFLATE });

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------- PDF ----------
function pdfEscapes(s) {
  return s
    .replace(/\\([nrtbf])/g, (m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c]))
    .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, '$1');
}

function pdfOpsToText(chunk) {
  const parts = [];
  // (literal) Tj  and  [ (a) -120 (b) ] TJ
  const re = /\((?:\\.|[^\\()])*\)|\bT[Jj]\b|\bTD\b|\bTd\b|\bT\*\b|\bET\b|\bBT\b/g;
  let m;
  while ((m = re.exec(chunk))) {
    const tok = m[0];
    if (tok.startsWith('(')) {
      parts.push(pdfEscapes(tok.slice(1, -1)));
    } else if (tok === 'Td' || tok === 'TD' || tok === 'T*' || tok === 'ET') {
      parts.push('\n');
    }
  }
  return parts.join(' ').replace(/[ ]*\n[ ]*/g, '\n');
}

function pdfText(buf) {
  const raw = buf.toString('latin1');
  const out = [];
  let i = 0;
  while (true) {
    const s = raw.indexOf('stream', i);
    if (s === -1) break;
    let start = s + 6;
    if (raw[start] === '\r') start++;
    if (raw[start] === '\n') start++;
    const e = raw.indexOf('endstream', start);
    if (e === -1) break;
    const chunk = Buffer.from(raw.slice(start, e), 'latin1');
    let text = '';
    try {
      text = pdfOpsToText(inflate(chunk).toString('latin1'));
    } catch (err) {
      try {
        text = pdfOpsToText(inflateRaw(chunk).toString('latin1'));
      } catch (err2) {
        text = pdfOpsToText(chunk.toString('latin1'));
      }
    }
    if (text.trim()) out.push(text);
    i = e + 9;
  }
  return out.join('\n');
}

// ---------- DOCX / any zip ----------
function zipEntries(buf) {
  const entries = [];
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) return entries;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function unzipEntry(buf, entry) {
  const lo = entry.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.slice(start, start + entry.compSize);
  if (entry.method === 0) return data;
  try { return inflateRaw(data); } catch (e) { return null; }
}

function docxText(buf) {
  const entries = zipEntries(buf);
  const pick = entries.find((e) => e.name === 'word/document.xml') || entries.find((e) => /word\/.*\.xml$/.test(e.name));
  if (!pick) throw new Error('That file is not a Word document');
  const xml = (unzipEntry(buf, pick) || Buffer.alloc(0)).toString('utf8');
  return clean(
    xml
      .replace(/<w:p[^>]*>/g, '\n')
      .replace(/<w:tab[^>]*\/>/g, '\t')
      .replace(/<w:br[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  );
}

function htmlText(text) {
  return clean(
    String(text)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  );
}

function extract(name, buffer) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.pdf')) return clean(pdfText(buffer));
  if (lower.endsWith('.docx')) return docxText(buffer);
  const text = buffer.toString('utf8');
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return htmlText(text);
  return clean(text);
}

module.exports = { extract, clean, pdfText, docxText };
