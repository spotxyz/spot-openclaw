import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PluginRuntime } from "openclaw/plugin-sdk/core";

type OpenKeyedStoreOptions = Parameters<PluginRuntime["state"]["openKeyedStore"]>[0];
declare const openKeyedStore: PluginRuntime["state"]["openKeyedStore"];
type PluginStateKeyedStore<T> = ReturnType<typeof openKeyedStore<T>>;

interface SpotHistoryCursorRecord {
  cursor: string;
  updatedAt: number;
}

export interface SpotHistoryCursorStore {
  get(threadId: string): Promise<string | undefined>;
  set(threadId: string, cursor: string): Promise<void>;
}

const memory = new Map<string, SpotHistoryCursorRecord>();
let persistent: PluginStateKeyedStore<SpotHistoryCursorRecord> | undefined;
let fallbackPath: string | undefined;
let fallbackRecords: Map<string, SpotHistoryCursorRecord> | undefined;
let fallbackWrite = Promise.resolve();

const MAX_CURSOR_RECORDS = 4_096;
const CURSOR_STATE_DIRECTORY = "spot";
const CURSOR_STATE_FILENAME = "history-cursors-v1.json";

const keyFor = (accountId: string, threadId: string): string =>
  `${accountId}:${threadId}`;

export const configureSpotHistoryCursorPersistence = (
  openStore: (
    options: OpenKeyedStoreOptions
  ) => PluginStateKeyedStore<SpotHistoryCursorRecord>,
  stateDir?: string
): void => {
  fallbackPath = stateDir
    ? join(stateDir, CURSOR_STATE_DIRECTORY, CURSOR_STATE_FILENAME)
    : undefined;
  try {
    persistent = openStore({
      namespace: "spot-history-cursors-v1",
      maxEntries: MAX_CURSOR_RECORDS,
      overflowPolicy: "evict-oldest",
    });
  } catch {
    // Local plugins cannot use OpenClaw's keyed store in every release. The
    // plugin-owned state file below keeps replay cursors durable in that case.
    persistent = undefined;
  }
};

const readFallbackRecords = async (): Promise<
  Map<string, SpotHistoryCursorRecord>
> => {
  if (fallbackRecords) return fallbackRecords;
  if (!fallbackPath) return new Map();
  try {
    const parsed = JSON.parse(await readFile(fallbackPath, "utf8")) as Record<
      string,
      SpotHistoryCursorRecord
    >;
    fallbackRecords = new Map(
      Object.entries(parsed).filter(
        ([, record]) =>
          typeof record?.cursor === "string" &&
          Number.isFinite(record.updatedAt)
      )
    );
  } catch {
    fallbackRecords = new Map();
  }
  return fallbackRecords;
};

const writeFallbackRecord = async (
  key: string,
  record: SpotHistoryCursorRecord
): Promise<void> => {
  if (!fallbackPath) return;
  const destinationPath = fallbackPath;
  const write = async () => {
    const records = await readFallbackRecords();
    records.set(key, record);
    if (records.size > MAX_CURSOR_RECORDS) {
      const oldest = [...records.entries()].sort(
        ([, left], [, right]) => left.updatedAt - right.updatedAt
      )[0];
      if (oldest) records.delete(oldest[0]);
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = `${destinationPath}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(Object.fromEntries(records))}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
    await rename(temporaryPath, destinationPath);
  };
  fallbackWrite = fallbackWrite.then(write, write);
  await fallbackWrite;
};

export const createSpotHistoryCursorStore = (
  accountId: string
): SpotHistoryCursorStore => ({
  async get(threadId) {
    const key = keyFor(accountId, threadId);
    const cached = memory.get(key);
    if (cached) return cached.cursor;
    try {
      const stored = await persistent?.lookup(key);
      if (stored) {
        memory.set(key, stored);
        return stored.cursor;
      }
    } catch {
      persistent = undefined;
    }
    const stored = (await readFallbackRecords()).get(key);
    if (stored) memory.set(key, stored);
    return stored?.cursor;
  },
  async set(threadId, cursor) {
    const key = keyFor(accountId, threadId);
    const record = { cursor, updatedAt: Date.now() };
    memory.set(key, record);
    try {
      if (persistent) {
        await persistent.register(key, record);
        return;
      }
    } catch {
      persistent = undefined;
    }
    try {
      await writeFallbackRecord(key, record);
    } catch {
      // Cursor persistence is best effort; the in-process cursor remains valid.
    }
  },
});

export const resetSpotHistoryCursorStateForTest = (): void => {
  memory.clear();
  persistent = undefined;
  fallbackPath = undefined;
  fallbackRecords = undefined;
  fallbackWrite = Promise.resolve();
};

export const clearSpotHistoryCursorMemoryForTest = (): void => {
  memory.clear();
  fallbackRecords = undefined;
};
