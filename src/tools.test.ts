import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import type { SpotClient } from "./client.js";
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
  it("moves to a discovered room by spot id without guessing coordinates", async () => {
    const joinAvatar = vi.fn().mockResolvedValue({
      joined: true,
      spotId: "spot-lobby",
      position: { x: 4, y: 0, z: 9 },
    });
    const client = {
      getSpots: vi.fn().mockResolvedValue(rooms),
      joinAvatar,
    } as unknown as SpotClient;
    const tools = createSpotTools(
      { getConfig: () => cfg },
      { createClient: () => client },
    );
    const tool = tools.find((candidate) => candidate.name === "spot_move_to_room")!;

    const result = await tool.execute("call-1", { room: "LOBBY" });
    expect(joinAvatar).toHaveBeenCalledWith("world-1", { spotId: "spot-lobby" });
    expect(result.details).toMatchObject({
      ok: true,
      worldId: "world-1",
      room: { threadId: "thread-lobby" },
    });
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
    const tool = tools.find((candidate) => candidate.name === "spot_move_to_room")!;

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

    const result = await tool.execute("call-3", {});
    expect(client.getAvatarState).toHaveBeenCalledWith("world-1");
    expect(result.details).toMatchObject({ ok: true, worldId: "world-1" });
  });
});
