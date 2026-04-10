/**
 * Run once: node generate-icons.js
 * Generates valid PNG icons using Node.js built-in zlib.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC-32
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function createPNG(size, r, g, b, padding = 0) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // Raw pixel data: each row = filter byte (0) + RGB * width
  const rowBytes = 1 + size * 3;
  const raw = Buffer.alloc(rowBytes * size);

  for (let y = 0; y < size; y++) {
    const rowOffset = y * rowBytes;
    raw[rowOffset] = 0; // no filter

    for (let x = 0; x < size; x++) {
      const px = rowOffset + 1 + x * 3;
      // If within padding area, use the bg color; otherwise draw a centered icon shape
      if (padding > 0 && (x < padding || x >= size - padding || y < padding || y >= size - padding)) {
        // Maskable safe zone background
        raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
      } else {
        // Draw a simple baby monitor icon: circle with signal waves
        const cx = size / 2, cy = size / 2;
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxR = (size - padding * 2) / 2;

        // Outer circle background
        if (dist <= maxR) {
          // Inner circle (monitor body)
          const innerR = maxR * 0.35;
          if (dist <= innerR) {
            raw[px] = 255; raw[px + 1] = 255; raw[px + 2] = 255; // white dot
          }
          // Signal arcs (top-right quadrant)
          else if (dx > 0 && dy < 0) {
            const arc1 = Math.abs(dist - maxR * 0.55) < maxR * 0.04;
            const arc2 = Math.abs(dist - maxR * 0.72) < maxR * 0.04;
            const arc3 = Math.abs(dist - maxR * 0.89) < maxR * 0.04;
            if (arc1 || arc2 || arc3) {
              raw[px] = 200; raw[px + 1] = 230; raw[px + 2] = 240; // light signal
            } else {
              raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
            }
          } else {
            raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
          }
        } else {
          // Outside circle — match background
          raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
        }
      }
    }
  }

  // Compress with zlib (proper deflate)
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const pub = path.join(__dirname, 'public');
const R = 15, G = 42, B = 53;  // #0F2A35 header color

// Regular icons (no padding)
fs.writeFileSync(path.join(pub, 'icon-192.png'), createPNG(192, R, G, B, 0));
fs.writeFileSync(path.join(pub, 'icon-512.png'), createPNG(512, R, G, B, 0));

// Maskable icons (20% safe zone padding)
fs.writeFileSync(path.join(pub, 'icon-maskable-192.png'), createPNG(192, R, G, B, Math.round(192 * 0.1)));
fs.writeFileSync(path.join(pub, 'icon-maskable-512.png'), createPNG(512, R, G, B, Math.round(512 * 0.1)));

console.log('Generated: icon-192.png, icon-512.png, icon-maskable-192.png, icon-maskable-512.png');
