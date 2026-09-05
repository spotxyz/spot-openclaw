import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { recordChannelActivity } = vi.hoisted(() => ({
  recordChannelActivity: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/infra-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/infra-runtime")
  >()),
  recordChannelActivity,
}));

import {
  chunkSpotText,
  normalizeSpotTarget,
  parseSpotTarget,
  resolveSpotReplyDestination,
  SPOT_MESSAGE_MAX_LENGTH,
  spotOutboundAdapter,
  spotMessageAdapter,
} from "./outbound.js";
import {
  resolveSpotOutboundSessionRoute,
  spotChannelPlugin,
} from "./channel.js";
import type { SpotClient } from "./client.js";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Spot target grammar", () => {
  it.each([
    ["thread:abc", { kind: "thread", id: "abc" }],
    ["user:user-1", { kind: "user", id: "user-1" }],
    ["world:world-1", { kind: "world", id: "world-1" }],
    ["spot:lobby", { kind: "spot", id: "lobby" }],
    ["spot:thread:abc", { kind: "thread", id: "abc" }],
    ["bare-thread-id", { kind: "thread", id: "bare-thread-id" }],
  ])("parses %s", (raw, expected) => {
    expect(parseSpotTarget(raw as string)).toEqual(expected);
  });

  it("normalizes provider-prefixed targets and rejects empty targets", () => {
    expect(normalizeSpotTarget(" spot:user:user-2 ")).toBe("user:user-2");
    expect(() => normalizeSpotTarget("   ")).toThrow(/required/);
    expect(() => normalizeSpotTarget("thread:   ")).toThrow(/empty/);
  });

  it("enforces Spot's 12,000-character boundary and advertises durable replies", () => {
    const boundary = "x".repeat(SPOT_MESSAGE_MAX_LENGTH);
    expect(chunkSpotText(boundary)).toEqual([boundary]);

    const overBoundary = `${boundary}y`;
    const chunks = chunkSpotText(overBoundary);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= SPOT_MESSAGE_MAX_LENGTH)).toBe(
      true,
    );
    expect(chunks.join("")).toBe(overBoundary);
    expect(spotOutboundAdapter.textChunkLimit).toBe(12_000);
    expect(spotOutboundAdapter.deliveryCapabilities?.durableFinal).toMatchObject({
      text: true,
      replyTo: true,
      thread: true,
    });
  });

  it("creates a child only when replyToId belongs to a named channel", async () => {
    const channelClient = {
      baseUrl: "https://spot.test",
      getEvent: vi.fn().mockResolvedValue({ id: "event-1", threadId: "channel-1" }),
      getThread: vi.fn().mockResolvedValue({ id: "channel-1", type: "Channel" }),
      getOrCreateEventThread: vi.fn().mockResolvedValue({ id: "reply-thread-1" }),
    } as unknown as SpotClient;
    await expect(
      resolveSpotReplyDestination(channelClient, "channel-1", "event-1"),
    ).resolves.toBe("reply-thread-1");
    expect(channelClient.getOrCreateEventThread).toHaveBeenCalledWith("event-1");

    const roomClient = {
      baseUrl: "https://spot.test",
      getEvent: vi.fn().mockResolvedValue({ id: "event-2", threadId: "room-1" }),
      getThread: vi.fn().mockResolvedValue({ id: "room-1", type: "Spot" }),
      getOrCreateEventThread: vi.fn(),
    } as unknown as SpotClient;
    await expect(
      resolveSpotReplyDestination(roomClient, "unrelated", "event-2"),
    ).resolves.toBe("room-1");
    expect(roomClient.getOrCreateEventThread).not.toHaveBeenCalled();
  });

  it("coalesces concurrent reply-thread creation for the same channel event", async () => {
    let resolveThread!: (value: { id: string }) => void;
    const pending = new Promise<{ id: string }>((resolve) => {
      resolveThread = resolve;
    });
    const client = {
      baseUrl: "https://spot.test",
      getEvent: vi.fn().mockResolvedValue({ id: "event-race", threadId: "channel-1" }),
      getThread: vi.fn().mockResolvedValue({ id: "channel-1", type: "Channel" }),
      getOrCreateEventThread: vi.fn().mockReturnValue(pending),
    } as unknown as SpotClient;
    const first = resolveSpotReplyDestination(client, "channel-1", "event-race");
    const second = resolveSpotReplyDestination(client, "channel-1", "event-race");
    await vi.waitFor(() =>
      expect(client.getOrCreateEventThread).toHaveBeenCalledOnce(),
    );
    resolveThread({ id: "reply-race" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      "reply-race",
      "reply-race",
    ]);
  });

  it("uses group session identity for durable room threads", async () => {
    expect(
      spotChannelPlugin.messaging?.inferTargetChatType?.({
        to: "thread:thread-1",
      }),
    ).toBe("group");
    await expect(
      spotChannelPlugin.messaging?.targetResolver?.resolveTarget?.({
        cfg: {} as never,
        input: "thread:thread-1",
        normalized: "thread:thread-1",
      }),
    ).resolves.toMatchObject({
      to: "thread:thread-1",
      kind: "group",
    });
  });

  it("canonicalizes DM and room aliases to the resolved thread session", async () => {
    const cfg = {
      channels: {
        spot: {
          token: "token",
          worldId: "world-1",
        },
      },
    } as OpenClawConfig;
    const client = {
      getOrCreateDm: async () => ({ id: "dm-thread" }),
      getSpots: async () => [
        {
          id: "spot-lobby",
          name: "Lobby",
          slug: "lobby",
          roomId: "floorplan-room",
          threadId: "lobby-thread",
          isDefault: true,
          isMeetingRoom: false,
          canAccess: true,
        },
      ],
    } as unknown as SpotClient;
    const dependencies = { createClient: () => client };

    const dmRoute = await resolveSpotOutboundSessionRoute(
      {
        cfg,
        agentId: "main",
        accountId: "default",
        target: "user:user-1",
      },
      dependencies,
    );
    expect(dmRoute).toMatchObject({
      recipientSessionExact: true,
      peer: { kind: "group", id: "dm-thread" },
      chatType: "group",
      to: "thread:dm-thread",
    });

    const roomRoute = await resolveSpotOutboundSessionRoute(
      {
        cfg,
        agentId: "main",
        accountId: "default",
        target: "spot:lobby",
      },
      dependencies,
    );
    expect(roomRoute).toMatchObject({
      peer: { kind: "group", id: "lobby-thread" },
      to: "thread:lobby-thread",
    });
  });

  it.each([
    ["outbound", spotOutboundAdapter.sendText!],
    ["message bridge", spotMessageAdapter.send!.text!],
  ] as const)("records successful %s activity and preserves the destination", async (_name, send) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ id: "event-1", threadId: "thread-1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const cfg = {
      channels: {
        spot: {
          baseUrl: "https://spot.test",
          token: "token",
        },
      },
    } as OpenClawConfig;

    const result = await send({
      cfg,
      accountId: "default",
      to: "thread:thread-1",
      text: "hello",
    } as never);

    expect(result).toMatchObject({ messageId: "event-1", conversationId: "thread-1" });
    expect(recordChannelActivity).toHaveBeenCalledWith({
      channel: "spot",
      accountId: "default",
      direction: "outbound",
    });
  });
});
