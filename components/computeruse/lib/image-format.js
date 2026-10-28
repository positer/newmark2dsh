/**
 * Turning a capture into the format the caller asked for.
 *
 * WHY THIS EXISTS. The Windows hidden-desktop agent has no image encoder: it writes the pixels
 * it got from PrintWindow/BitBlt into a BMP by hand (hidden-agent.js WriteBmp), because its
 * Add-Type compilation carries no System.Drawing reference. A BMP is exactly right for that
 * layer - a header and the raw rows - but it is the wrong thing to hand a vision model: every
 * caller then converts it before the image can be read, which is a second pass over the pixels
 * that nobody asked for.
 *
 * So the conversion happens once, here, and only when the caller asks for it. The encoder is
 * written against node's own zlib rather than a dependency, because the whole job is "rows in,
 * deflate, wrap in a PNG container" and a native image library would be a bigger thing to ship,
 * audit and keep working than the few lines it replaces.
 *
 * WHAT IT ACCEPTS. Exactly what the hidden agent writes: BI_RGB, 24 or 32 bits per pixel, rows
 * padded to four bytes, either orientation (negative height means top-down). Anything else is
 * refused by name instead of being guessed at - a decoder that quietly mis-reads a pixel layout
 * produces a plausible picture of the wrong thing, and that is worse than an error.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';

/** The formats a caller may ask for: bmp is the untouched capture, png is vision-ready. */
export const CAPTURE_FORMATS = Object.freeze(['bmp', 'png']);

/** What the caller asked for. Anything that is not PNG keeps today's behaviour (the raw capture). */
export function requestedFormat(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'png' || text === 'image/png') return 'png';
  return 'bmp';
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One PNG chunk: length, type, data, CRC of type+data. */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function refusal(code, error, extra) {
  return { ok: false, code, error, ...extra };
}

/**
 * Decode a BMP into { width, height, rgb }, where rgb is top-down, three bytes per pixel.
 *
 * The two things a naive reader gets wrong are both checked here: the row stride is four-byte
 * aligned (a window whose width is not a multiple of four carries padding at the end of every
 * row), and a negative biHeight means the rows are already top-down.
 */
export function decodeBmp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 54) {
    return refusal('bmp_truncated', 'The capture is shorter than a 54-byte BMP header (' + (buffer ? buffer.length : 0) + ' bytes).');
  }
  if (buffer[0] !== 0x42 || buffer[1] !== 0x4d) {
    return refusal('not_a_bmp', 'The capture does not start with the BMP signature BM.');
  }
  const pixelOffset = buffer.readUInt32LE(10);
  const headerSize = buffer.readUInt32LE(14);
  if (headerSize < 40) return refusal('bmp_header_unsupported', 'Only BITMAPINFOHEADER (40 bytes) is decoded; this capture reports ' + headerSize + '.');
  const width = buffer.readInt32LE(18);
  const rawHeight = buffer.readInt32LE(22);
  const planes = buffer.readUInt16LE(26);
  const bitCount = buffer.readUInt16LE(28);
  const compression = buffer.readUInt32LE(30);
  if (planes !== 1) return refusal('bmp_planes_unsupported', 'BMP planes must be 1; this capture reports ' + planes + '.');
  if (compression !== 0) return refusal('bmp_compression_unsupported', 'Only uncompressed BI_RGB is decoded; this capture reports compression ' + compression + '.');
  if (bitCount !== 24 && bitCount !== 32) return refusal('bmp_depth_unsupported', 'Only 24-bit and 32-bit BMP pixels are decoded; this capture reports ' + bitCount + '.');
  if (width <= 0 || rawHeight === 0) return refusal('bmp_dimensions_invalid', 'The BMP reports ' + width + 'x' + rawHeight + '.');
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const bytesPerPixel = bitCount / 8;
  const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
  const needed = pixelOffset + stride * height;
  if (buffer.length < needed) {
    return refusal('bmp_truncated', 'The BMP needs ' + needed + ' bytes for ' + width + 'x' + height + ' at ' + bitCount + '-bit; the capture is ' + buffer.length + '.');
  }
  const rgb = Buffer.alloc(width * height * 3);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = topDown ? row : height - 1 - row;
    const sourceStart = pixelOffset + sourceRow * stride;
    for (let x = 0; x < width; x += 1) {
      const at = sourceStart + x * bytesPerPixel;
      const to = (row * width + x) * 3;
      rgb[to] = buffer[at + 2];
      rgb[to + 1] = buffer[at + 1];
      rgb[to + 2] = buffer[at];
    }
  }
  return { ok: true, width, height, rgb, bitCount, topDown, stride };
}

/** Wrap top-down RGB rows in a PNG container: 8-bit truecolour, one filter-0 byte per row. */
export function encodePng({ width, height, rgb }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace
  const rowLength = width * 3;
  const raw = Buffer.alloc((rowLength + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (rowLength + 1)] = 0;
    rgb.copy(raw, row * (rowLength + 1) + 1, row * rowLength, row * rowLength + rowLength);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * BMP bytes in, PNG bytes out.
 *
 * The width/height on success are the source dimensions, so a caller that already said what it
 * captured can check the conversion kept it.
 */
export function bmpToPng(buffer) {
  const decoded = decodeBmp(buffer);
  if (decoded.ok !== true) return decoded;
  const png = encodePng(decoded);
  return { ok: true, png, width: decoded.width, height: decoded.height, source_bit_count: decoded.bitCount, source_top_down: decoded.topDown };
}

/**
 * Convert the capture at sourcePath into targetPath and answer the file facts a receipt carries.
 * The write is a rename over the target, so a reader never sees a half-written PNG.
 */
export function convertCaptureFile({ sourcePath, targetPath }) {
  let source;
  try {
    source = fs.readFileSync(sourcePath);
  } catch (error) {
    return refusal('capture_unreadable', 'Cannot read the capture at ' + sourcePath + ': ' + (error.code || error.message));
  }
  const converted = bmpToPng(source);
  if (converted.ok !== true) return converted;
  try {
    const temporary = targetPath + '.tmp';
    fs.writeFileSync(temporary, converted.png);
    fs.renameSync(temporary, targetPath);
  } catch (error) {
    return refusal('png_write_failed', 'Cannot write ' + targetPath + ': ' + (error.code || error.message));
  }
  return {
    ok: true,
    path: targetPath,
    width: converted.width,
    height: converted.height,
    bytes: converted.png.length,
    sha256: crypto.createHash('sha256').update(converted.png).digest('hex'),
    source_bytes: source.length,
    source_sha256: crypto.createHash('sha256').update(source).digest('hex'),
  };
}
