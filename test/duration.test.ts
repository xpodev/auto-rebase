import { describe, it, expect } from 'vitest';
import { parseDuration } from '../src/duration';

describe('parseDuration', () => {
  it('parses single-unit durations', () => {
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('16h')).toBe(57_600_000);
    expect(parseDuration('40d')).toBe(40 * 86_400_000);
  });

  it('parses combined durations and trims whitespace', () => {
    expect(parseDuration(' 1h30m ')).toBe(5_400_000);
    expect(parseDuration('1d12h')).toBe(129_600_000);
  });

  it('rejects malformed or zero durations', () => {
    for (const bad of ['', '10', 'm', '5x', '1.5h', '-1h', '5 m', 'h5']) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
    expect(() => parseDuration('0s')).toThrow(/greater than zero/);
  });
});
