/**
 * QR image for the WeChat ClawBot login.
 *
 * The settings page cannot draw a QR by itself, so the host half turns the payload the server
 * returns (qrcode_img_content: a URL) into a PNG data URL the page can put straight into an
 * <img>. The encoder is vendored (Apache-2.0, components/newmate/vendor/qrcode-terminal) and
 * the PNG writer is ~50 lines of zlib + CRC32 instead of an image library.
 */
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** QR module matrix (true = dark) for a payload. */
export function qrMatrix(text) {
  const QRCode = require(path.join(here, '..', 'vendor', 'qrcode-terminal', 'vendor', 'QRCode', 'index.js'));
  const QRErrorCorrectLevel = require(path.join(here, '..', 'vendor', 'qrcode-terminal', 'vendor', 'QRCode', 'QRErrorCorrectLevel.js'));
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const cells = [];
    for (let col = 0; col < count; col += 1) cells.push(qr.isDark(row, col) === true);
    rows.push(cells);
  }
  return rows;
}

export function qrPngBuffer(text, { scale = 8, margin = 4 } = {}) {
  const matrix = qrMatrix(text);
  const modules = matrix.length;
  const side = (modules + margin * 2) * scale;
  const bytesPerRow = side * 3 + 1;
  const raw = Buffer.alloc(bytesPerRow * side, 0xff);
  for (let y = 0; y < side; y += 1) raw[y * bytesPerRow] = 0; // PNG filter: none
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (!matrix[row][col]) continue;
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (row + margin) * scale + dy;
        for (let dx = 0; dx < scale; dx += 1) {
          const x = (col + margin) * scale + dx;
          const offset = y * bytesPerRow + 1 + x * 3;
          raw[offset] = 0; raw[offset + 1] = 0; raw[offset + 2] = 0;
        }
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A data URL the page can put into <img src>. */
export function qrDataUrl(text, options) {
  return 'data:image/png;base64,' + qrPngBuffer(text, options).toString('base64');
}