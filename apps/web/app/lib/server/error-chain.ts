/** `error` and every `cause` under it, outermost first, each link once. */
export function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  while (current !== undefined && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}
