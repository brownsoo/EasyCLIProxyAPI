import { useSyncExternalStore } from 'react';
import { isOAuthCredentialFile, parseAuthFilePriority } from './authFiles';
import { managementApi, readBoolean, readNumber, readString } from './managementApi';
import type { AuthFile, QuotaState } from './quotaService';

const STORAGE_KEY = 'easy-cli-proxy-api.quota-auto-balance';

let cachedEnabled: boolean | undefined;
const listeners = new Set<() => void>();

function readStoredEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function getQuotaAutoBalanceEnabled(): boolean {
  if (cachedEnabled === undefined) {
    cachedEnabled = readStoredEnabled();
  }
  return cachedEnabled;
}

export function setQuotaAutoBalanceEnabled(enabled: boolean): void {
  const next = Boolean(enabled);
  const changed = getQuotaAutoBalanceEnabled() !== next;
  cachedEnabled = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch {
    // Ignore storage errors in restricted environments.
  }
  if (changed) {
    listeners.forEach((listener) => listener());
  }
}

function subscribeQuotaAutoBalance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useQuotaAutoBalance(): [boolean, (enabled: boolean) => void] {
  const enabled = useSyncExternalStore(
    subscribeQuotaAutoBalance,
    getQuotaAutoBalanceEnabled,
    getQuotaAutoBalanceEnabled,
  );
  return [enabled, setQuotaAutoBalanceEnabled];
}

export type QuotaRoutingTarget = {
  priority: number;
  weight: number;
  bottleneckPercent: number;
  averagePercent: number;
};

/**
 * Compute recommended priority and weight from a fetched QuotaState.
 * Returns null if the quota is not successful or contains no numeric percentage rows.
 */
export function computeQuotaRoutingTarget(quota: QuotaState): QuotaRoutingTarget | null {
  if (quota.status !== 'success' || !Array.isArray(quota.rows) || quota.rows.length === 0) {
    return null;
  }
  const percents = quota.rows
    .map((row) => row.remainingPercent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .map((value) => Math.max(0, Math.min(100, value)));

  if (percents.length === 0) {
    return null;
  }

  const bottleneckPercent = Math.min(...percents);
  const sum = percents.reduce((acc, value) => acc + value, 0);
  const averagePercent = sum / percents.length;

  let priority: number;
  let weight: number;

  if (bottleneckPercent < 5) {
    priority = 1;
    weight = 1;
  } else if (bottleneckPercent < 15) {
    priority = 5;
    weight = Math.max(1, Math.round(bottleneckPercent));
  } else {
    priority = 10;
    const effective = bottleneckPercent * 0.7 + averagePercent * 0.3;
    weight = Math.max(1, Math.round(effective));
  }

  return {
    priority,
    weight,
    bottleneckPercent,
    averagePercent,
  };
}

type BalanceApi = {
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Apply computed routing priority and weight to an OAuth credential file if changed.
 */
export async function syncCredentialQuotaRouting(
  file: AuthFile,
  quota: QuotaState,
  api: BalanceApi = managementApi,
): Promise<QuotaRoutingTarget | null> {
  if (!isOAuthCredentialFile(file) || readBoolean(file, 'disabled')) {
    return null;
  }
  const name = readString(file, 'name');
  if (!name) return null;

  const target = computeQuotaRoutingTarget(quota);
  if (!target) return null;

  const currentPriority = parseAuthFilePriority(file.priority);
  const currentWeight = readNumber(file, 'weight');

  if (currentPriority === target.priority && currentWeight === target.weight) {
    return target;
  }

  await api.patch('/credentials/fields', {
    name,
    priority: target.priority,
    weight: target.weight,
  });

  file.priority = target.priority;
  file.weight = target.weight;
  return target;
}
