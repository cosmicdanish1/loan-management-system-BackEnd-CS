/** JSON.stringify that never throws — circular refs / BigInt / driver objects
 *  fall back to a String() coercion instead of crashing the logging path. */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    try {
      return String(value);
    } catch {
      return '"[unserializable]"';
    }
  }
}
