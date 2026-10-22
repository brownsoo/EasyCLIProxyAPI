import { useSyncExternalStore } from 'react';
import { isOAuthCredentialFile, normalizeAuthFilePriorityInput } from './authFiles';
import { loadAuthFileSettings } from './authFileSettings';
import { managementApi, readBoolean, readString } from './managementApi';
import type { AuthFile, QuotaRow, QuotaState } from './quotaService';

const STORAGE_KEY = 'easy-cli-proxy-api.quota-auto-balance';
const ORIGINALS_STORAGE_KEY = 'easy-cli-proxy-api.quota-auto-balance.originals';

/**
 * Priorities are anchored to the backend default (0) so credentials auto-balance never
 * touched rank alongside healthy ones, and depleted credentials rank below both.
 */
export const AUTO_BALANCE_PRIORITY = { healthy: 0, low: -5, critical: -10 } as const;

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

export type QuotaRoutingFields = { priority: number; weight: number | null };
type RoutingChangeListener = (name: string, fields: QuotaRoutingFields) => void;
const routingChangeListeners = new Set<RoutingChangeListener>();

/** Notifies pages holding credential lists so they can update rows immutably after a PATCH. */
export function subscribeQuotaRoutingChanges(listener: RoutingChangeListener): () => void {
  routingChangeListeners.add(listener);
  return () => {
    routingChangeListeners.delete(listener);
  };
}

export function applyQuotaRoutingChange<T extends AuthFile>(files: T[], name: string, fields: QuotaRoutingFields): T[] {
  let changed = false;
  const next = files.map((file) => {
    if (readString(file, 'name') !== name) return file;
    changed = true;
    return { ...file, priority: fields.priority, weight: fields.weight };
  });
  return changed ? next : files;
}

/** Manual priority and weight (raw settings text) captured before auto-balance first changed them. */
type StoredOriginals = Record<string, { priority: string; weight: string }>;

function readOriginals(): StoredOriginals {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORIGINALS_STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as StoredOriginals : {};
  } catch {
    return {};
  }
}

function writeOriginals(originals: StoredOriginals): void {
  try {
    if (Object.keys(originals).length) localStorage.setItem(ORIGINALS_STORAGE_KEY, JSON.stringify(originals));
    else localStorage.removeItem(ORIGINALS_STORAGE_KEY);
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

export type QuotaRoutingTarget = {
  priority: number;
  weight: number;
  bottleneckPercent: number;
  averagePercent: number;
};

const clampedPercent = (row: QuotaRow): number | null =>
  typeof row.remainingPercent === 'number' && Number.isFinite(row.remainingPercent)
    ? Math.max(0, Math.min(100, row.remainingPercent))
    : null;

/**
 * Percentages that gate the whole credential. Account-wide windows (5-hour, weekly, ...) all apply,
 * so the tightest one wins. Model- or feature-scoped limits only block part of the traffic, so they
 * are ignored when account-wide windows exist; otherwise (e.g. Antigravity model groups) each group
 * is reduced to its tightest window and the best group represents the credential.
 */
function routingPercents(rows: QuotaRow[]): { bottleneck: number; values: number[] } | null {
  const account: number[] = [];
  const groups = new Map<string, number>();
  for (const row of rows) {
    const percent = clampedPercent(row);
    if (percent === null) continue;
    if (!row.scoped && !row.groupLabel) {
      account.push(percent);
      continue;
    }
    const group = row.groupLabel || row.label;
    groups.set(group, Math.min(groups.get(group) ?? 100, percent));
  }
  if (account.length) return { bottleneck: Math.min(...account), values: account };
  const values = [...groups.values()];
  return values.length ? { bottleneck: Math.max(...values), values } : null;
}

/**
 * Compute recommended priority and weight from a fetched QuotaState.
 * Returns null if the quota is not successful or contains no numeric percentage rows.
 */
export function computeQuotaRoutingTarget(quota: QuotaState): QuotaRoutingTarget | null {
  if (quota.status !== 'success' || !Array.isArray(quota.rows) || quota.rows.length === 0) {
    return null;
  }
  const percents = routingPercents(quota.rows);
  if (!percents) return null;

  const bottleneckPercent = percents.bottleneck;
  const averagePercent = percents.values.reduce((acc, value) => acc + value, 0) / percents.values.length;

  let priority: number;
  let weight: number;

  if (bottleneckPercent < 5) {
    priority = AUTO_BALANCE_PRIORITY.critical;
    weight = 1;
  } else if (bottleneckPercent < 15) {
    priority = AUTO_BALANCE_PRIORITY.low;
    weight = Math.max(1, Math.round(bottleneckPercent));
  } else {
    priority = AUTO_BALANCE_PRIORITY.healthy;
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
  get: (path: string, query: Record<string, string>) => Promise<unknown>;
  patch: (path: string, body: Record<string, unknown>) => Promise<unknown>;
};

const parseWeight = (text: string): number | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? Math.max(0, value) : null;
};

async function patchRouting(api: BalanceApi, name: string, fields: QuotaRoutingFields): Promise<void> {
  await api.patch('/credentials/fields', { name, ...fields });
  routingChangeListeners.forEach((listener) => listener(name, fields));
}

/**
 * Apply computed routing priority and weight to an OAuth credential file if changed.
 * The credential list does not carry weight, so current values are read from the stored file,
 * and the manual values are remembered the first time so they can be restored later.
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

  const current = await loadAuthFileSettings(name, api);
  const originals = readOriginals();
  if (!originals[name]) {
    writeOriginals({ ...originals, [name]: { priority: current.priority, weight: current.weight } });
  }

  if (normalizeAuthFilePriorityInput(current.priority) === target.priority
    && parseWeight(current.weight) === target.weight) {
    return target;
  }

  await patchRouting(api, name, { priority: target.priority, weight: target.weight });
  return target;
}

/** Restore the manual priority and weight of every credential auto-balance changed. */
export async function restoreQuotaRoutingOriginals(api: BalanceApi = managementApi): Promise<void> {
  const failures: unknown[] = [];
  for (const [name, original] of Object.entries(readOriginals())) {
    try {
      await patchRouting(api, name, {
        priority: normalizeAuthFilePriorityInput(original.priority) ?? 0,
        weight: parseWeight(original.weight),
      });
      const remaining = readOriginals();
      delete remaining[name];
      writeOriginals(remaining);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw failures[0];
}
