import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearSpotHistoryCursorMemoryForTest,
  configureSpotHistoryCursorPersistence,
  createSpotHistoryCursorStore,
  resetSpotHistoryCursorStateForTest,
} from "./history-cursor-state.js";

describe("Spot history cursor state", () => {
  const temporaryDirectories: string[] = [];

  beforeEach(() => resetSpotHistoryCursorStateForTest());
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  it("reloads a cursor from OpenClaw plugin state after memory is cleared", async () => {
    const records = new Map<string, { cursor: string; updatedAt: number }>();
    const persistent = {
      register: vi.fn(
        async (key: string, value: { cursor: string; updatedAt: number }) => {
          records.set(key, value);
        }
      ),
      lookup: vi.fn(async (key: string) => records.get(key)),
    };
    configureSpotHistoryCursorPersistence(() => persistent as never);
    const store = createSpotHistoryCursorStore("default");

    await store.set("thread-1", "cursor-1");
    clearSpotHistoryCursorMemoryForTest();

    await expect(store.get("thread-1")).resolves.toBe("cursor-1");
    expect(persistent.register).toHaveBeenCalledWith(
      "default:thread-1",
      expect.objectContaining({ cursor: "cursor-1" })
    );
    expect(persistent.lookup).toHaveBeenCalledWith("default:thread-1");
  });

  it("falls back to a durable state file when keyed storage is unavailable", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "spot-history-state-"));
    temporaryDirectories.push(stateDir);
    configureSpotHistoryCursorPersistence(() => {
      throw new Error("trusted plugins only");
    }, stateDir);
    const store = createSpotHistoryCursorStore("default");

    await store.set("thread-1", "cursor-1");
    clearSpotHistoryCursorMemoryForTest();

    await expect(store.get("thread-1")).resolves.toBe("cursor-1");
  });
});
