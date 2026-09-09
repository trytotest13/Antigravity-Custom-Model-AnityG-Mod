import { describe, it, expect } from 'vitest';
import { shouldSwitch, HealthMonitor } from '../proxy/smartHealth';

describe('shouldSwitch', () => {
  it('fails fast on client errors', () => {
    expect(shouldSwitch(400).switch).toBe(false);
  });
  it('switches on auth/model-not-found without same-model retry', () => {
    expect(shouldSwitch(401)).toMatchObject({ switch: true, retrySame: false });
    expect(shouldSwitch(404)).toMatchObject({ switch: true, retrySame: false });
  });
  it('retries same model on 429/5xx', () => {
    expect(shouldSwitch(429)).toMatchObject({ switch: true, retrySame: true });
    expect(shouldSwitch(503)).toMatchObject({ switch: true, retrySame: true });
  });
  it('switches on network errors', () => {
    expect(shouldSwitch(undefined, new Error('econnrefused')).switch).toBe(true);
  });
});

describe('HealthMonitor', () => {
  it('opens breaker after 3 failures and penalizes sick models', () => {
    const h = new HealthMonitor();
    h.reportFailure('m');
    h.reportFailure('m');
    expect(h.penalty('m')).toBeGreaterThan(0);
    expect(h.isOpen('m')).toBe(false);
    h.reportFailure('m');
    expect(h.isOpen('m')).toBe(true);
    h.reportSuccess('m', 100);
    expect(h.isOpen('m')).toBe(false);
  });
});
