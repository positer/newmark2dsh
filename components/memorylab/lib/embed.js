/**
 * Serialize a value for a `<script>` body without letting it break out.
 *
 * Shared by every row: each publishes its own page global, and each has to escape
 * the same three sequences. `<` stops a value from closing the script element, and
 * U+2028 / U+2029 are line terminators in JavaScript but not in JSON, so an
 * unescaped one would end the statement early.
 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
