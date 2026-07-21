import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";

import {
  chunkSpotText,
  normalizeSpotTarget,
  parseSpotTarget,
  SPOT_MESSAGE_MAX_LENGTH,
  spotOutboundAdapter,
} from "./outbound.js";
import {
  resolveSpotOutboundSessionRoute,
  spotChannelPlugin,
} from "./channel.js";
import type { SpotClient } from "./client.js";

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

  it("enforces Spot's 12,000-character boundary and advertises no native replyTo", () => {
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
      replyTo: false,
      thread: true,
    });
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
});
