import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Reload before each mutation: component disposal/reload must not overwrite newer state.
export function durableState(file, initial) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return structuredClone(initial); }
  };
  return { read, change(update) {
    const state = read(); update(state);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { flag: 'wx' });
    const fd = fs.openSync(temporary, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
    return state;
  } };
}
