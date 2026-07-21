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
    const abortController = new AbortController();

    const result = await tool.execute(
      "call-1",
      { room: "LOBBY" },
      abortController.signal,
    );
    expect(joinAvatar).toHaveBeenCalledWith(
      "world-1",
      { spotId: "spot-lobby" },
      { signal: abortController.signal },
    );
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
    const abortController = new AbortController();

    const result = await tool.execute("call-3", {}, abortController.signal);
    expect(client.getAvatarState).toHaveBeenCalledWith("world-1", {
      signal: abortController.signal,
    });
    expect(result.details).toMatchObject({ ok: true, worldId: "world-1" });
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
});
