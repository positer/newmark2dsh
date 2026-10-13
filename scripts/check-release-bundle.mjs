// Replicate the workflow's "The bundle must be self-contained" step locally, so a broken
// guard is found here rather than in a failed release.
import fs from 'node:fs';
import path from 'node:path';

const repo = process.argv[2];
let fail = 0;
const bad = (msg) => {
  console.error(`  FAIL ${msg}`);
  fail = 1;
};

const index = fs.readFileSync(path.join(repo, 'index.js'), 'utf8');
const root = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const patch = fs.readFileSync(path.join(repo, 'cordis.patch.yml'), 'utf8');

for (const component of ['memorylab', 'computeruse', 'agent-api', 'newmate', 'heartbeat']) {
  const manifestPath = path.join(repo, 'components', component, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    bad(`missing components/${component}/package.json`);
    continue;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.dsh?.client !== undefined) bad(`${component} declares dsh.client`);
  if (!index.includes(`./components/${component}/index.js`)) bad(`${component} is not composed by the core row`);
  console.log(`  ok   ${component}`);
}

const deps = Object.keys(root.dependencies || {});
if (deps.length > 0) bad(`the bundle declares dependencies: ${deps.join(', ')}`);
if (JSON.stringify(root).includes('file:')) bad('a file: specifier is still present');
// Match a row declaration, not any occurrence of the string. The workflow's guard had this
// bug and reported a failure that was only a sentence in the patch header; this local mirror
// kept it and did exactly the same. A guard has to match structure.
const lines = patch.split('\n');
const rows = lines.filter((line) => line.startsWith('    - id: ')).map((line) => line.slice(10).trim());
if (rows.length !== 3 || rows[0] !== 'newmark-core' || rows[1] !== 'preset-dev' || rows[2] !== 'preset-rdev') {
  bad(`the patch must declare exactly the core row and the two preset rows, found: ${rows.join(', ')}`);
}
for (const name of ['newmark2dsh-memorylab', 'newmark2dsh-computeruse', 'newmark2dsh-agent-api']) {
  if (lines.some((line) => line.trim() === `name: '${name}'`)) bad(`the patch declares a row for ${name}`);
}
console.log(`  ok   no dependencies, no file: specifier, and exactly ${rows.length} rows: ${rows.join(', ')}`);

for (const file of [
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'lib/model-selection.js',
  'components/memorylab/lib/memory-store.js',
  'components/computeruse/lib/win32.js',
  'components/computeruse/lib/overlay-win32.js',
  'components/newmate/index.js',
  'components/newmate/component.js',
  'components/heartbeat/index.js',
  'components/heartbeat/component.js',
  'lib/durable-state.js',
  'lib/conversation-delivery.js',
  'components/agent-api/lib/visual.js',
  'components/newmate/lib/memory-context.js',
  'components/newmate/lib/mcp.js',
  'components/memorylab/lib/short-memory.js',
  'lib/newmate-context.js',
  'components/agent-api/index.js',
  'components/agent-api/component.js',
  'components/agent-api/lib/loop.js',
  'components/agent-api/lib/core-model.js',
]) {
  if (!fs.existsSync(path.join(repo, file))) bad(`missing ${file}`);
}
console.log('  ok   the required files exist');

console.log(fail === 0 ? 'GUARD PASSES' : 'GUARD FAILS');
process.exit(fail);
