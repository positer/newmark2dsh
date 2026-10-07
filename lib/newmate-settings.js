import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const newMateSettingsPath = root => path.join(root, 'computer-use', 'desktop-pet.json');
export function readNewMateSettings(root) {
  try {
    const saved = JSON.parse(fs.readFileSync(newMateSettingsPath(root), 'utf8'));
    let value = saved.size_multiplier;
    if (!Number.isFinite(value)) throw Error('Invalid saved NewMate size');
    if (saved.version !== 2) {
      if (value < .5 || value > 2) throw Error('Invalid legacy NewMate size');
      value /= .75;
    }
    if (value < .3 || value > 3) throw Error('Invalid saved NewMate size');
    return { ok: true, sizeMultiplier: value, min: .3, max: 3, default: 1 };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, sizeMultiplier: 1, min: .3, max: 3, default: 1 };
    return { ok: false, sizeMultiplier: 1, error: error.message };
  }
}
export function writeNewMateSettings(root, value) {
  if (!Number.isFinite(value) || value < .3 || value > 3) throw Error('NewMate size must be between 30% and 300%');
  const target = newMateSettingsPath(root), temporary = target + '.' + crypto.randomUUID() + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 2, size_multiplier: value, updated_at: new Date().toISOString() }));
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  return readNewMateSettings(root);
}
