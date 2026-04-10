/**
 * Run once: node generate-icons.js
 * Generates icon-192.png and icon-512.png in public/
 * Uses only built-in Node.js — no extra packages needed.
 */
const fs = require('fs');
const path = require('path');

function makePng(size) {
  // Minimal valid PNG: solid #4A90A4 square
  const color = [0x4a, 0x90, 0xa4, 0xff]; // RGBA

  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function chunk(type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const crc = crc32(Buffer.concat([typeBytes, data]));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, typeBytes, data, crcBuf]);
  }

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // IDAT: raw pixel data (no compression — use zlib deflate store)
  const row = Buffer.alloc(1 + size * 3); // filter byte + RGB per pixel
  row[0] = 0; // None filter
  for (let x = 0; x < size; x++) {
    row[1 + x * 3] = color[0];
    row[2 + x * 3] = color[1];
    row[3 + x * 3] = color[2];
  }
  const rawData = Buffer.concat(Array(size).fill(row));

  // zlib store block (no compression, type 0)
  const zlib = zlibStore(rawData);

  // Assemble PNG
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function zlibStore(data) {
  // zlib header (CMF=0x78 deflate, FLG=0x01 no dict, fcheck adjusted)
  const cmf = 0x78;
  const flg = 0x01; // CMF*256 + FLG must be divisible by 31 → 0x7801 % 31 = 0 ✓
  const adler = adler32(data);
  const len = data.length;
  const out = [];
  out.push(cmf, flg);

  // Deflate stored blocks (BTYPE=00)
  let offset = 0;
  while (offset < len) {
    const blockLen = Math.min(65535, len - offset);
    const last = offset + blockLen >= len ? 1 : 0;
    out.push(last); // BFINAL | BTYPE=00
    out.push(blockLen & 0xff, (blockLen >> 8) & 0xff);
    out.push((~blockLen) & 0xff, ((~blockLen) >> 8) & 0xff);
    for (let i = 0; i < blockLen; i++) out.push(data[offset + i]);
    offset += blockLen;
  }

  // Adler-32 checksum (big-endian)
  out.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return Buffer.from(out);
}

function adler32(buf) {
  let s1 = 1, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s1 = (s1 + buf[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return (s2 << 16) | s1;
}

// CRC-32 table
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const publicDir = path.join(__dirname, 'public');
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), makePng(192));
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), makePng(512));
console.log('Generated public/icon-192.png and public/icon-512.png');
