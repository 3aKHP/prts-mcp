/**
 * Shared numeric rounding semantics for cross-implementation parity.
 * Mirrors python/src/prts_mcp/utils/numbers.py.
 */

/**
 * Round midpoints away from zero (.NET numeric format semantics).
 *
 * `Math.round` / Python's `round` differ across the two runtimes (half-up
 * vs banker's), so both sides share this explicit formula instead.
 */
export function roundHalfAway(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  const rounded = Math.floor(Math.abs(value) * factor + 0.5) / factor;
  return Math.sign(value) * rounded;
}
