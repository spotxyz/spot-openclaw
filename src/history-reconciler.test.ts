import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpotClient } from "./client.js";
import {
  createSpotHistoryCursorStore,
  resetSpotHistoryCursorStateForTest,
} from "./history-cursor-state.js";
import {
  resolveSpotHistoryThreadIds,
  SpotHistoryReconciler,
} from "./history-reconciler.js";
import type { ResolvedSpotAccount, SpotMessageEvent } from "./types.js";

const account = (): ResolvedSpotAccount => ({
  accountId: "default",
  enabled: true,
  baseUrl: "https://spot.test",
  token: "x",
  activationMode: "all",
  allowFrom: ["*"],
  allowBotMessages: false,
  subscribeWorlds: ["world-2"],
  subscribeThreads: ["thread-explicit"],
  monitorOrgChannels: false,
  worldId: "world-1",
});

const page = (
  events: Array<Pick<SpotMessageEvent, "id">>,
  endCursor: string,
  hasNextPage = false
) => ({
  events,
  pageInfo: {
    startCursor: events[0]?.id,
    endCursor,
    hasPreviousPage: false,
    hasNextPage,
  },
});

describe("Spot history reconciliation", () => {
  beforeEach(() => resetSpotHistoryCursorStateForTest());

  it("baselines a new thread without replaying old messages", async () => {
    const cursorStore = createSpotHistoryCursorStore("default");
    const client = {
      getThreadHistory: vi
        .fn()
        .mockResolvedValue(page([{ id: "old" }], "cursor-old")),
    } as unknown as SpotClient;
    const handleEvent = vi.fn();
    const reconciler = new SpotHistoryReconciler({
      client,
      selfUserId: "bot-1",
      cursorStore,
      handleEvent,
    });

    await expect(reconciler.reconcileThread("thread-1")).resolves.toBe(0);
    expect(handleEvent).not.toHaveBeenCalled();
    await expect(cursorStore.get("thread-1")).resolves.toBe("cursor-old");
    expect(client.getThreadHistory).toHaveBeenCalledWith(
      "thread-1",
      { last: 1 },
      undefined
    );
  });

  it("replays later pages in order and advances the durable cursor", async () => {
    const cursorStore = createSpotHistoryCursorStore("default");
    await cursorStore.set("thread-1", "cursor-start");
    const first = { id: "event-1" } as SpotMessageEvent;
    const second = { id: "event-2" } as SpotMessageEvent;
    const client = {
      getThreadHistory: vi
        .fn()
        .mockResolvedValueOnce(page([first], "cursor-middle", true))
        .mockResolvedValueOnce(page([second], "cursor-end")),
    } as unknown as SpotClient;
    const handleEvent = vi.fn().mockResolvedValue(undefined);
    const reconciler = new SpotHistoryReconciler({
      client,
      selfUserId: "bot-1",
      cursorStore,
      handleEvent,
    });

    await expect(reconciler.reconcileThread("thread-1")).resolves.toBe(2);
    expect(handleEvent.mock.calls.map(([event]) => event.id)).toEqual([
      "event-1",
      "event-2",
    ]);
    await expect(cursorStore.get("thread-1")).resolves.toBe("cursor-end");
  });

  it("discovers room threads alongside explicit and monitored threads", async () => {
    const client = {
      getSpots: vi
        .fn()
        .mockResolvedValueOnce([{ threadId: "thread-room-1" }])
        .mockResolvedValueOnce([{ threadId: "thread-room-2" }]),
    } as unknown as SpotClient;

    await expect(
      resolveSpotHistoryThreadIds({
        client,
        account: account(),
        subscribedThreadIds: ["thread-explicit", "thread-monitored"],
      })
    ).resolves.toEqual([
      "thread-explicit",
      "thread-monitored",
      "thread-room-1",
      "thread-room-2",
    ]);
  });
});
