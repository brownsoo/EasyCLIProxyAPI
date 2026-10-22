import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { managementApi } from '../src/services/managementApi';
import {
  computeQuotaRoutingTarget,
  getQuotaAutoBalanceEnabled,
  setQuotaAutoBalanceEnabled,
  syncCredentialQuotaRouting,
} from '../src/services/quotaAutoBalance';
import { commitFetchedQuota } from '../src/services/quotaEnrichment';
import { captureQuotaCacheGeneration, updateQuotaCache } from '../src/services/quotaCache';
import type { QuotaState } from '../src/services/quotaService';

describe('quotaAutoBalance', () => {
  let patchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    patchSpy?.mockRestore();
    setQuotaAutoBalanceEnabled(false);
    updateQuotaCache({});
  });

  it('computes priority and weight tiers based on bottleneck and average remaining quota', () => {
    const healthy: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 81 },
        { label: '7-day window', remainingPercent: 72 },
      ],
    };
    const healthyTarget = computeQuotaRoutingTarget(healthy);
    expect(healthyTarget).toEqual({
      priority: 10,
      weight: Math.round(72 * 0.7 + 76.5 * 0.3),
      bottleneckPercent: 72,
      averagePercent: 76.5,
    });

    const lowWarning: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 81 },
        { label: '7-day window', remainingPercent: 5 },
      ],
    };
    expect(computeQuotaRoutingTarget(lowWarning)).toEqual({
      priority: 5,
      weight: 5,
      bottleneckPercent: 5,
      averagePercent: 43,
    });

    const critical: QuotaState = {
      status: 'success',
      rows: [
        { label: '5-hour window', remainingPercent: 2 },
        { label: '7-day window', remainingPercent: 50 },
      ],
    };
    expect(computeQuotaRoutingTarget(critical)).toEqual({
      priority: 1,
      weight: 1,
      bottleneckPercent: 2,
      averagePercent: 26,
    });
  });

  it('patches credential priority and weight when auto-balance is enabled during commitFetchedQuota', async () => {
    patchSpy = spyOn(managementApi, 'patch').mockResolvedValue({ status: 'ok' } as never);
    setQuotaAutoBalanceEnabled(true);
    expect(getQuotaAutoBalanceEnabled()).toBe(true);

    const file: Record<string, unknown> = {
      name: 'claude-test.json',
      provider: 'claude',
      auth_index: 'idx-1',
      source: 'file',
      priority: 0,
    };
    const quota: QuotaState = {
      status: 'success',
      rows: [
        { label: '5h', remainingPercent: 70 },
        { label: '7d', remainingPercent: 70 },
      ],
    };

    commitFetchedQuota(captureQuotaCacheGeneration(), file, quota);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(patchSpy).toHaveBeenCalledTimes(1);
    expect(patchSpy).toHaveBeenCalledWith('/credentials/fields', {
      name: 'claude-test.json',
      priority: 10,
      weight: 70,
    });
    expect(file.priority).toBe(10);
    expect(file.weight).toBe(70);

    // Calling sync again with identical values skips redundant PATCH requests
    await syncCredentialQuotaRouting(file, quota);
    expect(patchSpy).toHaveBeenCalledTimes(1);
  });
});
