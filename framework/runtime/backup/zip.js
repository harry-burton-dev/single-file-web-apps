// A store-only zip writer and reader (PKWARE APPNOTE 4.3): local file headers,
// a central directory and the end record, method 0 (no compression) and CRC-32.
// Backups are already encrypted, so compressing them would gain nothing.
// No zip64, no comments, no extra fields: a backup is a handful of small files.

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipError";
  }
}

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const VERSION = 10; // 1.0: stored entries only
const UTF8_NAMES = 0x0800;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields, read as UTC (zip has no time zone). */
function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getUTCFullYear(), 1980), 2107);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

/** One zip file from [{ name, bytes }]. modifiedAt (epoch ms) stamps every entry. */
export function writeZip(entries, { modifiedAt = Date.UTC(1980, 0, 1) } = {}) {
  const encoder = new TextEncoder();
  const { time, date } = dosTime(modifiedAt);
  const files = entries.map(({ name, bytes }) => ({ name: encoder.encode(name), bytes, crc: crc32(bytes) }));
  const localSize = files.reduce((n, f) => n + 30 + f.name.length + f.bytes.length, 0);
  const centralSize = files.reduce((n, f) => n + 46 + f.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v, true); at += 4; };
  const put = (bytes) => { out.set(bytes, at); at += bytes.length; };
  // Fields shared by the local and central headers, from "version needed" to the name length.
  const common = (f) => { u16(VERSION); u16(UTF8_NAMES); u16(0); u16(time); u16(date); u32(f.crc); u32(f.bytes.length); u32(f.bytes.length); u16(f.name.length); u16(0); };

  for (const f of files) {
    f.offset = at;
    u32(LOCAL); common(f); put(f.name); put(f.bytes);
  }
  const centralAt = at;
  for (const f of files) {
    u32(CENTRAL); u16(VERSION); common(f);
    u16(0); u16(0); u16(0); u32(0); u32(f.offset); // comment length, disk, internal and external attributes, local header offset
    put(f.name);
  }
  u32(END); u16(0); u16(0); u16(files.length); u16(files.length); u32(centralSize); u32(centralAt); u16(0);
  return out;
}

/** The entries of a zip written by writeZip (or any stored, non-zip64 zip). Throws ZipError. */
export function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const need = (ok, what) => { if (!ok) throw new ZipError(`not a readable zip file: ${what}`); };

  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === END) { end = i; break; }
  }
  need(end >= 0, "no end record");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    need(at + 46 <= bytes.length && view.getUint32(at, true) === CENTRAL, "bad central directory");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const skip = nameLen + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    need(at + 46 + nameLen <= bytes.length, "bad central directory");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    need(method === 0, `${name} is compressed`);
    need(offset + 30 <= bytes.length && view.getUint32(offset, true) === LOCAL, `bad header for ${name}`);
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    need(start + size <= bytes.length, `${name} is cut short`);
    const data = bytes.slice(start, start + size);
    need(crc32(data) === crc, `${name} fails its CRC check`);
    entries.push({ name, bytes: data });
    at += 46 + skip;
  }
  return entries;
}
