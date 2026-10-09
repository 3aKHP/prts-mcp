/**
 * Shared numeric rounding semantics for cross-implementation parity.
 * Mirrors python/src/prts_mcp/utils/numbers.py.
 */

/**
 * Round midpoints away from zero (.NET numeric format semantics).
 *
 * `Math.round` / Python's `round` differ across the two runtimes (half-up
 * vs banker's), so both sides share this explicit formula instead. A zero
 * result is normalized to +0 so formatting never emits "-0" / "-0%"
 * (Python copysign would preserve the sign where ECMAScript drops it).
 */
export function roundHalfAway(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  const rounded = Math.floor(Math.abs(value) * factor + 0.5) / factor;
  return rounded === 0 ? 0 : Math.sign(value) * rounded;
}
