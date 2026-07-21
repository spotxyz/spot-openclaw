import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import {
  applySpotSubscriptionAck,
  avatarLeaseRenewalIntervalMs,
  BoundedKeyedTaskQueue,
  DEFAULT_SPOT_AVATAR_TTL_SECONDS,
  dispatchSpotMessage,
  reconnectDelayMs,
  resolveAvatarLeaseTtlSeconds,
  resolveSpotSubscribedThreads,
  runManagedAvatarLease,
  selectGatewayHealthIssue,
  shouldAcceptSpotEventFrame,
  shouldActivateSpotMessage,
  SpotHelloEventBuffer,
  subscribeSpotChannelLifecycle,
  subscribeSpotGatewayTargets,
  unsubscribeSpotChannelLifecycle,
} from "./gateway.js";
import type { SpotClient } from "./client.js";
import {
  resumeManagedAvatarLease,
  suppressManagedAvatarLease,
} from "./avatar-lease-state.js";
import type {
  ResolvedSpotAccount,
  SpotEventFrame,
  SpotMessageEvent,
} from "./types.js";

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
  monitorOrgChannels: false,
  ...patch,
});

const event = (patch: Partial<SpotMessageEvent> = {}): SpotMessageEvent => ({
  id: "event-1",
  threadId: "thread-1",
  thread: {
    id: "thread-1",
    type: "Spot",
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

  it("treats participant followups in an existing reply thread as actionable", () => {
    expect(
      shouldActivateSpotMessage(
        account({ activationMode: "mentions", allowFrom: ["user-1"] }),
        event({
          threadId: "reply-thread-1",
          thread: {
            ...event().thread,
            id: "reply-thread-1",
            type: "Event",
            parentEventId: "root-event-1",
          },
        }),
      ),
    ).toBe(true);
  });

  it("serializes each thread, runs different threads concurrently, and bounds backlog", async () => {
    const errors: unknown[] = [];
    const order: string[] = [];
    let releaseFirst!: () => void;
    let releaseOther!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const other = new Promise<void>((resolve) => {
      releaseOther = resolve;
    });
    const queue = new BoundedKeyedTaskQueue({
      concurrency: 2,
      capacity: 3,
      onError: (error) => errors.push(error),
    });
    expect(queue.enqueue("thread-1", async () => {
      order.push("first:start");
      await first;
      order.push("first:end");
    })).toBe(true);
    expect(queue.enqueue("thread-1", async () => {
      order.push("second");
      throw new Error("expected");
    })).toBe(true);
    expect(queue.enqueue("thread-2", async () => {
      order.push("other:start");
      await other;
      order.push("other:end");
    })).toBe(true);
    expect(queue.enqueue("thread-3", async () => undefined)).toBe(false);

    await vi.waitFor(() =>
      expect(order).toEqual(["first:start", "other:start"]),
    );
    releaseOther();
    await vi.waitFor(() => expect(order).toContain("other:end"));
    releaseFirst();

    await queue.drain();
    expect(order).toEqual([
      "first:start",
      "other:start",
      "other:end",
      "first:end",
      "second",
    ]);
    expect(errors).toHaveLength(1);
  });

  it("filters gateway events to a configured organization", () => {
    const frame = {
      op: "event" as const,
      seq: 1,
      type: "message.created",
      ts: "2026-07-20T12:00:00.000Z",
      orgId: "org-1",
      payload: {},
    };
    expect(shouldAcceptSpotEventFrame(account(), frame)).toBe(true);
    expect(
      shouldAcceptSpotEventFrame(account({ orgId: "org-1" }), frame),
    ).toBe(true);
    expect(
      shouldAcceptSpotEventFrame(account({ orgId: "org-2" }), frame),
    ).toBe(false);
    expect(
      shouldAcceptSpotEventFrame(account({ orgId: "org-2" }), {
        ...frame,
        orgId: null,
      }),
    ).toBe(true);
  });

  it("buffers events until hello establishes the self identity", () => {
    const buffer = new SpotHelloEventBuffer(2);
    const consumed: number[] = [];
    const consume = (frame: SpotEventFrame) => consumed.push(frame.seq);
    const frame = (seq: number): SpotEventFrame => ({
      op: "event",
      seq,
      type: "message.created",
      ts: "2026-07-20T12:00:00.000Z",
      orgId: "org-1",
      payload: {},
    });

    expect(buffer.push(frame(1), consume)).toBe(true);
    expect(buffer.push(frame(2), consume)).toBe(true);
    expect(buffer.push(frame(3), consume)).toBe(false);
    expect(consumed).toEqual([]);

    buffer.open(consume);
    expect(consumed).toEqual([1, 2]);
    expect(buffer.push(frame(4), consume)).toBe(true);
    expect(consumed).toEqual([1, 2, 4]);
  });

  it("combines configured threads with viewable organization channels", async () => {
    const client = {
      getOrgThreads: vi.fn().mockResolvedValue([
        { id: "channel-1", type: "Channel" },
        { id: "configured-1", type: "Channel" },
        { id: "reply-1", type: "Event" },
      ]),
    } as unknown as SpotClient;
    await expect(
      resolveSpotSubscribedThreads(
        client,
        account({
          orgId: "org-1",
          monitorOrgChannels: true,
          subscribeThreads: ["configured-1"],
        }),
      ),
    ).resolves.toEqual(["configured-1", "channel-1"]);
  });

  it("subscribes configured targets before optional org discovery settles", async () => {
    let rejectDiscovery!: (error: Error) => void;
    const discovery = new Promise<never>((_resolve, reject) => {
      rejectDiscovery = reject;
    });
    const ws = { send: vi.fn() };
    const subscription = subscribeSpotGatewayTargets({
      ws: ws as never,
      client: {
        getOrgThreads: vi.fn().mockReturnValue(discovery),
      },
      account: account({
        orgId: "org-1",
        worldId: "world-1",
        subscribeThreads: ["configured-1"],
        monitorOrgChannels: true,
      }),
      connectionId: "connection-1",
    });

    expect(ws.send).toHaveBeenCalledOnce();
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      op: "subscribe",
      id: "openclaw-connection-1",
      worlds: ["world-1"],
      threads: ["configured-1"],
    });
    rejectDiscovery(new Error("discovery unavailable"));
    await expect(subscription).rejects.toThrow("discovery unavailable");
  });

  it("adds discovered channels in a second subscription without duplicating configured ids", async () => {
    const ws = { send: vi.fn() };
    await subscribeSpotGatewayTargets({
      ws: ws as never,
      client: {
        getOrgThreads: vi.fn().mockResolvedValue([
          { id: "configured-1", type: "Channel" },
          { id: "channel-2", type: "Channel" },
          { id: "reply-1", type: "Event" },
        ]),
      },
      account: account({
        orgId: "org-1",
        subscribeThreads: ["configured-1"],
        monitorOrgChannels: true,
      }),
      connectionId: "connection-1",
    });

    expect(ws.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(ws.send.mock.calls[1]![0] as string)).toEqual({
      op: "subscribe",
      id: "openclaw-org-connection-1",
      threads: ["channel-2"],
    });
  });

  it("subscribes newly created viewable channels while monitoring is active", () => {
    const ws = { send: vi.fn() };
    const requestedThreadIds = new Set(["channel-1"]);
    const subscribed = subscribeSpotChannelLifecycle({
      ws: ws as never,
      account: account({
        orgId: "org-1",
        monitorOrgChannels: true,
      }),
      frame: {
        op: "event",
        seq: 42,
        type: "channel.created",
        ts: "2026-07-20T12:00:00.000Z",
        orgId: "org-1",
        payload: {
          thread: { id: "channel-2", type: "Channel" },
        },
      },
      requestedThreadIds,
    });

    expect(subscribed).toBe(true);
    expect(requestedThreadIds).toContain("channel-2");
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toEqual({
      op: "subscribe",
      id: "openclaw-channel-42",
      threads: ["channel-2"],
    });
  });

  it.each(["conversation.joined", "channel.updated"])(
    "re-subscribes a viewable channel on %s even when it was previously requested",
    (type) => {
      const ws = { send: vi.fn() };
      const requestedThreadIds = new Set(["channel-2"]);
      expect(
        subscribeSpotChannelLifecycle({
          ws: ws as never,
          account: account({ orgId: "org-1", monitorOrgChannels: true }),
          frame: {
            op: "event",
            seq: 44,
            type,
            ts: "2026-07-20T12:00:00.000Z",
            orgId: "org-1",
            payload: { thread: { id: "channel-2", type: "Channel" } },
          },
          requestedThreadIds,
        }),
      ).toBe(true);
      expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
        op: "subscribe",
        threads: ["channel-2"],
      });
    },
  );

  it("restores an explicitly selected private channel after the bot rejoins", () => {
    const ws = { send: vi.fn() };
    const requestedThreadIds = new Set<string>();
    expect(
      subscribeSpotChannelLifecycle({
        ws: ws as never,
        account: account({ subscribeThreads: ["private-channel-1"] }),
        frame: {
          op: "event",
          seq: 46,
          type: "conversation.joined",
          ts: "2026-07-20T12:00:00.000Z",
          orgId: "org-1",
          payload: {
            thread: { id: "private-channel-1", type: "Channel" },
          },
        },
        requestedThreadIds,
      }),
    ).toBe(true);
    expect(requestedThreadIds).toContain("private-channel-1");
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      op: "subscribe",
      threads: ["private-channel-1"],
    });
  });

  it("unsubscribes deleted channels so they do not consume subscription slots", () => {
    const ws = { send: vi.fn() };
    const requestedThreadIds = new Set(["channel-1", "channel-2"]);
    const unsubscribed = unsubscribeSpotChannelLifecycle({
      ws: ws as never,
      account: account({ orgId: "org-1", monitorOrgChannels: true }),
      frame: {
        op: "event",
        seq: 43,
        type: "channel.deleted",
        ts: "2026-07-20T12:00:00.000Z",
        orgId: "org-1",
        payload: { threadId: "channel-2" },
      },
      requestedThreadIds,
    });

    expect(unsubscribed).toBe(true);
    expect(requestedThreadIds).not.toContain("channel-2");
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toEqual({
      op: "unsubscribe",
      id: "openclaw-channel-43",
      threads: ["channel-2"],
    });
  });

  it("unsubscribes a private channel when the bot leaves it", () => {
    const ws = { send: vi.fn() };
    const requestedThreadIds = new Set(["private-channel-1"]);
    expect(
      unsubscribeSpotChannelLifecycle({
        ws: ws as never,
        account: account({ orgId: "org-1", monitorOrgChannels: true }),
        frame: {
          op: "event",
          seq: 45,
          type: "conversation.left",
          ts: "2026-07-20T12:00:00.000Z",
          orgId: "org-1",
          payload: {
            thread: { id: "private-channel-1", type: "Channel" },
          },
        },
        requestedThreadIds,
      }),
    ).toBe(true);
    expect(requestedThreadIds).not.toContain("private-channel-1");
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      op: "unsubscribe",
      threads: ["private-channel-1"],
    });
  });

  it("releases an explicitly selected private channel when the bot leaves it", () => {
    const ws = { send: vi.fn() };
    const requestedThreadIds = new Set(["private-channel-1"]);
    expect(
      unsubscribeSpotChannelLifecycle({
        ws: ws as never,
        account: account({ subscribeThreads: ["private-channel-1"] }),
        frame: {
          op: "event",
          seq: 47,
          type: "conversation.left",
          ts: "2026-07-20T12:00:00.000Z",
          orgId: "org-1",
          payload: {
            thread: { id: "private-channel-1", type: "Channel" },
          },
        },
        requestedThreadIds,
      }),
    ).toBe(true);
    expect(requestedThreadIds).not.toContain("private-channel-1");
    expect(JSON.parse(ws.send.mock.calls[0]![0] as string)).toMatchObject({
      op: "unsubscribe",
      threads: ["private-channel-1"],
    });
  });

  it("keeps earlier subscription rejections unhealthy across later successful acks", () => {
    const rejections = new Map<string, string>();
    expect(
      applySpotSubscriptionAck(rejections, {
        op: "ack",
        id: "first",
        subscribed: { threads: [], worlds: [] },
        rejected: [
          { kind: "thread", id: "channel-1", code: "limit_exceeded" },
        ],
      }),
    ).toContain("thread:channel-1 (limit_exceeded)");
    expect(
      applySpotSubscriptionAck(rejections, {
        op: "ack",
        id: "second",
        subscribed: { threads: ["channel-2"], worlds: [] },
        rejected: [],
      }),
    ).toContain("thread:channel-1 (limit_exceeded)");
    expect(
      applySpotSubscriptionAck(rejections, {
        op: "ack",
        id: "retry",
        subscribed: { threads: ["channel-1"], worlds: [] },
        rejected: [],
      }),
    ).toBeUndefined();
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
    const abortController = new AbortController();

    await dispatchSpotMessage({
      cfg: {} as OpenClawConfig,
      account: account(),
      runtime,
      client,
      event: event({ isDirectMessage: true }),
      signal: abortController.signal,
    });

    expect(sendThreadMessage).toHaveBeenCalledTimes(2);
    const chunks = sendThreadMessage.mock.calls.map((call) => call[1] as string);
    expect(chunks.every((chunk) => chunk.length <= 12_000)).toBe(true);
    expect(chunks.join("")).toBe(replyText);
    expect(runtime.routing.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ peer: { kind: "group", id: "thread-1" } }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          kind: "direct",
          routePeer: { kind: "group", id: "thread-1" },
        }),
      }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({ access: expect.objectContaining({ commands: { authorized: true } }) }),
    );
    expect(dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: expect.objectContaining({
          abortSignal: abortController.signal,
          onReplyStart: expect.any(Function),
          onTypingCleanup: expect.any(Function),
          typingKeepalive: true,
        }),
      }),
    );
    expect(sendThreadMessage).toHaveBeenCalledWith(
      "thread-1",
      expect.any(String),
      { signal: abortController.signal },
    );
    expect(dispatchReply).toHaveBeenCalledOnce();
  });

  it("keeps passive channel activity on the parent without typing or creating a reply thread", async () => {
    const buildContext = vi.fn((value: unknown) => value);
    const dispatchReply = vi.fn(async (options: Record<string, any>) => {
      expect(options.ctxPayload.message.inboundEventKind).toBe("room_event");
      expect(options.ctxPayload.reply).toMatchObject({
        to: "thread:channel-1",
        replyToId: "root-event-1",
        messageThreadId: "channel-1",
      });
      expect(options.replyOptions).toMatchObject({ suppressTyping: true });
    });
    const runtime = {
      routing: {
        resolveAgentRoute: vi.fn().mockReturnValue({
          agentId: "main",
          sessionKey: "agent:main:spot:group:channel-1",
        }),
      },
      inbound: { buildContext, dispatchReply },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    } as unknown as PluginRuntime["channel"];
    const client = {
      getOrCreateEventThread: vi.fn(),
      setThreadTyping: vi.fn(),
      sendThreadMessage: vi.fn(),
    } as unknown as SpotClient;

    await dispatchSpotMessage({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
      } as OpenClawConfig,
      account: account({ activationMode: "all", allowFrom: ["user-1"] }),
      runtime,
      client,
      event: event({
        id: "root-event-1",
        threadId: "channel-1",
        thread: {
          ...event().thread,
          id: "channel-1",
          type: "Channel",
          spotId: null,
        },
      }),
    });

    expect(client.getOrCreateEventThread).not.toHaveBeenCalled();
    expect(client.setThreadTyping).not.toHaveBeenCalled();
    expect(runtime.routing.resolveAgentRoute).toHaveBeenCalledOnce();
  });

  it("pre-creates a child for an actionable channel message, types on the visible parent, and replies in the child", async () => {
    const buildContext = vi.fn((value: unknown) => value);
    const sendThreadMessage = vi.fn().mockResolvedValue({ id: "reply-event-1" });
    const setThreadTyping = vi.fn().mockResolvedValue(undefined);
    const dispatchReply = vi.fn(async (options: Record<string, any>) => {
      expect(options.ctxPayload.message.inboundEventKind).toBe("user_request");
      expect(options.ctxPayload.reply).toMatchObject({
        to: "thread:reply-thread-1",
        messageThreadId: "reply-thread-1",
      });
      expect(options.ctxPayload.conversation).toMatchObject({
        id: "reply-thread-1",
        parentId: "channel-1",
      });
      expect(options.ctxPayload.route).toMatchObject({
        routeSessionKey: "agent:main:spot:group:reply-thread-1",
        parentSessionKey: "agent:main:spot:group:channel-1",
        modelParentSessionKey: "agent:main:spot:group:channel-1",
      });
      await options.replyOptions.onReplyStart();
      await options.delivery.deliver({ text: "reply" });
      options.replyOptions.onTypingCleanup();
    });
    const resolveAgentRoute = vi.fn(({ peer }: { peer: { id: string } }) => ({
      agentId: "main",
      sessionKey: `agent:main:spot:group:${peer.id}`,
    }));
    const runtime = {
      routing: { resolveAgentRoute },
      inbound: { buildContext, dispatchReply },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    } as unknown as PluginRuntime["channel"];
    const client = {
      getOrCreateEventThread: vi.fn().mockResolvedValue({ id: "reply-thread-1" }),
      setThreadTyping,
      sendThreadMessage,
    } as unknown as SpotClient;

    await dispatchSpotMessage({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
      } as OpenClawConfig,
      account: account({ activationMode: "all", allowFrom: ["user-1"] }),
      runtime,
      client,
      event: event({
        id: "root-event-1",
        threadId: "channel-1",
        isMentioned: true,
        thread: {
          ...event().thread,
          id: "channel-1",
          type: "Channel",
          spotId: null,
        },
      }),
    });

    expect(client.getOrCreateEventThread).toHaveBeenCalledWith("root-event-1", {
      signal: undefined,
    });
    expect(resolveAgentRoute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        peer: { kind: "group", id: "reply-thread-1" },
        parentPeer: { kind: "group", id: "channel-1" },
      }),
    );
    await vi.waitFor(() => {
      expect(setThreadTyping).toHaveBeenCalledWith("channel-1", false, {
        signal: undefined,
      });
      expect(setThreadTyping).toHaveBeenCalledWith("channel-1", true);
    });
    expect(
      setThreadTyping.mock.calls.every(([threadId]) => threadId === "channel-1"),
    ).toBe(true);
    expect(sendThreadMessage).toHaveBeenCalledWith(
      "reply-thread-1",
      "reply",
      { signal: undefined },
    );
  });

  it("links a reply-thread followup to the ambient root channel session", async () => {
    const buildContext = vi.fn((value: unknown) => value);
    const dispatchReply = vi.fn();
    const resolveAgentRoute = vi.fn(
      ({ peer }: { peer: { id: string } }) => ({
        agentId: "channel-agent",
        sessionKey: `agent:channel-agent:spot:group:${peer.id}`,
      }),
    );
    const runtime = {
      routing: { resolveAgentRoute },
      inbound: { buildContext, dispatchReply },
      session: {
        resolveStorePath: vi.fn().mockReturnValue("/tmp/sessions.json"),
        recordInboundSession: vi.fn(),
      },
      reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
    } as unknown as PluginRuntime["channel"];
    const client = {
      getEvent: vi.fn().mockResolvedValue({
        id: "root-event-1",
        threadId: "channel-1",
      }),
      getOrCreateEventThread: vi.fn(),
      setThreadTyping: vi.fn(),
      sendThreadMessage: vi.fn(),
    } as unknown as SpotClient;

    await dispatchSpotMessage({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
      } as OpenClawConfig,
      account: account({ activationMode: "all", allowFrom: ["user-1"] }),
      runtime,
      client,
      event: event({
        id: "root-event-1",
        threadId: "channel-1",
        thread: {
          ...event().thread,
          id: "channel-1",
          type: "Channel",
          spotId: null,
        },
      }),
    });
    await dispatchSpotMessage({
      cfg: {
        messages: { groupChat: { unmentionedInbound: "room_event" } },
      } as OpenClawConfig,
      account: account({ activationMode: "mentions", allowFrom: ["user-1"] }),
      runtime,
      client,
      event: event({
        id: "followup-event-1",
        threadId: "reply-thread-1",
        isMentioned: false,
        thread: {
          ...event().thread,
          id: "reply-thread-1",
          type: "Event",
          name: null,
          spotId: null,
          parentEventId: "root-event-1",
        },
      }),
    });

    expect(client.getEvent).toHaveBeenCalledWith("root-event-1", {
      signal: undefined,
    });
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        peer: { kind: "group", id: "reply-thread-1" },
        parentPeer: { kind: "group", id: "channel-1" },
      }),
    );
    expect(buildContext).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.objectContaining({
          id: "reply-thread-1",
          parentId: "channel-1",
        }),
        route: expect.objectContaining({
          routeSessionKey:
            "agent:channel-agent:spot:group:reply-thread-1",
          parentSessionKey: "agent:channel-agent:spot:group:channel-1",
          modelParentSessionKey:
            "agent:channel-agent:spot:group:channel-1",
        }),
      }),
    );
    const [rootContext, childContext] = buildContext.mock.calls.map(
      ([context]) => context as Record<string, any>,
    );
    expect(rootContext.route).toMatchObject({
      routeSessionKey: "agent:channel-agent:spot:group:channel-1",
    });
    expect(rootContext.route).not.toHaveProperty("parentSessionKey");
    expect(childContext.message.inboundEventKind).toBe("user_request");
    expect(childContext.reply.to).toBe("thread:reply-thread-1");
    expect(client.getOrCreateEventThread).not.toHaveBeenCalled();
  });
});

describe("managed Spot avatar lease", () => {
  it("does not rejoin while suppressed and wakes immediately after resume", async () => {
    const abortController = new AbortController();
    const controlled = createControlledDelay();
    const getAvatarState = vi.fn().mockResolvedValue({ joined: true });
    const joinAvatar = vi.fn().mockResolvedValue({ joined: true });
    const accountId = "lease-suppressed";

    const lease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      accountId,
      worldId: "world-1",
      avatar: { joinOnStart: true, ttlSeconds: 30 },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledOnce());
    await suppressManagedAvatarLease(accountId, "world-1");
    await vi.waitFor(() => expect(controlled.pendingCount()).toBe(0));
    expect(joinAvatar).toHaveBeenCalledOnce();

    resumeManagedAvatarLease(accountId, "world-1");
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(2));

    abortController.abort();
    await lease;
  });

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
      accountId: "lease-preserve",
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
    expect(getAvatarState).toHaveBeenCalledWith("world-1", {
      signal: abortController.signal,
    });
    expect(joinAvatar).toHaveBeenCalledWith("world-1", {
      ttlSeconds: DEFAULT_SPOT_AVATAR_TTL_SECONDS,
    }, { signal: abortController.signal });
    expect(controlled.delay).toHaveBeenCalledWith(
      300_000,
      expect.any(AbortSignal),
    );

    abortController.abort();
    await lease;
    expect(joinAvatar).toHaveBeenCalledOnce();
    expect(controlled.pendingCount()).toBe(0);

    const reconnectAbortController = new AbortController();
    const reconnectDelay = createControlledDelay();
    const reconnectedLease = runManagedAvatarLease({
      client: { getAvatarState, joinAvatar },
      accountId: "lease-preserve",
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
    }, { signal: reconnectAbortController.signal });
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
      accountId: "lease-startup",
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
    }, { signal: abortController.signal });
    expect(controlled.delay).toHaveBeenCalledWith(
      15_000,
      expect.any(AbortSignal),
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
      accountId: "lease-recovery",
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
      accountId: "lease-expiry",
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
    }, { signal: abortController.signal });
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledTimes(2));
    expect(joinAvatar).toHaveBeenNthCalledWith(2, "world-1", {
      spotId: "event-room",
      position: { x: 1, z: 2 },
      ttlSeconds: 60,
    }, { signal: abortController.signal });

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
      accountId: "lease-retry",
      worldId: "world-1",
      avatar: { joinOnStart: true, spotId: "event-room" },
      signal: abortController.signal,
      delay: controlled.delay,
    });

    await vi.waitFor(() => expect(controlled.delay).toHaveBeenCalledOnce());
    expect(controlled.delay).toHaveBeenCalledWith(
      30_000,
      expect.any(AbortSignal),
    );
    controlled.releaseNext();
    await vi.waitFor(() => expect(joinAvatar).toHaveBeenCalledOnce());
    expect(joinAvatar).toHaveBeenCalledWith("world-1", {
      spotId: "event-room",
      ttlSeconds: DEFAULT_SPOT_AVATAR_TTL_SECONDS,
    }, { signal: abortController.signal });

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
