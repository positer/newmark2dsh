/**
 * Schemastery, resolved from the harness that is running this bundle.
 *
 * This is a re-export, not a copy, and that is a deliberate departure from the two
 * components that shipped before this one. Those carry a verbatim copy of the loader
 * below, so the resolution rule exists in three places; here it exists in one. The
 * loader anchors `createRequire` on paths taken from the live process, so re-exporting
 * keeps exactly the same anchors — `import.meta.url` still points inside this package,
 * and the `resources/app` anchor still comes from `process.execPath`.
 *
 * Nothing else belongs in this file.
 */
export * from '../../../lib/schema.js';
