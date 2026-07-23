import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";

import type { SpotClient, SpotRequestOptions } from "./client.js";
import { loadSpotHistoryPage } from "./history.js";
import type { SpotHistoryCursorStore } from "./history-cursor-state.js";
import type { ResolvedSpotAccount, SpotMessageEvent } from "./types.js";

export const SPOT_HISTORY_REPLAY_PAGE_SIZE = 50;
export const SPOT_HISTORY_REPLAY_MAX_PAGES = 10;
const SPOT_HISTORY_REPLAY_CONCURRENCY = 4;

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

export const resolveSpotHistoryThreadIds = async (params: {
  client: Pick<SpotClient, "getSpots">;
  account: ResolvedSpotAccount;
  subscribedThreadIds: Iterable<string>;
  options?: SpotRequestOptions;
  log?: Pick<ChannelLogSink, "warn">;
}): Promise<string[]> => {
  const threadIds = new Set(params.subscribedThreadIds);
  const worldIds = unique(
    [params.account.worldId, ...params.account.subscribeWorlds].filter(
      (value): value is string => !!value
    )
  );
  const results = await Promise.allSettled(
    worldIds.map((worldId) => params.client.getSpots(worldId, params.options))
  );
  results.forEach((result, index) => {
    if (result.status === "fulfilled") {
      result.value.forEach((room) => threadIds.add(room.threadId));
      return;
    }
    params.log?.warn(
      `Spot history discovery failed for world ${worldIds[index]}: ${String(
        result.reason
      )}`
    );
  });
  return [...threadIds];
};

export class SpotHistoryReconciler {
  private readonly active = new Map<string, Promise<number>>();

  constructor(
    private readonly params: {
      client: SpotClient;
      selfUserId: string;
      cursorStore: SpotHistoryCursorStore;
      handleEvent: (event: SpotMessageEvent) => Promise<void>;
      options?: SpotRequestOptions;
    }
  ) {}

  reconcileThread(threadId: string): Promise<number> {
    const existing = this.active.get(threadId);
    if (existing) return existing;
    const task = this.runThread(threadId).finally(() => {
      this.active.delete(threadId);
    });
    this.active.set(threadId, task);
    return task;
  }

  async reconcileThreads(threadIds: Iterable<string>): Promise<number> {
    const pending = unique(threadIds);
    let replayed = 0;
    const workers = Array.from(
      { length: Math.min(SPOT_HISTORY_REPLAY_CONCURRENCY, pending.length) },
      async () => {
        while (pending.length > 0) {
          const threadId = pending.shift();
          if (!threadId) return;
          replayed += await this.reconcileThread(threadId);
        }
      }
    );
    await Promise.all(workers);
    return replayed;
  }

  private async runThread(threadId: string): Promise<number> {
    let cursor = await this.params.cursorStore.get(threadId);
    if (!cursor) {
      const baseline = await loadSpotHistoryPage({
        client: this.params.client,
        threadId,
        pagination: { last: 1 },
        selfUserId: this.params.selfUserId,
        ...(this.params.options ? { options: this.params.options } : {}),
      });
      if (baseline.pageInfo.endCursor) {
        await this.params.cursorStore.set(
          threadId,
          baseline.pageInfo.endCursor
        );
      }
      return 0;
    }

    let replayed = 0;
    for (
      let pageIndex = 0;
      pageIndex < SPOT_HISTORY_REPLAY_MAX_PAGES;
      pageIndex += 1
    ) {
      const page = await loadSpotHistoryPage({
        client: this.params.client,
        threadId,
        pagination: { after: cursor, first: SPOT_HISTORY_REPLAY_PAGE_SIZE },
        selfUserId: this.params.selfUserId,
        ...(this.params.options ? { options: this.params.options } : {}),
      });
      for (const event of page.events) {
        await this.params.handleEvent(event);
        replayed += 1;
      }
      const nextCursor = page.pageInfo.endCursor;
      if (!nextCursor || nextCursor === cursor) return replayed;
      cursor = nextCursor;
      await this.params.cursorStore.set(threadId, cursor);
      if (!page.pageInfo.hasNextPage) return replayed;
    }
    throw new Error(
      `Spot history replay exceeded ${
        SPOT_HISTORY_REPLAY_MAX_PAGES * SPOT_HISTORY_REPLAY_PAGE_SIZE
      } events for thread ${threadId}.`
    );
  }
}
