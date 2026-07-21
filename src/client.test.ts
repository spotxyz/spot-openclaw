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

  it("converts the REST base URL to the Agent Gateway WebSocket URL", () => {
    expect(
      new SpotClient({ baseUrl: "https://spot.test/a?x=1", token: "x" }).gatewayUrl(),
    ).toBe("wss://spot.test/api/agent/v1");
  });
});
