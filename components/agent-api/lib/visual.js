import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deflateSync } from 'node:zlib';

const MAX_BYTES = 8 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
export async function requireVision(view, selection) {
  if (!view.attachments?.saveImages) throw fail('visual_store_unavailable', 'DSH attachment store is unavailable');
  const models = typeof view.llm.resolveModelInfo==='function'?[await view.llm.resolveModelInfo(selection.provider,selection.model)]:await view.llm.listModels(selection.provider);
  const model = Array.isArray(models) ? models.find(m => m?.provider === selection.provider && m?.id === selection.model) : undefined;
  if (!model?.inputModalities?.includes('image')) throw fail('visual_model_unavailable', 'The authorised model has no verified image input capability');
}
export async function admitImages(images, view, selection, signal) {
  if (!Array.isArray(images) || images.length > 4) throw fail('invalid_images', 'images must be an array of at most four uploads');
  if (!images.length) return [];
  await requireVision(view, selection);
  let bytes = 0;
  const inputs = images.map(image => {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image?.mediaType) ||
      typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)) throw fail('invalid_images', 'Unsupported media type or invalid canonical base64');
    const data = Buffer.from(image.data, 'base64');
    bytes += data.length;
    if (!data.length || bytes > MAX_BYTES) throw fail('invalid_images', 'Image batch exceeds 8 MiB or is empty');
    return { data, mediaType: image.mediaType };
  });
  signal?.throwIfAborted();
  const refs = await view.attachments.saveImages(inputs);
  signal?.throwIfAborted();
  return refs.map(attachment => ({ type: 'image', attachment }));
}

// Hidden Win32 captures are uncompressed BMP; encode their pixels as PNG without
// adding an image library or mislabelling BMP bytes as an accepted image type.
function crc32(data) {
  let crc = -1;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ -1) >>> 0;
}
export function bmpToPng(data) {
  if (data.length < 54 || data.toString('ascii', 0, 2) !== 'BM') throw fail('invalid_capture', 'Malformed BMP');
  const offset = data.readUInt32LE(10), header = data.readUInt32LE(14);
  const width = data.readInt32LE(18), heightSigned = data.readInt32LE(22), height = Math.abs(heightSigned);
  const bits = data.readUInt16LE(28), stride = Math.ceil(width * bits / 32) * 4;
  if (header < 40 || width <= 0 || height <= 0 || width * height > 16_777_216 ||
      ![24, 32].includes(bits) || data.readUInt32LE(30) !== 0 || offset < 14 + header || offset + stride * height > data.length) throw fail('invalid_capture', 'Unsupported BMP geometry or encoding');
  const pixels = Buffer.alloc((1 + width * 3) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const src = offset + (heightSigned > 0 ? height - y - 1 : y) * stride + x * bits / 8;
    const dst = y * (1 + width * 3) + 1 + x * 3;
    pixels[dst] = data[src + 2]; pixels[dst + 1] = data[src + 1]; pixels[dst + 2] = data[src];
  }
  const chunk = (type, payload) => { const body = Buffer.concat([Buffer.from(type), payload]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(payload.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4); return out; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
export async function visualToolContent(name, result, view, selection, signal) {
  const text = { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) };
  if (!['computer_use', 'screen_capture'].includes(name) || !result?.image_path || result.must_reacquire_full_observation === true) return [text];
  await requireVision(view, selection);
  const captureRoot = await fs.realpath(path.join(os.tmpdir(), 'newmark2dsh-computer-use'));
  const target = await fs.realpath(result.image_path);
  const relative = path.relative(captureRoot, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fail('invalid_capture', 'Capture escapes the ComputerUse image directory');
  const stat = await fs.stat(target);
  if (!stat.isFile() || stat.size > MAX_BYTES || Date.now() - stat.mtimeMs > 60_000) throw fail('stale_capture', 'Capture is stale, oversized, or not a regular file');
  signal?.throwIfAborted();
  let data = await fs.readFile(target);
  let mediaType = result.image_mime || 'image/png';
  if (data.toString('ascii', 0, 2) === 'BM') { data = bmpToPng(data); mediaType = 'image/png'; }
  const images = await admitImages([{ data: data.toString('base64'), mediaType }], view, selection, signal);
  return [text, ...images];
}
