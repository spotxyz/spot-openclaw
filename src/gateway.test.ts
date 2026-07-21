import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchSpotMessage,
  reconnectDelayMs,
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
