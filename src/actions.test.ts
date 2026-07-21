import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import { createSpotMessageActions } from "./actions.js";
import type { SpotClient } from "./client.js";

const cfg = {
  channels: {
    spot: { token: "token", baseUrl: "https://spot.test" },
  },
} as OpenClawConfig;

const reaction = (id: string, userId: string, emoji: string) => ({
  id,
  userId,
  emoji,
});

const createActions = (client: SpotClient) =>
  createSpotMessageActions({ createClient: () => client });

describe("Spot shared message actions", () => {
  it("advertises the shared reaction actions and schemas in Spot context", () => {
    const actions = createActions({} as SpotClient);
    expect(
      actions.describeMessageTool({
        cfg,
        currentChannelProvider: "spot",
        accountId: "default",
      }),
    ).toMatchObject({
      actions: ["react", "reactions"],
      schema: {
        actions: ["react", "reactions"],
        properties: {
          messageId: expect.any(Object),
          emoji: expect.any(Object),
          remove: expect.any(Object),
        },
      },
    });
    expect(
      actions.describeMessageTool({
        cfg,
        currentChannelProvider: "slack",
      }),
    ).toBeNull();
  });

  it("lists reactions using the current message context", async () => {
    const client = {
      getEventReactions: vi
        .fn()
        .mockResolvedValue([reaction("r-1", "user-1", "👍")]),
    } as unknown as SpotClient;
    const result = await createActions(client).handleAction!({
      channel: "spot",
      action: "reactions",
      cfg,
      params: {},
      toolContext: { currentMessageId: "event-1" },
    } as never);

    expect(client.getEventReactions).toHaveBeenCalledWith("event-1");
    expect(result.details).toMatchObject({
      ok: true,
      messageId: "event-1",
      reactions: [{ id: "r-1", emoji: "👍" }],
    });
  });

  it("adds idempotently and never duplicates its own matching reaction", async () => {
    const client = {
      getEventReactions: vi
        .fn()
        .mockResolvedValue([reaction("r-own", "bot-1", "✅")]),
      getMe: vi.fn().mockResolvedValue({ user: { id: "bot-1" } }),
      addEventReaction: vi.fn(),
    } as unknown as SpotClient;
    const result = await createActions(client).handleAction!({
      channel: "spot",
      action: "react",
      cfg,
      params: { messageId: "event-1", emoji: "✅" },
    } as never);

    expect(client.addEventReaction).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: true,
      reactionId: "r-own",
      alreadyPresent: true,
    });
  });

  it("adds a missing reaction", async () => {
    const client = {
      getEventReactions: vi.fn().mockResolvedValue([]),
      getMe: vi.fn().mockResolvedValue({ user: { id: "bot-1" } }),
      addEventReaction: vi.fn().mockResolvedValue({}),
    } as unknown as SpotClient;
    const result = await createActions(client).handleAction!({
      channel: "spot",
      action: "react",
      cfg,
      params: { messageId: "event-1", emoji: "✅" },
    } as never);

    expect(client.addEventReaction).toHaveBeenCalledWith("event-1", "✅");
    expect(result.details).toMatchObject({ ok: true, added: true, emoji: "✅" });
  });

  it("removes only its own matching reaction or all of its own on empty emoji", async () => {
    const reactions = [
      reaction("r-own-check", "bot-1", "✅"),
      reaction("r-own-wave", "bot-1", "👋"),
      reaction("r-other", "user-1", "✅"),
    ];
    const client = {
      getEventReactions: vi.fn().mockResolvedValue(reactions),
      getMe: vi.fn().mockResolvedValue({ user: { id: "bot-1" } }),
      removeEventReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as SpotClient;
    const actions = createActions(client);

    await actions.handleAction!({
      channel: "spot",
      action: "react",
      cfg,
      params: { messageId: "event-1", emoji: "✅", remove: true },
    } as never);
    expect(client.removeEventReaction).toHaveBeenCalledTimes(1);
    expect(client.removeEventReaction).toHaveBeenCalledWith(
      "event-1",
      "r-own-check",
    );

    vi.mocked(client.removeEventReaction).mockClear();
    const result = await actions.handleAction!({
      channel: "spot",
      action: "react",
      cfg,
      params: { messageId: "event-1", emoji: "" },
    } as never);
    expect(client.removeEventReaction).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({ ok: true, removed: 2 });
  });
});
