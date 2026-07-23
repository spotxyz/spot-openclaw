import { describe, expect, it, vi } from "vitest";

import { SpotApiError, type SpotClient } from "./client.js";
import {
  loadSpotHistoryPage,
  parseSpotMentions,
  renderSpotMessageText,
} from "./history.js";

describe("Spot history", () => {
  it("parses and renders stored mention markup", () => {
    const message = "Hello [Specbot](User--bot-1) in [Lobby](Spot--spot-1--)";

    expect(parseSpotMentions(message)).toEqual([
      { kind: "User", id: "bot-1", label: "Specbot" },
      { kind: "Spot", id: "spot-1", label: "Lobby" },
    ]);
    expect(renderSpotMessageText(message)).toBe("Hello @Specbot in @Lobby");
  });

  it("uses normalized agent history when the server supports it", async () => {
    const normalized = {
      events: [{ id: "event-1", cursor: "cursor-1" }],
      pageInfo: {
        endCursor: "cursor-1",
        hasPreviousPage: false,
        hasNextPage: false,
      },
    };
    const client = {
      getThreadHistory: vi.fn().mockResolvedValue(normalized),
      getLegacyThreadHistory: vi.fn(),
    } as unknown as SpotClient;

    await expect(
      loadSpotHistoryPage({
        client,
        threadId: "thread-1",
        pagination: { last: 20 },
      })
    ).resolves.toBe(normalized);
    expect(client.getLegacyThreadHistory).not.toHaveBeenCalled();
  });

  it("falls back to legacy events, resolves senders, and bounds overfetch", async () => {
    const legacyEdges = ["old", "middle", "new"].map((id, index) => ({
      cursor: `cursor-${id}`,
      node: {
        id: `event-${id}`,
        type: "ChatMessage",
        threadId: "thread-1",
        userId: "wes",
        timestamp: `2026-07-22T18:0${index}:00.000Z`,
        payload: {
          message: id === "new" ? "Hi [Specbot](User--bot-1)" : `Message ${id}`,
          attachedFiles: [],
        },
      },
    }));
    const client = {
      getThreadHistory: vi
        .fn()
        .mockRejectedValue(
          new SpotApiError(
            "not found",
            404,
            "GET",
            "/api/agent/v1/thread/thread-1/events"
          )
        ),
      getLegacyThreadHistory: vi.fn().mockResolvedValue({
        edges: legacyEdges,
        pageInfo: {
          startCursor: "cursor-old",
          endCursor: "cursor-new",
          hasPreviousPage: true,
          hasNextPage: false,
        },
      }),
      getThread: vi.fn().mockResolvedValue({
        id: "thread-1",
        type: "Spot",
        name: "Lobby",
        orgId: "org-1",
        isPrivate: false,
        spotId: "spot-1",
        parentEventId: null,
      }),
      getOrgMembers: vi.fn().mockResolvedValue([
        {
          userId: "wes",
          fullName: "Wes Hather",
          displayName: "Wes",
          isBot: false,
          isGuest: false,
        },
      ]),
    } as unknown as SpotClient;

    const page = await loadSpotHistoryPage({
      client,
      threadId: "thread-1",
      pagination: { last: 2 },
      selfUserId: "bot-1",
    });

    expect(page.events.map((event) => event.id)).toEqual([
      "event-middle",
      "event-new",
    ]);
    expect(page.events.at(-1)).toMatchObject({
      cursor: "cursor-new",
      text: "Hi @Specbot",
      isMentioned: true,
      user: { displayName: "Wes", isBot: false },
    });
    expect(page.pageInfo.startCursor).toBe("cursor-middle");
  });

  it("falls back when an older server routes the agent path to an HTML page", async () => {
    const client = {
      getThreadHistory: vi
        .fn()
        .mockRejectedValue(
          new SpotApiError(
            "Spot API GET /api/agent/v1/thread/thread-1/events returned invalid JSON.",
            200,
            "GET",
            "/api/agent/v1/thread/thread-1/events"
          )
        ),
      getLegacyThreadHistory: vi.fn().mockResolvedValue({
        edges: [],
        pageInfo: { hasPreviousPage: false, hasNextPage: false },
      }),
      getThread: vi.fn().mockResolvedValue({
        id: "thread-1",
        type: "Spot",
        name: "Lobby",
        orgId: null,
        isPrivate: false,
        spotId: "spot-1",
        parentEventId: null,
      }),
    } as unknown as SpotClient;

    await expect(
      loadSpotHistoryPage({ client, threadId: "thread-1" })
    ).resolves.toMatchObject({ events: [] });
    expect(client.getLegacyThreadHistory).toHaveBeenCalled();
  });
});
