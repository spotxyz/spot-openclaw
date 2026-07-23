import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import type { SpotClient } from "./client.js";
import {
  isManagedAvatarLeaseSuppressed,
  resumeManagedAvatarLease,
} from "./avatar-lease-state.js";
import { createSpotTools } from "./tools.js";

const cfg = {
  channels: {
    spot: {
      token: "resolved-token",
      baseUrl: "https://spot.test",
      worldId: "world-1",
    },
  },
} as OpenClawConfig;

const rooms = [
  {
    id: "spot-lobby",
    name: "Lobby",
    slug: "lobby",
    roomId: "room-lobby",
    threadId: "thread-lobby",
    isDefault: true,
    isMeetingRoom: false,
    canAccess: true,
  },
  {
    id: "spot-vault",
    name: "Vault",
    slug: "vault",
    roomId: "room-vault",
    threadId: "thread-vault",
    isDefault: false,
    isMeetingRoom: false,
    canAccess: false,
    accessDeniedReason: "spot_locked" as const,
  },
];

describe("Spot avatar tools", () => {
  it("walks a joined avatar to a discovered room without guessing coordinates", async () => {
    const joinAvatar = vi.fn().mockResolvedValue({
      joined: true,
      spotId: "spot-lobby",
      position: { x: 4, y: 0, z: 9 },
    });
    const walkAvatarToSpot = vi.fn().mockResolvedValue({
      joined: true,
      spotId: "spot-lobby",
      position: { x: 4, y: 0, z: 9 },
    });
    const client = {
      getSpots: vi.fn().mockResolvedValue(rooms),
      getAvatarState: vi.fn().mockResolvedValue({ joined: true }),
      joinAvatar,
      walkAvatarToSpot,
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find(
      (candidate) => candidate.name === "spot_move_to_room",
    )!;
    const abortController = new AbortController();

    const result = await tool.execute(
      "call-1",
      { room: "LOBBY" },
      abortController.signal,
    );
    expect(walkAvatarToSpot).toHaveBeenCalledWith(
      "world-1",
      { spotId: "spot-lobby" },
      { signal: abortController.signal },
    );
    expect(joinAvatar).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      ok: true,
      worldId: "world-1",
      room: { threadId: "thread-lobby" },
    });
  });

  it("joins directly in the selected room when the avatar is not live", async () => {
    const joinAvatar = vi.fn().mockResolvedValue({
      joined: true,
      spotId: "spot-lobby",
    });
    const walkAvatarToSpot = vi.fn();
    const client = {
      getSpots: vi.fn().mockResolvedValue(rooms),
      getAvatarState: vi.fn().mockResolvedValue({ joined: false }),
      joinAvatar,
      walkAvatarToSpot,
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find(
      (candidate) => candidate.name === "spot_move_to_room",
    )!;

    await tool.execute("call-join-room", { room: "lobby" });

    expect(joinAvatar).toHaveBeenCalledWith(
      "world-1",
      { spotId: "spot-lobby" },
      { signal: undefined },
    );
    expect(walkAvatarToSpot).not.toHaveBeenCalled();
  });

  it("does not attempt to enter a room denied by discovery", async () => {
    const joinAvatar = vi.fn();
    const client = {
      getSpots: vi.fn().mockResolvedValue(rooms),
      joinAvatar,
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find(
      (candidate) => candidate.name === "spot_move_to_room",
    )!;

    await expect(tool.execute("call-2", { room: "vault" })).rejects.toThrow(
      /spot_locked/,
    );
    expect(joinAvatar).not.toHaveBeenCalled();
  });

  it("uses the configured world when observing", async () => {
    const client = {
      getAvatarState: vi.fn().mockResolvedValue({ joined: false }),
      getWorldAvatars: vi.fn().mockResolvedValue([]),
      getSpots: vi.fn().mockResolvedValue(rooms),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find((candidate) => candidate.name === "spot_observe")!;
    const abortController = new AbortController();

    const result = await tool.execute("call-3", {}, abortController.signal);
    expect(client.getAvatarState).toHaveBeenCalledWith("world-1", {
      signal: abortController.signal,
    });
    expect(result.details).toMatchObject({ ok: true, worldId: "world-1" });
  });

  it("reads bounded history from the avatar's current room", async () => {
    const client = {
      getSpots: vi.fn().mockResolvedValue(rooms),
      getAvatarState: vi.fn().mockResolvedValue({
        joined: true,
        spotId: "spot-lobby",
      }),
      getMe: vi.fn().mockResolvedValue({ user: { id: "bot-1" } }),
      getThreadHistory: vi.fn().mockResolvedValue({
        events: [
          {
            id: "event-1",
            cursor: "cursor-1",
            threadId: "thread-lobby",
            userId: "user-1",
            user: {
              id: "user-1",
              fullName: "Wes Hather",
              displayName: "Wes",
              isBot: false,
            },
            timestamp: "2026-07-22T18:00:00.000Z",
            text: "hello",
            attachedFiles: [],
          },
        ],
        pageInfo: {
          startCursor: "cursor-1",
          endCursor: "cursor-1",
          hasPreviousPage: false,
          hasNextPage: false,
        },
      }),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find((candidate) => candidate.name === "spot_history")!;
    const result = await tool.execute("call-history", { limit: 5 });

    expect(client.getThreadHistory).toHaveBeenCalledWith(
      "thread-lobby",
      { last: 5 },
      { signal: undefined },
    );
    expect(result.details).toMatchObject({
      ok: true,
      threadId: "thread-lobby",
      room: { id: "spot-lobby" },
      messages: [{ id: "event-1", text: "hello" }],
    });
  });

  it("keeps an explicit leave suppressed until an explicit join", async () => {
    const client = {
      leaveAvatar: vi.fn().mockResolvedValue(undefined),
      joinAvatar: vi.fn().mockResolvedValue({ joined: true }),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const leave = tools.find((candidate) => candidate.name === "spot_leave")!;
    const join = tools.find((candidate) => candidate.name === "spot_join")!;
    const abortController = new AbortController();

    await leave.execute("call-leave", {}, abortController.signal);
    expect(isManagedAvatarLeaseSuppressed("default", "world-1")).toBe(true);
    expect(client.leaveAvatar).toHaveBeenCalledWith("world-1", {
      signal: abortController.signal,
    });

    await join.execute("call-join", {}, abortController.signal);
    expect(isManagedAvatarLeaseSuppressed("default", "world-1")).toBe(false);
    expect(client.joinAvatar).toHaveBeenCalledWith(
      "world-1",
      {},
      { signal: abortController.signal },
    );
  });

  it("does not resume a managed lease when an explicit join fails", async () => {
    const client = {
      leaveAvatar: vi.fn().mockResolvedValue(undefined),
      joinAvatar: vi.fn().mockRejectedValue(new Error("join rejected")),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const leave = tools.find((candidate) => candidate.name === "spot_leave")!;
    const join = tools.find((candidate) => candidate.name === "spot_join")!;

    await leave.execute("call-leave-failed-join", {});
    await expect(join.execute("call-failed-join", {})).rejects.toThrow(
      /join rejected/,
    );
    expect(isManagedAvatarLeaseSuppressed("default", "world-1")).toBe(true);

    resumeManagedAvatarLease("default", "world-1");
  });

  it("discovers and sends canonical emotes", async () => {
    const client = {
      getAvatarEmotes: vi
        .fn()
        .mockResolvedValue([
          { id: "wave", animation: 19, defaultEmojiName: "wave" },
        ]),
      emote: vi.fn().mockResolvedValue({ joined: true }),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );

    const catalog = tools.find(
      (candidate) => candidate.name === "spot_emotes",
    )!;
    const emote = tools.find((candidate) => candidate.name === "spot_emote")!;
    await expect(catalog.execute("call-emotes", {})).resolves.toMatchObject({
      details: { emotes: [{ id: "wave" }] },
    });
    await emote.execute("call-emote", {
      animation: "wave",
      emojiName: "wave",
    });

    expect(client.emote).toHaveBeenCalledWith(
      "world-1",
      { animation: "wave", emojiName: "wave" },
      { signal: undefined },
    );
  });

  it("requests, cancels, and completes social gestures", async () => {
    const client = {
      requestAvatarGesture: vi.fn().mockResolvedValue({ joined: true }),
      completeAvatarGesture: vi.fn().mockResolvedValue({ joined: true }),
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const gesture = tools.find(
      (candidate) => candidate.name === "spot_gesture",
    )!;

    await gesture.execute("call-request", {
      action: "request",
      gesture: "high-five",
    });
    await gesture.execute("call-cancel", { action: "cancel" });
    await gesture.execute("call-complete", {
      action: "complete",
      requesterUserId: "user-2",
      response: "rps-paper",
    });

    expect(client.requestAvatarGesture).toHaveBeenNthCalledWith(
      1,
      "world-1",
      "high-five",
      { signal: undefined },
    );
    expect(client.requestAvatarGesture).toHaveBeenNthCalledWith(
      2,
      "world-1",
      null,
      { signal: undefined },
    );
    expect(client.completeAvatarGesture).toHaveBeenCalledWith(
      "world-1",
      { requesterUserId: "user-2", response: "rps-paper" },
      { signal: undefined },
    );
  });
});
