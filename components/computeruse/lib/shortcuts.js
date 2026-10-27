/**
 * The shortcut whitelist the user asked for, and the one place it is written down.
 *
 * The user supplied a picture of a shortcut card and asked for that set to be available to the
 * Computer Use tool, plus Ctrl+Space for switching input methods. A list that only lives in a
 * screenshot is not a contract, so it lives here: the tool description quotes it, the
 * read-only `shortcuts` action returns it, and verify-cu-shortcuts.mjs proves every chord in
 * it actually resolves through the same parser the desktop delivery uses.
 *
 * NOT every chord is a "supported feature of Windows" in every app: these are chords the
 * companion is allowed to reach for. A chord outside the list is still delivered if the model
 * names it; the list is the curated set, not a sandbox.
 */
export const CU_SHORTCUTS = Object.freeze([
  { chord: 'esc', label: 'Esc', note: '关闭浮层/取消' },
  { chord: 'ctrl+c', label: 'Ctrl+C', note: '复制' },
  { chord: 'ctrl+x', label: 'Ctrl+X', note: '剪切' },
  { chord: 'ctrl+v', label: 'Ctrl+V', note: '粘贴' },
  { chord: 'ctrl+a', label: 'Ctrl+A', note: '全选' },
  { chord: 'ctrl+z', label: 'Ctrl+Z', note: '撤销' },
  { chord: 'ctrl+s', label: 'Ctrl+S', note: '保存' },
  // Measured 2026-10-27: real-mode delivery answers key_unsupported for this one, because
  // SendKeys cannot express a chord made only of modifiers and the real path routes through it.
  // The note says so instead of implying every chord works in every mode.
  { chord: 'ctrl+shift', label: 'Ctrl+Shift', note: '切换输入法（部分输入法）；真实模式暂不支持，见 ctrl+space' },
  { chord: 'ctrl+f', label: 'Ctrl+F', note: '搜索' },
  { chord: 'win+up', label: 'Win+↑', note: '最大化当前窗口' },
  { chord: 'win+down', label: 'Win+↓', note: '最小化当前窗口' },
  { chord: 'alt+f4', label: 'Alt+F4', note: '关闭窗口' },
  { chord: 'win+d', label: 'Win+D', note: '显示/隐藏桌面' },
  { chord: 'alt+tab', label: 'Alt+Tab', note: '切换应用' },
  { chord: 'ctrl+alt+del', label: 'Ctrl+Alt+Del', note: '安全界面/启动项' },
  { chord: 'ctrl+shift+esc', label: 'Ctrl+Shift+Esc', note: '任务管理器' },
  { chord: 'win+e', label: 'Win+E', note: '资源管理器' },
  { chord: 'win+tab', label: 'Win+Tab', note: '任务视图' },
  { chord: 'win+r', label: 'Win+R', note: '运行' },
  { chord: 'ctrl+plus', label: 'Ctrl++', note: '放大' },
  { chord: 'ctrl+minus', label: 'Ctrl+-', note: '缩小' },
  { chord: 'win+i', label: 'Win+I', note: '打开系统设置' },
  { chord: 'ctrl+up', label: 'Ctrl+↑', note: '跳到上一个' },
  { chord: 'ctrl+down', label: 'Ctrl+↓', note: '跳到下一个' },
  { chord: 'ctrl+tab', label: 'Ctrl+Tab', note: '切换窗口/标签' },
  { chord: 'printscreen', label: 'Print Screen', note: '截屏' },
  { chord: 'delete', label: 'Delete', note: '删除' },
  { chord: 'shift+delete', label: 'Shift+Delete', note: '彻底删除' },
  { chord: 'ctrl+n', label: 'Ctrl+N', note: '新建' },
  { chord: 'ctrl+w', label: 'Ctrl+W', note: '关闭窗口或标签' },
  { chord: 'ctrl+space', label: 'Ctrl+Space', note: '切换输入法（中/英）' },
]);

/** The whitelist as the tool description quotes it: two chords per line, compact. */
export function shortcutTable() {
  const parts = CU_SHORTCUTS.map((entry) => `${entry.chord} (${entry.note})`);
  const lines = [];
  for (let index = 0; index < parts.length; index += 4) lines.push(parts.slice(index, index + 4).join(' · '));
  return lines.join('\n');
}

/** Normalise a chord for comparison: lower case, trimmed, single spaces. */
export function normaliseChord(value) {
  return String(value === null || value === undefined ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
}

/**
 * Whether a chord is on the list. Used by the gate and by anything that wants to tell a
 * caller "this is one of the supported ones" without pretending other chords are refused.
 */
export function isWhitelisted(value) {
  const wanted = normaliseChord(value);
  return CU_SHORTCUTS.some((entry) => normaliseChord(entry.chord) === wanted);
}
