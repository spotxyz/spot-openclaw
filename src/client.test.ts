import { describe, expect, it, vi } from "vitest";

import { SpotApiError, SpotClient } from "./client.js";

describe("SpotClient", () => {
  it("authenticates requests and posts text to a thread", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "event-1", threadId: "thread-1" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const client = new SpotClient({
      baseUrl: "http://127.0.0.1:3000/",
      token: "super-secret",
      fetch,
    });

    await expect(client.sendThreadMessage("thread/one", "hello")).resolves.toMatchObject({
      id: "event-1",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:3000/api/thread/thread%2Fone/events");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer super-secret" });
    expect(init?.body).toBe(JSON.stringify({ message: "hello" }));
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("combines caller cancellation with a finite request timeout", async () => {
    const caller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new SpotClient({
      baseUrl: "https://spot.test",
      token: "x",
      fetch,
      requestTimeoutMs: 1_000,
    });

    const request = client.getMe({ signal: caller.signal });
    caller.abort(new Error("caller stopped"));
    await expect(request).rejects.toThrow("caller stopped");
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("times out stalled requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const client = new SpotClient({
      baseUrl: "https://spot.test",
      token: "x",
      fetch,
      requestTimeoutMs: 10,
    });

    await expect(client.getMe()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("normalizes room discovery and drops malformed entries", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: "spot-1",
            name: "Lobby",
            slug: "lobby",
            roomId: "room-1",
            threadId: "thread-1",
            isDefault: true,
            isMeetingRoom: false,
            canAccess: true,
          },
          { id: "incomplete" },
        ]),
        { status: 200 },
      ),
    );
    const client = new SpotClient({ baseUrl: "https://spot.test", token: "x", fetch });

    await expect(client.getSpots("world one")).resolves.toEqual([
      expect.objectContaining({ id: "spot-1", threadId: "thread-1" }),
    ]);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://spot.test/api/world/world%20one/spots",
    );
  });

  it("preserves machine error codes without leaking the bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "spot_locked", message: "This room is locked." },
        }),
        { status: 423 },
      ),
    );
    const client = new SpotClient({
      baseUrl: "https://spot.test",
      token: "never-print-this",
      fetch,
    });

    const error = await client
      .joinAvatar("world-1", { spotId: "spot-1" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpotApiError);
    expect(error).toMatchObject({ status: 423, code: "spot_locked" });
    expect(String(error)).toContain("This room is locked.");
    expect(String(error)).not.toContain("never-print-this");
  });

  it("creates a DM through /api/dm", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: "dm-thread" }), { status: 201 }),
    );
    const client = new SpotClient({ baseUrl: "https://spot.test", token: "x", fetch });

    await expect(client.getOrCreateDm("user-2")).resolves.toEqual({ id: "dm-thread" });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://spot.test/api/dm");
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ userIds: ["user-2"] }),
    );
  });

  it("supports channel discovery, reply threads, typing, and reactions", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "channel-1",
              type: "Channel",
              name: "general",
              orgId: "org-1",
              isPrivate: false,
              spotId: null,
              parentEventId: null,
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "reply-1",
            type: "Event",
            name: null,
            orgId: "org-1",
            isPrivate: false,
            spotId: null,
            parentEventId: "event-1",
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: "reaction-1", userId: "bot", emoji: "👍" }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "event-1" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new SpotClient({ baseUrl: "https://spot.test", token: "x", fetch });

    await expect(client.getOrgThreads("org/1")).resolves.toHaveLength(1);
    await expect(client.getOrCreateEventThread("event/1")).resolves.toMatchObject({
      id: "reply-1",
    });
    await client.setThreadTyping("reply/1", false);
    await expect(client.getEventReactions("event/1")).resolves.toEqual([
      { id: "reaction-1", userId: "bot", emoji: "👍" },
    ]);
    await client.addEventReaction("event/1", "👍");
    await client.removeEventReaction("event/1", "reaction/1");

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://spot.test/api/org/org%2F1/threads",
      "https://spot.test/api/event/event%2F1/thread",
      "https://spot.test/api/thread/reply%2F1/typing",
      "https://spot.test/api/event/event%2F1/reactions",
      "https://spot.test/api/event/event%2F1/reactions",
      "https://spot.test/api/event/event%2F1/reactions/reaction%2F1",
    ]);
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ isEmpty: false }));
    expect(fetch.mock.calls[4]?.[1]?.body).toBe(JSON.stringify({ emoji: "👍" }));
    expect(fetch.mock.calls[5]?.[1]?.method).toBe("DELETE");
  });

  it("reads source events and threads for durable reply routing", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "event-1", threadId: "channel-1" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: "channel-1", type: "Channel" }),
          { status: 200 },
        ),
      );
    const client = new SpotClient({ baseUrl: "https://spot.test", token: "x", fetch });

    await expect(client.getEvent("event/1")).resolves.toMatchObject({
      threadId: "channel-1",
    });
    await expect(client.getThread("channel/1")).resolves.toMatchObject({
      type: "Channel",
    });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://spot.test/api/event/event%2F1",
      "https://spot.test/api/thread/channel%2F1",
    ]);
  });

  it("converts the REST base URL to the Agent Gateway WebSocket URL", () => {
    expect(
      new SpotClient({ baseUrl: "https://spot.test/a?x=1", token: "x" }).gatewayUrl(),
    ).toBe("wss://spot.test/api/agent/v1");
  });
});
