/**
 * Serialize a value for a `<script>` body without letting it break out.
 *
 * A re-export, not a copy, for the same reason `root.js` and `schema.js` here are: the
 * escaping rule exists once, at the root of this bundle, and every row that publishes a page
 * global has to escape the same three sequences. A second copy is a second thing to fix.
 */
export * from '../../../lib/embed.js';
