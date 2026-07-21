import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import {
  avatarLeaseRenewalIntervalMs,
  DEFAULT_SPOT_AVATAR_TTL_SECONDS,
  dispatchSpotMessage,
  reconnectDelayMs,
  resolveAvatarLeaseTtlSeconds,
  runManagedAvatarLease,
  selectGatewayHealthIssue,
  SerialTaskQueue,
  shouldActivateSpotMessage,
} from "./gateway.js";
import type { SpotClient } from "./client.js";
import type { ResolvedSpotAccount, SpotMessageEvent } from "./types.js";

const account = (
  patch: Partial<ResolvedSpotAccount> = {},
): ResolvedSpotAccount => ({
  accountId: "default",
  enabled: true,
  baseUrl: "https://spot.test",
  token: "token",
  activationMode: "direct-or-mention",
  allowFrom: [],
  allowBotMessages: false,
  subscribeWorlds: [],
  subscribeThreads: [],
  ...patch,
});

const event = (patch: Partial<SpotMessageEvent> = {}): SpotMessageEvent => ({
  id: "event-1",
  threadId: "thread-1",
  thread: {
    id: "thread-1",
    type: "spot",
    name: "Lobby",
    orgId: "org-1",
    isPrivate: false,
    spotId: "spot-1",
    parentEventId: null,
  },
  userId: "user-1",
  user: {
    id: "user-1",
    fullName: "Ada User",
    displayName: "Ada",
    isBot: false,
  },
  timestamp: "2026-07-20T12:00:00.000Z",
  message: "hello",
  text: "hello",
  attachedFiles: [],
  mentions: [],
  isMentioned: false,
  isDirectMessage: false,
  ...patch,
});

const createControlledDelay = () => {
  const pending: Array<() => void> = [];
  const delay = vi.fn((_milliseconds: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const finish = () => {
        const index = pending.indexOf(finish);
        if (index >= 0) pending.splice(index, 1);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      signal.addEventListener("abort", finish, { once: true });
      pending.push(finish);
    }),
  );
  return {
    delay,
    releaseNext: () => {
      const finish = pending[0];
      if (!finish) throw new Error("No avatar lease delay is pending.");
      finish();
    },
    pendingCount: () => pending.length,
  };
};

describe("Spot Agent Gateway policy", () => {
  it("fails closed, accepts exact ids, and requires an explicit wildcard to open", () => {
    expect(shouldActivateSpotMessage(account(), event({ isDirectMessage: true }))).toBe(
      false,
    );
    expect(
      shouldActivateSpotMessage(
        account({ allowFrom: ["user-1"] }),
        event({ isDirectMessage: true }),
      ),
    ).toBe(true);
    expect(
      shouldActivateSpotMessage(
        account({ allowFrom: ["another-user"] }),
        event({ isDirectMessage: true }),
      ),
    ).toBe(false);
    expect(
      shouldActivateSpotMessage(
        account({ allowFrom: ["*"] }),
        event({ isMentioned: true }),
      ),
    ).toBe(true);
  });

  it("filters self, bot, and non-allowlisted senders", () => {
    expect(
      shouldActivateSpotMessage(
        account({ activationMode: "all", allowFrom: ["*"] }),
        event(),
        "user-1",
      ),
    ).toBe(false);
    expect(
      shouldActivateSpotMessage(
        account({ activationMode: "all", allowFrom: ["*"] }),
        event({ user: { ...event().user!, isBot: true } }),
      ),
    ).toBe(false);
    expect(
      shouldActivateSpotMessage(
        account({ activationMode: "all", allowFrom: ["another-user"] }),
        event(),
      ),
    ).toBe(false);
  });

  it("processes queued events serially and continues after an error", async () => {
    const errors: unknown[] = [];
    const order: string[] = [];
    const queue = new SerialTaskQueue((error) => errors.push(error));
    queue.enqueue(async () => {
      await Promise.resolve();
      order.push("first");
    });
    queue.enqueue(async () => {
      order.push("second");
      throw new Error("expected");
    });
    queue.enqueue(async () => {
      order.push("third");
    });

    await queue.drain();
    expect(order).toEqual(["first", "second", "third"]);
    expect(errors).toHaveLength(1);
  });

  it("caps exponential reconnect delay and applies bounded jitter", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(1_000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(8_000);
    expect(reconnectDelayMs(99, () => 0.5)).toBe(30_000);
    expect(reconnectDelayMs(1, () => 0)).toBe(1_600);
    expect(reconnectDelayMs(1, () => 1)).toBe(2_400);
  });

  it("routes and delivers replies through the inbound thread id", async () => {
    const buildContext = vi.fn((value: unknown) => value);
    const replyText = "x".repeat(12_001);
    const sendThreadMessage = vi
      .fn()
      .mockResolvedValueOnce({ id: "reply-event-1" })
      .mockResolvedValueOnce({ id: "reply-event-2" });
    const dispatchReply = vi.fn(async (options: Record<string, any>) => {
      expect(options.ctxPayload.reply.to).toBe("thread:thread-1");
      expect(options.ctxPayload.extra).not.toHaveProperty("WorldId");
      expect(options.delivery.durable()).toEqual({ to: "thread:thread-1" });
      const receipt = await options.delivery.deliver({ text: replyText });
      expect(receipt).not.toHaveProperty("replyToId");
      expect(receipt.messageIds).toEqual(["reply-event-1", "reply-event-2"]);
    });
    const runtime = {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: "agent:main:spot:group:thread-1",
        }),
      },
      inbound: { buildContext, dispatchReply },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    } as unknown as PluginRuntime["channel"];
    const client = { sendThreadMessage } as unknown as SpotClient;

    await dispatchSpotMessage({
      cfg: {} as OpenClawConfig,
      account: account(),
      runtime,
      client,
      event: event({ isMentioned: true }),
    });

    expect(sendThreadMessage).toHaveBeenCalledTimes(2);
    const chunks = sendThreadMessage.mock.calls.map((call) => call[1] as string);
    expect(chunks.every((chunk) => chunk.length <= 12_000)).toBe(true);
    expect(chunks.join("")).toBe(replyText);
    expect(dispatchReply).toHaveBeenCalledOnce();
  });
});

describe("managed Spot avatar lease", () => {
  it("preserves an existing avatar across connection initialization and reconnect", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const getAvatarState = vi.fn().mockResolvedValue({
      joined: true,
      spotId: "patio",
      position: { x: 4, y: 0, z: 8 },
      facing: 1.25,
    });
    const joinAvatar = vi.fn().mockResolvedValue({ joined: true });

    const lease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      worldId: "world-1",
      avatar: {
        joinOnStart: true,
        spotId: "event-room",
        position: { x: 1, z: 2 },
      },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledOnce());
    expect(getAvatarState).toHaveBeenCalledWith("world-1");
    expect(joinAvatar).toHaveBeenCalledWith("world-1", {
      ttlSeconds: DEFAULT_SPOT_AVATAR_TTL_SECONDS,
    });
    expect(controlled.delay).toHaveBeenCalledWith(
      300_000,
      abortController.signal,
    );

    abortController.abort();
    await lease;
    expect(joinAvatar).toHaveBeenCalledOnce();
    expect(controlled.pendingCount()).toBe(0);

    const reconnectAbortController = new AbortController();
    const reconnectDelay = createControlledDelay();
    const reconnectedLease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      worldId: "world-1",
      avatar: {
        joinOnStart: true,
        spotId: "event-room",
        position: { x: 1, z: 2 },
      },
      signal: reconnectAbortController.signal,
      delay: reconnectDelay.delay,
    });

    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(2));
    expect(joinAvatar).toHaveBeenNthCalledWith(2, "world-1", {
      ttlSeconds: DEFAULT_SPOT_AVATAR_TTL_SECONDS,
    });
    reconnectAbortController.abort();
    await reconnectedLease;
  });

  it("uses the configured startup target only when the avatar is absent", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const getAvatarState = vi.fn().mockResolvedValue({ joined: false });
    const joinAvatar = vi.fn().mockResolvedValue({ joined: true });

    const lease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      worldId: "world-1",
      avatar: {
        joinOnStart: true,
        spotId: "event-room",
        position: { x: 1, z: 2 },
        facing: 0.75,
        ttlSeconds: 30,
      },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledOnce());
    expect(joinAvatar).toHaveBeenCalledWith("world-1", {
      spotId: "event-room",
      position: { x: 1, z: 2 },
      facing: 0.75,
      ttlSeconds: 30,
    });
    expect(controlled.delay).toHaveBeenCalledWith(
      15_000,
      abortController.signal,
    );

    abortController.abort();
    await lease;
  });

  it("reports renewal failures and clears only the lease issue after recovery", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const renewalError = new Error("temporary outage");
    const joinAvatar = vi
      .fn()
      .mockResolvedValueOnce({ joined: true })
      .mockRejectedValueOnce(renewalError)
      .mockResolvedValueOnce({ joined: true });
    const onIssue = vi.fn();
    const log = { warn: vi.fn() };

    const lease = runManagedAvatarLease({
      client: {
        getAvatarState: vi.fn().mockResolvedValue({ joined: true }),
        joinAvatar,
      },
      worldId: "world-1",
      avatar: { joinOnStart: true, ttlSeconds: 60 },
      signal: abortController.signal,
      delay: controlled.delay,
      log,
      onIssue,
    });

    await vi.waitFor(() => expect(controlled.pendingCount()).toBe(1));
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(2));
    expect(log.warn).toHaveBeenCalledWith(
      "Spot avatar lease renewal failed: Error: temporary outage",
    );
    const renewalIssue = onIssue.mock.calls.at(-1)?.[0] as string;
    expect(renewalIssue).toContain("lease renewal failed");
    expect(
      selectGatewayHealthIssue({
        gatewayIssue: "unrelated gateway failure",
        avatarLeaseIssue: renewalIssue,
      }),
    ).toBe("unrelated gateway failure");

    await vi.waitFor(() => expect(controlled.pendingCount()).toBe(1));
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(3));
    expect(onIssue).toHaveBeenLastCalledWith(undefined);
    expect(
      selectGatewayHealthIssue({
        gatewayIssue: "unrelated gateway failure",
        avatarLeaseIssue: undefined,
      }),
    ).toBe("unrelated gateway failure");

    abortController.abort();
    await lease;
  });

  it("reapplies the startup target if the avatar expires between renewals", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const getAvatarState = vi
      .fn()
      .mockResolvedValueOnce({ joined: true, spotId: "patio" })
      .mockResolvedValueOnce({ joined: false });
    const joinAvatar = vi.fn().mockResolvedValue({ joined: true });

    const lease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      worldId: "world-1",
      avatar: {
        joinOnStart: true,
        spotId: "event-room",
        position: { x: 1, z: 2 },
        ttlSeconds: 60,
      },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(controlled.pendingCount()).toBe(1));
    expect(joinAvatar).toHaveBeenNthCalledWith(1, "world-1", {
      ttlSeconds: 60,
    });
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(2));
    expect(joinAvatar).toHaveBeenNthCalledWith(2, "world-1", {
      spotId: "event-room",
      position: { x: 1, z: 2 },
      ttlSeconds: 60,
    });

    abortController.abort();
    await lease;
  });

  it("retries initialization failures within thirty seconds", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const getAvatarState = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce({ joined: false });
    const joinAvatar = vi.fn().mockResolvedValue({ joined: true });

    const lease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      worldId: "world-1",
      avatar: { joinOnStart: true, spotId: "event-room" },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(controlled.delay).toHaveBeenCalledOnce());
    expect(controlled.delay).toHaveBeenCalledWith(
      30_000,
      abortController.signal,
    );
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledOnce());
    expect(joinAvatar).toHaveBeenCalledWith("world-1", {
      spotId: "event-room",
      ttlSeconds: DEFAULT_SPOT_AVATAR_TTL_SECONDS,
    });

    abortController.abort();
    await lease;
  });

  it("uses the documented default, bounds, and half-life renewal interval", () => {
    expect(resolveAvatarLeaseTtlSeconds()).toBe(600);
    expect(resolveAvatarLeaseTtlSeconds(1)).toBe(30);
    expect(resolveAvatarLeaseTtlSeconds(9_999)).toBe(3_600);
    expect(avatarLeaseRenewalIntervalMs(30)).toBe(15_000);
    expect(avatarLeaseRenewalIntervalMs(600)).toBe(300_000);
  });
});
