import type {
  ChannelGatewayContext,
  ChannelLogSink,
} from "openclaw/plugin-sdk/channel-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import { SpotClient } from "./client.js";
import { chunkSpotText } from "./outbound.js";
import { formatMissingSpotScopes, SPOT_SCOPE } from "./scopes.js";
import {
  SPOT_CHANNEL_ID,
  type ResolvedSpotAccount,
  type SpotEventFrame,
  type SpotHelloFrame,
  type SpotMessageEvent,
  type SpotMessagePayload,
  type SpotServerFrame,
} from "./types.js";

type SpotGatewayContext = ChannelGatewayContext<ResolvedSpotAccount>;
type SpotChannelRuntime = PluginRuntime["channel"];

export interface GatewayDependencies {
  createWebSocket?: (url: string, options: ClientOptions) => WebSocket;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError?: (error: unknown) => void) {}

  enqueue(task: () => Promise<void>): void {
    this.tail = this.tail
      .then(task)
      .catch((error) => this.onError?.(error));
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

class BoundedEventDeduper {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity = 2_048) {}

  hasOrAdd(id: string): boolean {
    if (this.ids.has(id)) return true;
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value as string | undefined;
      if (oldest) this.ids.delete(oldest);
    }
    return false;
  }
}

export const reconnectDelayMs = (
  attempt: number,
  random: () => number = Math.random,
): number => {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.8 + random() * 0.4));
};

const defaultDelay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });

const parseFrame = (raw: RawData): SpotServerFrame | null => {
  try {
    const value = JSON.parse(raw.toString()) as unknown;
    if (!value || typeof value !== "object") return null;
    const op = (value as { op?: unknown }).op;
    if (op !== "hello" && op !== "event" && op !== "ack" && op !== "error") {
      return null;
    }
    return value as SpotServerFrame;
  } catch {
    return null;
  }
};

const isMessagePayload = (value: unknown): value is SpotMessagePayload => {
  if (!value || typeof value !== "object") return false;
  const event = (value as { event?: unknown }).event;
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.threadId === "string" &&
    typeof record.userId === "string" &&
    typeof record.text === "string" &&
    typeof record.isMentioned === "boolean" &&
    typeof record.isDirectMessage === "boolean" &&
    !!record.thread &&
    typeof record.thread === "object"
  );
};

export const shouldActivateSpotMessage = (
  account: ResolvedSpotAccount,
  event: SpotMessageEvent,
  selfUserId?: string,
): boolean => {
  if (selfUserId && event.userId === selfUserId) return false;
  if (!account.allowBotMessages && event.user?.isBot) return false;
  if (
    !account.allowFrom.includes("*") &&
    !account.allowFrom.includes(event.userId)
  ) {
    return false;
  }
  switch (account.activationMode) {
    case "all":
      return true;
    case "mentions":
      return event.isMentioned;
    case "direct-or-mention":
      return event.isDirectMessage || event.isMentioned;
  }
};

const unique = (values: Array<string | undefined>): string[] => [
  ...new Set(values.filter((value): value is string => !!value)),
];

const subscribeAfterHello = (
  ws: WebSocket,
  account: ResolvedSpotAccount,
  hello: SpotHelloFrame,
): void => {
  const worlds = unique([account.worldId, ...account.subscribeWorlds]);
  const threads = unique(account.subscribeThreads);
  if (worlds.length === 0 && threads.length === 0) return;
  ws.send(
    JSON.stringify({
      op: "subscribe",
      id: `openclaw-${hello.connectionId}`,
      ...(worlds.length > 0 ? { worlds } : {}),
      ...(threads.length > 0 ? { threads } : {}),
    }),
  );
};

const updateStatus = (
  ctx: SpotGatewayContext,
  patch: Record<string, unknown>,
): void => {
  ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, ...patch });
};

export const dispatchSpotMessage = async (params: {
  cfg: SpotGatewayContext["cfg"];
  account: ResolvedSpotAccount;
  runtime: SpotChannelRuntime;
  client: SpotClient;
  event: SpotMessageEvent;
  log?: ChannelLogSink;
  onOutbound?: () => void;
}): Promise<void> => {
  const { cfg, account, runtime, client, event, log } = params;
  const isDirect = event.isDirectMessage;
  const peer = {
    kind: isDirect ? ("direct" as const) : ("group" as const),
    id: isDirect ? event.userId : event.threadId,
  };
  const route = runtime.routing.resolveAgentRoute({
    cfg,
    channel: SPOT_CHANNEL_ID,
    accountId: account.accountId,
    peer,
  });
  const senderName =
    event.user?.displayName || event.user?.fullName || event.userId;
  const conversationLabel =
    event.thread.name || (isDirect ? senderName : `Spot ${event.thread.spotId ?? event.threadId}`);
  const target = `thread:${event.threadId}`;
  const timestamp = Date.parse(event.timestamp);
  const context = runtime.inbound.buildContext({
    channel: SPOT_CHANNEL_ID,
    accountId: account.accountId,
    messageId: event.id,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
    from: `spot:${event.userId}`,
    sender: {
      id: event.userId,
      name: senderName,
      ...(event.user ? { isBot: event.user.isBot } : {}),
      isSelf: false,
    },
    conversation: {
      kind: isDirect ? "direct" : "group",
      id: event.threadId,
      label: conversationLabel,
      threadId: event.threadId,
      routePeer: peer,
    },
    route: {
      agentId: route.agentId,
      accountId: account.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: event.id,
      messageThreadId: event.threadId,
      sourceReplyDeliveryMode: "thread",
    },
    message: {
      rawBody: event.text,
      bodyForAgent: event.text,
      commandBody: event.text,
      senderLabel: senderName,
    },
    access: {
      mentions: {
        canDetectMention: true,
        wasMentioned: event.isMentioned,
        explicitlyMentionedBot: event.isMentioned,
        requireMention: account.activationMode === "mentions",
        effectiveWasMentioned: event.isMentioned,
        shouldSkip: false,
      },
    },
    extra: {
      Provider: SPOT_CHANNEL_ID,
      Surface: SPOT_CHANNEL_ID,
      WasMentioned: event.isMentioned,
      GroupSubject: isDirect ? undefined : conversationLabel,
      OriginatingChannel: SPOT_CHANNEL_ID,
      OriginatingTo: target,
    },
  });
  const storePath = runtime.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  await runtime.inbound.dispatchReply({
    cfg,
    channel: SPOT_CHANNEL_ID,
    accountId: account.accountId,
    agentId: route.agentId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload: context,
    recordInboundSession: runtime.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
    delivery: {
      durable: () => ({ to: target }),
      deliver: async (payload) => {
        const text = payload.text;
        if (!text) return { visibleReplySent: false };
        const messageIds: string[] = [];
        for (const chunk of chunkSpotText(text)) {
          const created = await client.sendThreadMessage(event.threadId, chunk);
          messageIds.push(created.id);
          params.onOutbound?.();
        }
        return {
          messageIds,
          threadId: event.threadId,
          visibleReplySent: true,
        };
      },
      onError: (error, info) =>
        log?.error(`Spot ${info.kind} reply failed: ${String(error)}`),
    },
    record: {
      onRecordError: (error) =>
        log?.warn(`Spot session metadata update failed: ${String(error)}`),
    },
  });
};

interface ConnectionResult {
  helloReceived: boolean;
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

const connectOnce = async (
  ctx: SpotGatewayContext,
  client: SpotClient,
  deduper: BoundedEventDeduper,
  createWebSocket: NonNullable<GatewayDependencies["createWebSocket"]>,
): Promise<ConnectionResult> => {
  const runtime = ctx.channelRuntime as SpotChannelRuntime | undefined;
  if (!runtime) {
    throw new Error("OpenClaw did not provide channelRuntime to the Spot plugin.");
  }
  const ws = createWebSocket(client.gatewayUrl(), {
    headers: client.authorizationHeaders(),
  });
  const state: {
    selfUserId?: string;
    lastSeq: number;
    helloReceived: boolean;
    lastError?: string;
    scopeIssue: string | undefined;
    subscriptionIssue: string | undefined;
    gatewayIssue: string | undefined;
    sequenceIssue: string | undefined;
  } = {
    lastSeq: 0,
    helloReceived: false,
    scopeIssue: undefined,
    subscriptionIssue: undefined,
    gatewayIssue: undefined,
    sequenceIssue: undefined,
  };
  const refreshGatewayHealth = (): void => {
    const issue =
      state.scopeIssue ??
      state.subscriptionIssue ??
      state.gatewayIssue ??
      state.sequenceIssue;
    if (issue) state.lastError = issue;
    updateStatus(ctx, {
      connected: !issue,
      running: true,
      ...(issue ? { lastError: issue } : { lastError: null }),
    });
  };
  const markGatewayIssue = (message: string): void => {
    state.gatewayIssue = message;
    state.lastError = message;
    updateStatus(ctx, { connected: false, running: true, lastError: message });
  };
  const queue = new SerialTaskQueue((error) => {
    ctx.log?.error(`Spot inbound processing failed: ${String(error)}`);
    markGatewayIssue(`Spot inbound processing failed: ${String(error)}`);
  });

  const handleFrame = async (frame: SpotServerFrame): Promise<void> => {
    if (frame.op === "hello") {
      state.helloReceived = true;
      state.selfUserId = frame.self.id;
      state.scopeIssue = formatMissingSpotScopes(ctx.account, frame.scopes);
      subscribeAfterHello(ws, ctx.account, frame);
      updateStatus(ctx, {
        lastConnectedAt: Date.now(),
      });
      refreshGatewayHealth();
      if (
        ctx.account.avatar?.joinOnStart &&
        ctx.account.worldId &&
        frame.scopes.includes(SPOT_SCOPE.AvatarWrite)
      ) {
        try {
          await client.joinAvatar(ctx.account.worldId, ctx.account.avatar);
        } catch (error) {
          const message = `Spot avatar auto-join failed: ${String(error)}`;
          ctx.log?.warn(message);
          state.gatewayIssue = message;
          refreshGatewayHealth();
        }
      }
      return;
    }
    if (frame.op === "ack") {
      if (frame.rejected.length > 0) {
        state.subscriptionIssue = `Spot rejected subscriptions: ${frame.rejected
          .map((item) => `${item.kind}:${item.id} (${item.code})`)
          .join(", ")}`;
        ctx.log?.warn(state.subscriptionIssue);
      } else {
        state.subscriptionIssue = undefined;
      }
      refreshGatewayHealth();
      return;
    }
    if (frame.op === "error") {
      state.gatewayIssue = `Spot Agent Gateway error ${frame.code}: ${frame.message}`;
      ctx.log?.warn(state.gatewayIssue);
      refreshGatewayHealth();
      return;
    }
    const eventFrame = frame as SpotEventFrame;
    if (state.lastSeq > 0 && eventFrame.seq !== state.lastSeq + 1) {
      state.sequenceIssue =
        `Spot Agent Gateway sequence gap: expected ${state.lastSeq + 1}, ` +
        `received ${eventFrame.seq}; delivery is at-most-once and this gap was not reconciled.`;
      ctx.log?.warn(state.sequenceIssue);
      refreshGatewayHealth();
    }
    state.lastSeq = eventFrame.seq;
    if (eventFrame.type !== "message.created" || !isMessagePayload(eventFrame.payload)) {
      return;
    }
    const event = eventFrame.payload.event;
    if (deduper.hasOrAdd(event.id)) return;
    if (!shouldActivateSpotMessage(ctx.account, event, state.selfUserId)) return;
    updateStatus(ctx, { lastInboundAt: Date.now(), lastEventAt: Date.now() });
    await dispatchSpotMessage({
      cfg: ctx.cfg,
      account: ctx.account,
      runtime,
      client,
      event,
      ...(ctx.log ? { log: ctx.log } : {}),
      onOutbound: () => updateStatus(ctx, { lastOutboundAt: Date.now() }),
    });
  };

  const result = await new Promise<ConnectionResult>((resolve) => {
    const onAbort = () => {
      try {
        ws.close(1000, "OpenClaw account stopped");
      } catch {
        ws.terminate();
      }
    };
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
    ws.on("message", (raw) => {
      const frame = parseFrame(raw);
      if (!frame) {
        ctx.log?.warn("Spot Agent Gateway sent an invalid frame.");
        return;
      }
      queue.enqueue(() => handleFrame(frame));
    });
    ws.on("error", (error) => {
      state.lastError = error.message;
    });
    ws.once("close", (code, reason) => {
      ctx.abortSignal.removeEventListener("abort", onAbort);
      resolve({
        helloReceived: state.helloReceived,
        closeCode: code,
        ...(reason.length > 0 ? { closeReason: reason.toString() } : {}),
        ...(state.lastError ? { error: state.lastError } : {}),
      });
    });
  });
  await queue.drain();
  return result;
};

export const startSpotGatewayAccount = async (
  ctx: SpotGatewayContext,
  dependencies: GatewayDependencies = {},
): Promise<void> => {
  const client = new SpotClient({
    baseUrl: ctx.account.baseUrl,
    token: ctx.account.token,
  });
  const createWebSocket =
    dependencies.createWebSocket ??
    ((url: string, options: ClientOptions) => new WebSocket(url, options));
  const delay = dependencies.delay ?? defaultDelay;
  const random = dependencies.random ?? Math.random;
  const deduper = new BoundedEventDeduper();
  let attempt = 0;
  updateStatus(ctx, {
    running: true,
    connected: false,
    lastStartAt: Date.now(),
    reconnectAttempts: 0,
  });

  while (!ctx.abortSignal.aborted) {
    let result: ConnectionResult;
    try {
      result = await connectOnce(ctx, client, deduper, createWebSocket);
    } catch (error) {
      result = { helloReceived: false, error: String(error) };
    }
    updateStatus(ctx, {
      connected: false,
      lastDisconnect: {
        at: Date.now(),
        ...(result.closeCode === undefined ? {} : { status: result.closeCode }),
        ...(result.error || result.closeReason
          ? { error: result.error ?? result.closeReason }
          : {}),
      },
    });
    if (ctx.abortSignal.aborted) break;
    attempt = result.helloReceived ? 0 : attempt + 1;
    const waitMs = reconnectDelayMs(attempt, random);
    updateStatus(ctx, { reconnectAttempts: attempt });
    ctx.log?.warn(`Spot Agent Gateway disconnected; reconnecting in ${waitMs}ms.`);
    await delay(waitMs, ctx.abortSignal);
  }

  updateStatus(ctx, {
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
};
