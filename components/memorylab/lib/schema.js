/**
 * Schemastery, resolved from the harness that is running this bundle.
 *
 * A bundle installed into a profile sits outside the harness's dependency tree, so
 * `import '@deepseek-ai/schemastery'` cannot resolve from here. This anchors
 * `createRequire` on paths taken from the live process — the harness's own entry and
 * the `resources/app` directory beside the executable — and tries each in turn.
 * `NEWMARK_CORE_SCHEMA_LIB` exists so a gate can exercise this exact code path
 * outside the app; it is unset in normal operation.
 *
 * Every row that declares a `Config` exports this same instance, so the Loader sees
 * one schema library for the whole bundle.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function loadSchemaLibrary() {
  const anchors = [];
  if (process.env.NEWMARK_CORE_SCHEMA_LIB) {
    anchors.push(pathToFileURL(process.env.NEWMARK_CORE_SCHEMA_LIB).href);
  }
  anchors.push(import.meta.url);
  if (process.argv[1]) anchors.push(pathToFileURL(process.argv[1]).href);
  if (process.execPath) {
    const executableDir = path.dirname(process.execPath);
    anchors.push(path.join(executableDir, 'resources', 'app', 'package.json'));
    anchors.push(path.join(executableDir, 'package.json'));
  }
  for (const anchor of anchors) {
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery');
      const library = loaded && loaded.default ? loaded.default : loaded;
      if (library && typeof library.object === 'function') return library;
    } catch {
      // Try the next anchor.
    }
  }
  return null;
}

/**
 * `null` when nothing resolves. A row then exports no schema, which is exactly how
 * this bundle behaved before schemas existed, so an unanticipated harness layout
 * degrades to "config passed through unvalidated" rather than failing to load.
 */
export const schema = loadSchemaLibrary();
