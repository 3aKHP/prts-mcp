/**
 * Shared codepoint-order string comparison for user-visible id listings.
 * No Python counterpart: Python's `sorted()` already compares codepoints.
 *
 * `localeCompare` follows ICU collation, which orders punctuation after
 * alphanumerics and folds uppercase ids after lowercase ones — both invert
 * against the Python backend (e.g. `1+.png` vs `1.png`, or the
 * sortId-tie item ids like `AP_GAMEPLAY` vs `ap_item_*`). Plain relational
 * comparison compares UTF-16 code units, equal to codepoint order for the
 * BMP identifiers these listings use.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
