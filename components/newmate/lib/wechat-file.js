/**
 * What NewMate may send to WeChat, and why each refusal exists.
 *
 * This module is pure inspection: it reads the filesystem and answers, it never sends anything.
 * The channel does the sending. Keeping the two apart is what makes the refusals testable without
 * a network, and it is also what stops a "just send whatever the model named" shortcut from
 * appearing in the sending path.
 *
 * Three gates, in this order, because the order is the message the caller reads:
 *   1. the path must name an existing REGULAR file (a directory, a device or a link loop is refused
 *      as its own case rather than reported as "not found");
 *   2. it must not be one of the places a credential lives. A refusal here is deliberately not a
 *      warning: the caller asked to put a file on a phone, and no error text can un-send it;
 *   3. it must be under the size bound and not an executable/installer type.
 *
 * The size bound is OURS, not the server's. The official iLink client declares no limit anywhere
 * in its source (2.4.10), and the protocol sheet records none, so the number here is a guard: the
 * only documented file cap in our own evidence is WeCom's 20 MB webhook attachment limit
 * (docs/15-wechat-clawbot-research.md §3.1), and taking the smallest documented WeChat-side number
 * means we refuse a file rather than discover the real ceiling by having the upload fail halfway.
 * It is stated as a self-imposed bound everywhere it is reported.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Self-imposed ceiling; see the header. Exported so the tool description and the gate agree. */
export const WECHAT_FILE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Executables, installers and OS-level scripts.
 *
 * Not "anything a phone might not like": source files (.js, .py, .sh) are ordinary files that
 * nothing on the receiving side runs on open, and blocking them would make this tool useless for
 * the work it exists for. What is here is a type whose whole purpose is to execute or install the
 * moment someone taps it.
 */
export const WECHAT_FILE_BLOCKED_EXTENSIONS = Object.freeze([
  'exe', 'msi', 'msp', 'msix', 'appx', 'com', 'scr', 'pif', 'cpl', 'dll', 'sys', 'drv',
  'bat', 'cmd', 'vbs', 'vbe', 'hta', 'reg', 'lnk', 'url', 'ps1', 'psm1', 'wsf', 'wsh',
  'jar', 'apk', 'ipa',
]);

/**
 * Directories a credential lives in, beside the files that carry one directly.
 *
 * Compared against the REAL path (resolved first), so a symlink or a ~-relative alias cannot walk
 * around them. Home-relative entries are matched on the resolved absolute path.
 */
const HOME_DIRS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.dsh', '.Newmark', '.config/gcloud',
  'AppData/Roaming/Microsoft/Credentials', 'AppData/Local/Microsoft/Credentials',
  'AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data',
  'AppData/Roaming/Mozilla/Firefox/Profiles',
];

/** File names that ARE a credential, matched case-insensitively. */
const BLOCKED_NAMES = [
  'credentials', 'credentials.json', 'cookies', 'cookies.sqlite', 'login data', 'logins.json',
  'key3.db', 'key4.db', 'mcp-token', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'shadow',
];

/** Extensions that are a credential container rather than content. */
const BLOCKED_SECRET_EXTENSIONS = ['pem', 'key', 'pfx', 'p12', 'ppk'];

const normalize = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const homeDirs = () => {
  const home = normalize(process.env.USERPROFILE || process.env.HOME || '');
  // The entry must be normalized too, not just the home: `normalize` lowercases, so appending
  // '.Newmark' or 'AppData/Local/Google/Chrome/User Data' raw produced a needle that could never
  // match the lowercased path it was compared against - six of the twelve entries were dead.
  return HOME_DIRS.map((entry) => (home ? normalize(home + '/' + entry) : ''));
};

function refusal(code, error, extra) {
  return { ok: false, code, error, ...extra };
}

/**
 * Resolve the path the caller named against the workspace the caller is standing in.
 *
 * Absolute wins. Relative resolves against `cwd` when the host gave us one (a DSH conversation
 * carries its session cwd); a caller whose reach has no conversation — a NewMate run, for example
 * — gets the plugin process's own directory, and the answer always echoes the absolute path that
 * was actually used, so nothing has to guess which one applied.
 */
export function resolveSendPath(input, cwd) {
  const named = typeof input === 'string' ? input.trim() : '';
  if (!named) return refusal('path_required', '需要 path：要发送文件的绝对路径，或相对于当前工作区的路径。');
  const base = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : process.cwd();
  return { ok: true, path: path.resolve(base, named), base };
}

/**
 * Inspect one candidate file. Returns `{ok:true, file}` or a refusal carrying a stable `code`.
 *
 * `file` is everything the sending path needs and nothing it should have to re-derive: the real
 * absolute path, the name to show in WeChat, and the plaintext byte count that `getuploadurl`
 * and the file item both report.
 */
export function inspectWechatFile({ path: input, cwd, maxBytes = WECHAT_FILE_MAX_BYTES } = {}) {
  const resolved = resolveSendPath(input, cwd);
  if (!resolved.ok) return resolved;
  const named = resolved.path;

  let stats;
  try {
    stats = fs.statSync(named);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return refusal('file_not_found', '文件不存在：' + named + '（相对路径按 ' + resolved.base + ' 解析）。', { path: named });
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      return refusal('file_unreadable', '没有权限读取该文件：' + named + '（' + error.code + '）。', { path: named });
    }
    return refusal('file_unreadable', '无法读取该文件：' + named + '（' + (error.code || error.message) + '）。', { path: named });
  }
  if (!stats.isFile()) {
    // A directory, a device or a socket is its own refusal: "not a regular file" tells the caller
    // what to fix, where "not found" would send it looking for a path that exists.
    return refusal('not_a_regular_file', '不是普通文件：' + named + '。只发送普通文件（不走目录、设备或链接）。', { path: named });
  }

  let real;
  try { real = fs.realpathSync(named); } catch { real = named; }
  const realNormalized = normalize(real);

  const blocked = homeDirs().find((dir) => dir && (realNormalized === dir || realNormalized.startsWith(dir + '/')));
  if (blocked) {
    return refusal('path_forbidden', '拒绝发送：该文件位于凭据目录内（' + blocked.replace(/^.*?([^/]+\/[^/]+)$/, '$1') + '），里面是密钥或登录状态，不能发到微信。', { path: named });
  }

  const fileName = path.basename(real);
  const lowerName = fileName.toLowerCase();
  const extension = path.extname(lowerName).replace(/^\./, '');
  // `.env` and `.env.local` are environment files; `.environment.md` is a document that merely
  // starts with those four letters and must not be refused for it.
  if (BLOCKED_NAMES.includes(lowerName) || lowerName === '.env' || lowerName.startsWith('.env.')) {
    return refusal('path_forbidden', '拒绝发送：' + fileName + ' 是凭据/环境变量文件，不能发到微信。', { path: named });
  }
  if (BLOCKED_SECRET_EXTENSIONS.includes(extension)) {
    return refusal('path_forbidden', '拒绝发送：.' + extension + ' 是密钥/证书文件，不能发到微信。', { path: named });
  }
  if (WECHAT_FILE_BLOCKED_EXTENSIONS.includes(extension)) {
    return refusal('file_type_rejected', '拒绝发送：.' + extension + ' 是可执行/安装类型，微信侧不能作为附件投递这种文件。允许发送文档、图片、压缩包、源码等普通文件。', { path: named, extension });
  }

  if (stats.size > maxBytes) {
    return refusal('file_too_large', '文件过大：' + stats.size + ' 字节，上限 ' + maxBytes + ' 字节（' + Math.round(maxBytes / 1024 / 1024) + ' MB，本工具自设的保护值，不是协议声明的服务端上限）。', { path: named, bytes: stats.size, limitBytes: maxBytes });
  }
  if (stats.size === 0) {
    return refusal('file_empty', '文件是空的（0 字节）：' + fileName + '，微信侧不值得发一个空文件。', { path: named });
  }

  return { ok: true, file: { path: real, namedPath: named, fileName, bytes: stats.size, extension } };
}
