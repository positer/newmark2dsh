/**
 * Where a file the USER handed NewMate lives, and what may be quoted out of it.
 *
 * Two entrances share this one store, because they are the same act from two places:
 *   the page  - POST /newmark-newmate/upload carries the bytes and the name;
 *   WeChat    - the ClawBot channel downloads and decrypts a media item the user sent.
 * Both end in saveUpload(), both are announced to chat() as an ATTACHMENT list, and both are read
 * back the same way. A second mechanism would mean a second set of bounds and a second place for
 * them to drift.
 *
 * What this module is NOT: it never parses a document, never renders an image and never executes
 * anything. It stores bytes, tells the caller what kind of thing they are, and can quote a
 * bounded, honest excerpt of a TEXT file. A PDF, an Office file or a photo is stored and named
 * with its kind and its byte count, and the model is told plainly that the content was not read -
 * claiming otherwise would be the one unforgivable failure here.
 *
 * The size bound is OURS. The iLink protocol declares no attachment limit anywhere in its source
 * (2.4.10), and the WeChat client media path allows far more than a prompt can carry; 20 MiB is
 * the same self-imposed number the outbound path uses, so one number is quoted in both directions
 * instead of two that disagree.
 *
 * Every file lives in its own directory under <root>/newMate/uploads/<uploadId>/<name>:
 *   - the id lets two files of the same name coexist without a rename race;
 *   - containment is then a prefix test on the RESOLVED parent, so a crafted name or a symlink
 *     cannot make a read reach outside the store (sanitizeUploadName strips the path first, and
 *     resolveUploadPath still refuses what it did not store).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Self-imposed ceiling for one attachment, in either direction. See the header. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** How many attachments one message may carry. A prompt has to hold them all. */
export const UPLOAD_MAX_PER_MESSAGE = 8;
/** How many stored attachments are kept; older ones are pruned after a save. */
export const UPLOAD_MAX_KEPT = 200;
/** Longest stored file name, extension included. */
export const UPLOAD_MAX_NAME = 120;
/** How much of a text file one prompt may quote. */
export const UPLOAD_EXCERPT_CHARS = 4000;
/** How many bytes one newmate_file_read call may return. */
export const UPLOAD_READ_MAX_BYTES = 2 * 1024 * 1024;
/** Default and maximum line count of one newmate_file_read call. */
export const UPLOAD_READ_DEFAULT_LINES = 500;
export const UPLOAD_READ_MAX_LINES = 2000;

/**
 * Extensions this module will QUOTE. The list is deliberately a whitelist of formats whose bytes
 * are text in UTF-8: a wrong entry here shows the model mojibake, which is worse than saying
 * binary. Anything not listed is still stored and described, just never quoted.
 */
const TEXT_EXTENSIONS = Object.freeze([
  'txt', 'md', 'markdown', 'mdx', 'rst', 'org', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'xml', 'html', 'htm', 'css',
  'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte', 'py', 'rb', 'go', 'rs',
  'java', 'kt', 'kts', 'c', 'h', 'hpp', 'cc', 'cpp', 'cxx', 'cs', 'php', 'pl', 'lua', 'r', 'jl',
  'swift', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'sh', 'bash', 'zsh', 'fish', 'ps1',
  'bat', 'cmd', 'sql', 'tex', 'bib', 'sty', 'rkt', 'vim', 'gitignore', 'dockerfile', 'makefile',
  'gradle', 'srt', 'vtt', 'diff', 'patch', 'ipynb',
]);

const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'svg', 'ico', 'avif']);
const AUDIO_EXTENSIONS = Object.freeze(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr', 'silk', 'wma']);
const VIDEO_EXTENSIONS = Object.freeze(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', '3gp']);
const DOCUMENT_EXTENSIONS = Object.freeze(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key', 'epub', 'mobi']);
const ARCHIVE_EXTENSIONS = Object.freeze(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst']);

function refusal(code, error, extra) {
  return { ok: false, code, error, ...extra };
}

/** The store's root for one plugin data directory. */
export function uploadsRoot(root) {
  return path.join(root, 'newMate', 'uploads');
}

/** A byte count a person can read; only ever used inside messages. */
export function sizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' 字节';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * The name an attachment is stored and shown under.
 *
 * Never throws and never returns an empty string: the sender's name is a suggestion, and a name
 * that cannot be stored is replaced rather than failing the whole upload. Path separators are cut
 * at the LAST one (both kinds, because a Windows client may send either), control characters are
 * dropped, and a trailing dot or space is trimmed because Windows silently refuses those.
 */
export function sanitizeUploadName(name, fallback = 'file.bin') {
  const raw = typeof name === 'string' ? name : '';
  const afterSeparators = raw.split(/[\\/]/).pop() || '';
  let cleaned = afterSeparators
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length > UPLOAD_MAX_NAME) {
    const extension = path.extname(cleaned);
    const keep = Math.max(1, UPLOAD_MAX_NAME - extension.length);
    cleaned = cleaned.slice(0, keep) + extension;
  }
  return cleaned;
}

/** What kind of thing the bytes claim to be, from the extension. */
export function mediaKind(name) {
  const extension = path.extname(String(name || '')).replace(/^\./, '').toLowerCase();
  const bare = String(name || '').toLowerCase();
  if (!extension) {
    if (bare === 'dockerfile' || bare === 'makefile' || bare === '.gitignore') return 'text';
    return 'binary';
  }
  if (TEXT_EXTENSIONS.includes(extension)) return 'text';
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (AUDIO_EXTENSIONS.includes(extension)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (DOCUMENT_EXTENSIONS.includes(extension)) return 'document';
  if (ARCHIVE_EXTENSIONS.includes(extension)) return 'archive';
  return 'binary';
}

/**
 * Check one attachment before anything is written.
 *
 * Pure on purpose: the page route, the WeChat channel and the gate all ask the same question of
 * the same function, so a byte count cannot be accepted in one path and refused in another.
 */
export function inspectUpload({ name, bytes, maxBytes = UPLOAD_MAX_BYTES } = {}) {
  const fileName = sanitizeUploadName(name);
  const size = bytes === undefined || bytes === null ? 0 : Number(bytes);
  if (!Number.isFinite(size) || size < 0) return refusal('file_size_invalid', '文件大小无效。', { fileName });
  if (size === 0) return refusal('file_empty', '文件是空的（0 字节）：' + fileName + '，没有可读取的内容。', { fileName, bytes: 0 });
  if (size > maxBytes) {
    return refusal('file_too_large', '文件过大：' + sizeLabel(size) + '（' + size + ' 字节），上限 ' + sizeLabel(maxBytes) + '（' + maxBytes + ' 字节，本机自设的保护值，不是微信协议声明的上限）。', { fileName, bytes: size, limitBytes: maxBytes });
  }
  return { ok: true, fileName, bytes: size, kind: mediaKind(fileName) };
}

/** The directory one stored attachment lives in. */
export function uploadDirOf(root, id) {
  return path.join(uploadsRoot(root), String(id));
}

/**
 * Store one attachment.
 *
 * The bytes are written once, under the id directory, and the returned entry is what the durable
 * state keeps: name, kind, byte count, digest, when it arrived and where from. The path is
 * absolute because the model is given it verbatim; relative is what a page or a log can show
 * without leaking a home directory.
 */
export function saveUpload({ root, name, bytes, source = 'page', at = Date.now(), maxBytes = UPLOAD_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes)) return refusal('file_bytes_required', '内部错误：没有可保存的字节。');
  const inspected = inspectUpload({ name, bytes: bytes.length, maxBytes });
  if (!inspected.ok) return inspected;
  const id = crypto.randomUUID();
  const directory = uploadDirOf(root, id);
  const target = path.join(directory, inspected.fileName);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, bytes, { mode: 0o600 });
  } catch (error) {
    return refusal('file_write_failed', '把文件存到本机失败：' + (error.code || error.message), { fileName: inspected.fileName });
  }
  const entry = {
    id,
    name: inspected.fileName,
    bytes: bytes.length,
    kind: inspected.kind,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    at,
    source,
    path: path.resolve(target),
    relative: path.join('newMate', 'uploads', id, inspected.fileName),
  };
  pruneUploads({ root });
  return { ok: true, entry };
}

/**
 * Drop the oldest stored attachments beyond the retention count.
 *
 * Retention is a directory count, not a byte count: the byte bound is already per file, and a
 * second axis would make the answer to "why did my file disappear" two numbers instead of one.
 * Newest first is decided by mtime, so a save cannot delete what it just wrote.
 */
export function pruneUploads({ root, keep = UPLOAD_MAX_KEPT } = {}) {
  const base = uploadsRoot(root);
  let entries;
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return { removed: 0, kept: 0 };
    return { removed: 0, kept: 0, error: error.code };
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => {
    const full = path.join(base, entry.name);
    let at = 0;
    try { at = fs.statSync(full).mtimeMs; } catch { at = 0; }
    return { name: entry.name, at };
  }).sort((left, right) => right.at - left.at);
  const doomed = directories.slice(Math.max(0, Number(keep) || 0));
  let removed = 0;
  for (const item of doomed) {
    try { fs.rmSync(path.join(base, item.name), { recursive: true, force: true }); removed += 1; } catch { /* a locked old directory is not a reason to fail a save */ }
  }
  return { removed, kept: Math.min(directories.length, Math.max(0, Number(keep) || 0)) };
}

/**
 * Resolve a path a caller named back to a stored attachment, or refuse.
 *
 * newmate_attachment_read is the only reader, and this is its whole authority: the target must
 * exist, be a regular file, and its REAL path must be inside the directory this store created. A
 * path outside the store is refused even when it exists, which is what makes the tool
 * description - "only files the user handed NewMate" - true rather than aspirational.
 */
export function resolveUploadPath({ root, path: named } = {}) {
  const value = typeof named === 'string' ? named.trim() : '';
  if (!value) return refusal('path_required', '需要 path：要读取的附件路径。newmate_attachment_read 只能读用户交给 NewMate 的文件，路径在消息里给出。');
  const target = path.resolve(value);
  let real;
  try { real = fs.realpathSync(target); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return refusal('file_not_found', '文件不存在：' + target, { path: target });
    return refusal('file_unreadable', '无法读取该文件：' + target + '（' + (error.code || error.message) + '）', { path: target });
  }
  let realRoot;
  try { realRoot = fs.realpathSync(uploadsRoot(root)); } catch {
    return refusal('file_not_in_upload_store', '本机还没有任何附件：这个工具只读用户上传过的文件。', { path: target });
  }
  const inside = real === realRoot || real.startsWith(realRoot + path.sep);
  if (!inside) {
    return refusal('file_not_in_upload_store', '拒绝读取：' + real + ' 不是用户交给 NewMate 的文件。这个工具只能读上传目录里的内容。', { path: real });
  }
  let stats;
  try { stats = fs.statSync(real); } catch (error) {
    return refusal('file_unreadable', '无法读取该文件：' + real + '（' + (error.code || error.message) + '）', { path: real });
  }
  if (!stats.isFile()) return refusal('not_a_regular_file', '不是普通文件：' + real, { path: real });
  return { ok: true, path: real, bytes: stats.size, fileName: path.basename(real), kind: mediaKind(real) };
}

/**
 * Quote a bounded, line-numbered window of one stored attachment.
 *
 * The bounds are the point: limit lines and UPLOAD_READ_MAX_BYTES bytes, whichever comes first,
 * and the answer says which one stopped it. A caller that gets a short answer therefore knows it
 * is short instead of assuming it saw the file.
 */
export function readUploadContent({ root, path: named, offset = 1, limit = UPLOAD_READ_DEFAULT_LINES, maxBytes = UPLOAD_READ_MAX_BYTES } = {}) {
  const resolved = resolveUploadPath({ root, path: named });
  if (!resolved.ok) return resolved;
  const first = Number.isFinite(Number(offset)) ? Math.max(1, Math.trunc(Number(offset))) : 1;
  const count = Number.isFinite(Number(limit)) ? Math.min(UPLOAD_READ_MAX_LINES, Math.max(1, Math.trunc(Number(limit)))) : UPLOAD_READ_DEFAULT_LINES;
  const readBytes = Math.min(resolved.bytes, Math.max(1, Math.trunc(Number(maxBytes) || UPLOAD_READ_MAX_BYTES)));
  let buffer;
  try {
    const handle = fs.openSync(resolved.path, 'r');
    try {
      buffer = Buffer.alloc(readBytes);
      const read = fs.readSync(handle, buffer, 0, readBytes, 0);
      buffer = buffer.subarray(0, read);
    } finally { fs.closeSync(handle); }
  } catch (error) {
    return refusal('file_unreadable', '无法读取该文件：' + resolved.path + '（' + (error.code || error.message) + '）', { path: resolved.path });
  }
  if (buffer.includes(0)) {
    return refusal('file_not_text', resolved.fileName + ' 不是文本文件（含 0 字节），这个工具只读文本；它是 ' + resolved.kind + ' 类型，' + sizeLabel(resolved.bytes) + '。', { path: resolved.path, kind: resolved.kind });
  }
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  const sliced = lines.slice(first - 1, first - 1 + count);
  const moreBytes = buffer.length < resolved.bytes;
  const moreLines = first - 1 + sliced.length < lines.length;
  return {
    ok: true,
    path: resolved.path,
    fileName: resolved.fileName,
    bytes: resolved.bytes,
    text: sliced.join('\n'),
    offset: first,
    lines: sliced.length,
    truncatedBy: moreBytes && !moreLines ? 'bytes' : moreLines ? 'lines' : '',
    more: moreBytes || moreLines,
  };
}

/**
 * A bounded excerpt of a text attachment, for the prompt.
 *
 * Only UTF-8 text is quoted, and only up to maxChars. A binary, an image, a PDF or an Office file
 * answers ok:false with a legible reason: the prompt then names the file and says the content was
 * not read, which is the truth and lets the model ask the user instead of inventing a summary.
 */
export function textExcerpt({ path: target, maxChars = UPLOAD_EXCERPT_CHARS } = {}) {
  const limit = Math.max(0, Math.trunc(Number(maxChars) || 0));
  if (!limit) return { ok: false, reason: 'no_budget' };
  const kind = mediaKind(target);
  if (kind !== 'text') return { ok: false, reason: 'not_text', kind };
  let buffer;
  try {
    // Four bytes per character is the UTF-8 ceiling, so this never reads more than the excerpt
    // can possibly use, and a 20 MiB log does not become a 20 MiB string.
    const handle = fs.openSync(target, 'r');
    try {
      const size = fs.fstatSync(handle).size;
      buffer = Buffer.alloc(Math.min(size, limit * 4 + 4));
      const read = fs.readSync(handle, buffer, 0, buffer.length, 0);
      buffer = buffer.subarray(0, read);
    } finally { fs.closeSync(handle); }
  } catch (error) {
    return { ok: false, reason: 'unreadable', error: error.code || error.message };
  }
  if (buffer.includes(0)) return { ok: false, reason: 'not_text', kind };
  const whole = buffer.toString('utf8');
  if (whole.length <= limit) return { ok: true, text: whole, truncated: false };
  return { ok: true, text: whole.slice(0, limit), truncated: true };
}

/**
 * The attachment list as it is recorded in durable state.
 *
 * Only the fields a page needs to draw a chip and a reader needs to find the file: the absolute
 * path is kept because it is the handle every later step takes, and nothing derived from the
 * content is stored here - the digest is, because it is how a gate proves the bytes on disk are
 * the bytes that were announced.
 */
export function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  const normalized = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const target = typeof item.path === 'string' ? item.path : '';
    const name = typeof item.name === 'string' ? item.name : '';
    if (!id || !name || !path.isAbsolute(target)) {
      throw Error('附件记录无效：需要 id、name 与绝对 path');
    }
    normalized.push({
      id,
      name,
      path: path.resolve(target),
      bytes: Number(item.bytes) || 0,
      kind: typeof item.kind === 'string' ? item.kind : mediaKind(name),
      source: typeof item.source === 'string' ? item.source : 'page',
      at: Number(item.at) || 0,
      ...typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {},
    });
    if (normalized.length >= UPLOAD_MAX_PER_MESSAGE) break;
  }
  return normalized;
}

/**
 * The block one turn prompt carries for its attachments.
 *
 * It is written as facts and limits rather than as a request: the path, the byte count, the kind,
 * and - for text - a quoted excerpt whose budget is shared out so no single file can starve the
 * others. A non-text file says in so many words that the content was not read, because the model
 * is the one place an unread file could otherwise become an invented summary.
 */
export function attachmentBlock(attachments, { budgetChars = UPLOAD_EXCERPT_CHARS } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  if (!list.length) return '';
  const budget = Math.max(0, Math.trunc(Number(budgetChars) || 0));
  const share = list.length ? Math.floor(budget / list.length) : 0;
  const lines = ['用户随这条消息给了 ' + list.length + ' 个文件（已保存在本机，路径真实存在，不是你编造的）：'];
  list.forEach((item, index) => {
    const name = String(item && item.name || 'file');
    const kind = String(item && item.kind || mediaKind(name));
    const bytes = Number(item && item.bytes) || 0;
    lines.push((index + 1) + '. ' + name + ' — ' + kind + '，' + sizeLabel(bytes) + '（' + bytes + ' 字节）');
    lines.push('   路径：' + String(item && item.path || ''));
    if (kind === 'text' && share <= 0) {
      lines.push('   内容未引用（本条消息的字符预算不足）；需要内容时用 newmate_attachment_read 读取上面的路径。');
    } else if (kind === 'text') {
      const excerpt = textExcerpt({ path: item.path, maxChars: share });
      if (excerpt.ok) {
        lines.push('   内容' + (excerpt.truncated ? '（只引用前 ' + excerpt.text.length + ' 字，其余未提供）' : '（全文如下）') + '：');
        lines.push('   <<<');
        lines.push(excerpt.text.replace(/\r\n/g, '\n'));
        lines.push('   >>>');
        if (excerpt.truncated) lines.push('   需要更多内容时用 newmate_attachment_read 按行读取这个路径（offset/limit）。');
      } else {
        lines.push('   内容未读取（' + (excerpt.reason === 'not_text' ? '不是可解码的 UTF-8 文本' : '读取失败：' + (excerpt.error || excerpt.reason)) + '）。');
      }
    } else {
      lines.push('   内容未读取：这类文件（' + kind + '）本机不解析，只能按名称与字节数转述，不要假装看过里面写了什么；需要具体内容时请让用户说明，或把相关段落贴到对话里。');
    }
  });
  return lines.join('\n');
}
