const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Parses durations like "1s", "5m", "16h", "40d", "500ms" or combinations like "1h30m".
export function parseDuration(input: string): number {
  const text = input.trim();
  if (!/^(\d+(ms|s|m|h|d))+$/.test(text)) {
    throw new Error(
      `invalid duration ${JSON.stringify(input)} (expected e.g. "30s", "5m", "16h", "40d", "1h30m")`
    );
  }
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d+)(ms|s|m|h|d)/g)) {
    total += Number(amount) * UNIT_MS[unit];
  }
  if (total <= 0) {
    throw new Error(`duration must be greater than zero, got ${JSON.stringify(input)}`);
  }
  return total;
}
