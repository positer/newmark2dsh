/**
 * The shared Newmark root — re-exported from the core, deliberately not restated.
 *
 * The rule lives in `lib/root.js` at the root of this bundle and exists once. A copy
 * here would mean every change to how the root is resolved had to be made in the core
 * AND in each component, and a component that was missed would quietly read a different
 * store than the core row did. Re-exporting makes that impossible rather than merely
 * unlikely.
 *
 * Nothing else should be added to this file: anything with behaviour in it would be a
 * second implementation again, which is the thing this replaced.
 */
export * from '../../../lib/root.js';
