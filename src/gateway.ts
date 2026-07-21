import type {
  ChannelGatewayContext,
  ChannelLogSink,
} from "openclaw/plugin-sdk/channel-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import {
  beginManagedAvatarLeaseAttempt,
  getManagedAvatarLeaseRevision,
  isManagedAvatarLeaseSuppressed,
  subscribeManagedAvatarLeaseChange,
} from "./avatar-lease-state.js";
import { SpotClient } from "./client.js";
import { chunkSpotText } from "./outbound.js";
import { formatMissingSpotScopes, SPOT_SCOPE } from "./scopes.js";
import {
  SPOT_CHANNEL_ID,
  type ResolvedSpotAccount,
  type SpotAvatarStartupConfig,
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
  avatarLeaseDelay?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  random?: () => number;
}

export const DEFAULT_SPOT_AVATAR_TTL_SECONDS = 600;
export const MIN_SPOT_AVATAR_TTL_SECONDS = 30;
export const MAX_SPOT_AVATAR_TTL_SECONDS = 3_600;
export const MAX_SPOT_AVATAR_RETRY_DELAY_MS = 30_000;
export const MAX_SPOT_INBOUND_CONCURRENCY = 4;
export const MAX_SPOT_INBOUND_BACKLOG = 256;

export class SpotHelloEventBuffer {
  private readonly frames: SpotEventFrame[] = [];
  private opened = false;

  constructor(private readonly capacity = MAX_SPOT_INBOUND_BACKLOG) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("Spot hello event buffer capacity must be a positive integer.");
    }
  }

  push(frame: SpotEventFrame, consume: (frame: SpotEventFrame) => void): boolean {
    if (this.opened) {
      consume(frame);
      return true;
    }
    if (this.frames.length >= this.capacity) return false;
    this.frames.push(frame);
    return true;
  }

  open(consume: (frame: SpotEventFrame) => void): void {
    if (this.opened) return;
    this.opened = true;
    for (const frame of this.frames.splice(0)) consume(frame);
  }
}

export const resolveAvatarLeaseTtlSeconds = (ttlSeconds?: number): number => {
  const resolved = ttlSeconds ?? DEFAULT_SPOT_AVATAR_TTL_SECONDS;
  if (!Number.isFinite(resolved)) return DEFAULT_SPOT_AVATAR_TTL_SECONDS;
  return Math.min(
    MAX_SPOT_AVATAR_TTL_SECONDS,
    Math.max(MIN_SPOT_AVATAR_TTL_SECONDS, Math.trunc(resolved)),
  );
};

export const avatarLeaseRenewalIntervalMs = (ttlSeconds?: number): number =>
  resolveAvatarLeaseTtlSeconds(ttlSeconds) * 500;

export class BoundedKeyedTaskQueue {
  private readonly queues = new Map<string, Array<() => Promise<void>>>();
  private readonly activeKeys = new Set<string>();
  private readonly readyKeys: string[] = [];
  private readonly drainWaiters = new Set<() => void>();
  private outstanding = 0;
  private closed = false;

  constructor(
    private readonly options: {
      concurrency: number;
      capacity: number;
      onError?: (error: unknown) => void;
    },
  ) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("Task queue concurrency must be a positive integer.");
    }
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new Error("Task queue capacity must be a positive integer.");
    }
  }

  enqueue(key: string, task: () => Promise<void>): boolean {
    if (this.closed || this.outstanding >= this.options.capacity) return false;
    const existing = this.queues.get(key);
    if (existing) {
      existing.push(task);
    } else {
      this.queues.set(key, [task]);
      this.readyKeys.push(key);
    }
    this.outstanding += 1;
    this.pump();
    return true;
  }

  close(): void {
    this.closed = true;
    this.cancelPending();
  }

  async drain(): Promise<void> {
    if (this.outstanding === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private cancelPending(): void {
    this.readyKeys.length = 0;
    for (const [key, tasks] of this.queues) {
      this.outstanding -= tasks.length;
      tasks.length = 0;
      if (!this.activeKeys.has(key)) this.queues.delete(key);
    }
    this.resolveDrainIfIdle();
  }

  private pump(): void {
    while (
      this.activeKeys.size < this.options.concurrency &&
      this.readyKeys.length > 0
    ) {
      const key = this.readyKeys.shift()!;
      if (this.activeKeys.has(key)) continue;
      const tasks = this.queues.get(key);
      const task = tasks?.shift();
      if (!tasks || !task) {
        this.queues.delete(key);
        continue;
      }
      this.activeKeys.add(key);
      void Promise.resolve()
        .then(task)
        .catch((error) => {
          try {
            this.options.onError?.(error);
          } catch {
            // A reporting failure must not stall the queue.
          }
        })
        .finally(() => {
          this.outstanding -= 1;
          this.activeKeys.delete(key);
          if ((this.queues.get(key)?.length ?? 0) > 0) {
            this.readyKeys.push(key);
          } else {
            this.queues.delete(key);
          }
          this.pump();
          this.resolveDrainIfIdle();
        });
    }
  }

  private resolveDrainIfIdle(): void {
    if (this.outstanding !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
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

export const runManagedAvatarLease = async (params: {
  client: Pick<SpotClient, "getAvatarState" | "joinAvatar">;
  accountId: string;
  worldId: string;
  avatar: SpotAvatarStartupConfig;
  signal: AbortSignal;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  log?: ChannelLogSink;
  onIssue?: (issue: string | undefined) => void;
}): Promise<void> => {
  const { client, accountId, worldId, avatar, signal, log, onIssue } = params;
  const delay = params.delay ?? defaultDelay;
  const ttlSeconds = resolveAvatarLeaseTtlSeconds(avatar.ttlSeconds);
  const renewalIntervalMs = avatarLeaseRenewalIntervalMs(ttlSeconds);
  const { joinOnStart: _joinOnStart, ...startupTarget } = avatar;
  let hasSucceeded = false;
  let waitBeforeAttempt = false;
  let nextDelayMs = renewalIntervalMs;

  const waitForDelayOrStateChange = async (milliseconds: number) => {
    const subscription = subscribeManagedAvatarLeaseChange(
      accountId,
      worldId,
      signal,
    );
    const delayController = new AbortController();
    const delaySignal = AbortSignal.any([signal, delayController.signal]);
    try {
      await Promise.race([
        delay(milliseconds, delaySignal),
        subscription.promise,
      ]);
    } finally {
      delayController.abort();
      subscription.dispose();
    }
  };

  while (!signal.aborted) {
    if (isManagedAvatarLeaseSuppressed(accountId, worldId)) {
      const subscription = subscribeManagedAvatarLeaseChange(
        accountId,
        worldId,
        signal,
      );
      try {
        if (isManagedAvatarLeaseSuppressed(accountId, worldId)) {
          await subscription.promise;
        }
      } finally {
        subscription.dispose();
      }
      waitBeforeAttempt = false;
      continue;
    }
    if (waitBeforeAttempt) {
      await waitForDelayOrStateChange(nextDelayMs);
      if (signal.aborted) return;
      if (isManagedAvatarLeaseSuppressed(accountId, worldId)) continue;
    }
    waitBeforeAttempt = true;

    const attemptRevision = getManagedAvatarLeaseRevision(accountId, worldId);
    const finishAttempt = beginManagedAvatarLeaseAttempt(accountId, worldId);
    if (!finishAttempt) {
      nextDelayMs = renewalIntervalMs;
      waitBeforeAttempt = false;
      continue;
    }

    try {
      const current = await client.getAvatarState(worldId, { signal });
      if (signal.aborted) return;
      await client.joinAvatar(
        worldId,
        current.joined ? { ttlSeconds } : { ...startupTarget, ttlSeconds },
        { signal },
      );
      hasSucceeded = true;
      nextDelayMs = renewalIntervalMs;
      if (signal.aborted) return;
      onIssue?.(undefined);
    } catch (error) {
      if (signal.aborted) return;
      const phase = hasSucceeded ? "renewal" : "initialization";
      const issue = `Spot avatar lease ${phase} failed: ${String(error)}`;
      nextDelayMs = Math.min(
        renewalIntervalMs,
        MAX_SPOT_AVATAR_RETRY_DELAY_MS,
      );
      log?.warn(issue);
      onIssue?.(issue);
    } finally {
      const stateChangedDuringAttempt =
        getManagedAvatarLeaseRevision(accountId, worldId) !== attemptRevision;
      finishAttempt();
      if (stateChangedDuringAttempt) waitBeforeAttempt = false;
    }
  }
};

export const shouldAcceptSpotEventFrame = (
  account: ResolvedSpotAccount,
  frame: SpotEventFrame,
): boolean =>
  !account.orgId || frame.orgId === null || frame.orgId === account.orgId;

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
  signal?: AbortSignal;
  log?: ChannelLogSink;
  onOutbound?: () => void;
}): Promise<void> => {
  const { cfg, account, runtime, client, event, log } = params;
  const isDirect = event.isDirectMessage;
  const peer = {
    kind: "group" as const,
    id: event.threadId,
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
      commands: {
        authorized: true,
      },
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
          const created = await client.sendThreadMessage(event.threadId, chunk, {
            signal: params.signal,
          });
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
    ...(params.signal ? { replyOptions: { abortSignal: params.signal } } : {}),
  });
};

interface ConnectionResult {
  helloReceived: boolean;
  closeCode?: number;
  closeReason?: string;
  error?: string;
}

export interface GatewayHealthIssues {
  scopeIssue?: string | undefined;
  subscriptionIssue?: string | undefined;
  gatewayIssue?: string | undefined;
  sequenceIssue?: string | undefined;
  avatarLeaseIssue?: string | undefined;
}

export const selectGatewayHealthIssue = (
  issues: GatewayHealthIssues,
): string | undefined =>
  issues.scopeIssue ??
  issues.subscriptionIssue ??
  issues.gatewayIssue ??
  issues.sequenceIssue ??
  issues.avatarLeaseIssue;

const connectOnce = async (
  ctx: SpotGatewayContext,
  client: SpotClient,
  deduper: BoundedEventDeduper,
  createWebSocket: NonNullable<GatewayDependencies["createWebSocket"]>,
  avatarLeaseDelay: NonNullable<GatewayDependencies["avatarLeaseDelay"]>,
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
    lastError: string | undefined;
    scopeIssue: string | undefined;
    subscriptionIssue: string | undefined;
    gatewayIssue: string | undefined;
    sequenceIssue: string | undefined;
    avatarLeaseIssue: string | undefined;
  } = {
    lastSeq: 0,
    helloReceived: false,
    lastError: undefined,
    scopeIssue: undefined,
    subscriptionIssue: undefined,
    gatewayIssue: undefined,
    sequenceIssue: undefined,
    avatarLeaseIssue: undefined,
  };
  const refreshGatewayHealth = (): void => {
    const issue = selectGatewayHealthIssue(state);
    state.lastError = issue;
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
  const queue = new BoundedKeyedTaskQueue({
    concurrency: MAX_SPOT_INBOUND_CONCURRENCY,
    capacity: MAX_SPOT_INBOUND_BACKLOG,
    onError: (error) => {
      ctx.log?.error(`Spot inbound processing failed: ${String(error)}`);
      markGatewayIssue(`Spot inbound processing failed: ${String(error)}`);
    },
  });
  const helloEventBuffer = new SpotHelloEventBuffer();
  const connectionController = new AbortController();
  let avatarLeaseTask: Promise<void> | undefined;

  const handleControlFrame = (
    frame: Exclude<SpotServerFrame, SpotEventFrame>,
  ): void => {
    if (frame.op === "hello") {
      state.helloReceived = true;
      state.selfUserId = frame.self.id;
      state.scopeIssue = formatMissingSpotScopes(ctx.account, frame.scopes);
      if (ctx.account.orgId && !frame.orgIds.includes(ctx.account.orgId)) {
        state.gatewayIssue =
          `Spot account is configured for organization ${ctx.account.orgId}, ` +
          "but the API token cannot access it.";
      }
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
        avatarLeaseTask ??= runManagedAvatarLease({
          client,
          accountId: ctx.account.accountId,
          worldId: ctx.account.worldId,
          avatar: ctx.account.avatar,
          signal: connectionController.signal,
          delay: avatarLeaseDelay,
          ...(ctx.log ? { log: ctx.log } : {}),
          onIssue: (issue) => {
            state.avatarLeaseIssue = issue;
            refreshGatewayHealth();
          },
        }).catch((error) => {
          if (connectionController.signal.aborted) return;
          const issue = `Spot avatar lease stopped unexpectedly: ${String(error)}`;
          ctx.log?.warn(issue);
          state.avatarLeaseIssue = issue;
          refreshGatewayHealth();
        });
      }
      helloEventBuffer.open(handleEventFrame);
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
  };

  const handleEventFrame = (eventFrame: SpotEventFrame): void => {
    if (state.lastSeq > 0 && eventFrame.seq !== state.lastSeq + 1) {
      state.sequenceIssue =
        `Spot Agent Gateway sequence gap: expected ${state.lastSeq + 1}, ` +
        `received ${eventFrame.seq}; delivery is at-most-once and this gap was not reconciled.`;
      ctx.log?.warn(state.sequenceIssue);
      refreshGatewayHealth();
    }
    state.lastSeq = eventFrame.seq;
    if (!shouldAcceptSpotEventFrame(ctx.account, eventFrame)) return;
    if (eventFrame.type !== "message.created" || !isMessagePayload(eventFrame.payload)) {
      return;
    }
    const event = eventFrame.payload.event;
    if (deduper.hasOrAdd(event.id)) return;
    if (!shouldActivateSpotMessage(ctx.account, event, state.selfUserId)) return;
    updateStatus(ctx, { lastInboundAt: Date.now(), lastEventAt: Date.now() });
    const accepted = queue.enqueue(event.threadId, () =>
      dispatchSpotMessage({
        cfg: ctx.cfg,
        account: ctx.account,
        runtime,
        client,
        event,
        signal: connectionController.signal,
        ...(ctx.log ? { log: ctx.log } : {}),
        onOutbound: () => updateStatus(ctx, { lastOutboundAt: Date.now() }),
      }),
    );
    if (!accepted) {
      const issue =
        `Spot inbound backlog reached ${MAX_SPOT_INBOUND_BACKLOG}; ` +
        `dropped message ${event.id} from thread ${event.threadId}.`;
      ctx.log?.error(issue);
      markGatewayIssue(issue);
    }
  };

  const result = await new Promise<ConnectionResult>((resolve) => {
    const onAbort = () => {
      connectionController.abort();
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
      if (frame.op === "event") {
        if (!helloEventBuffer.push(frame, handleEventFrame)) {
          const issue =
            `Spot Agent Gateway sent more than ${MAX_SPOT_INBOUND_BACKLOG} ` +
            "events before hello; excess events were dropped.";
          ctx.log?.error(issue);
          markGatewayIssue(issue);
        }
      } else {
        handleControlFrame(frame);
      }
    });
    ws.on("error", (error) => {
      state.gatewayIssue = `Spot Agent Gateway websocket error: ${error.message}`;
      refreshGatewayHealth();
    });
    ws.once("close", (code, reason) => {
      connectionController.abort();
      queue.close();
      ctx.abortSignal.removeEventListener("abort", onAbort);
      resolve({
        helloReceived: state.helloReceived,
        closeCode: code,
        ...(reason.length > 0 ? { closeReason: reason.toString() } : {}),
        ...(state.lastError ? { error: state.lastError } : {}),
      });
    });
    if (ctx.abortSignal.aborted) onAbort();
  });
  await queue.drain();
  await avatarLeaseTask;
  return result;
};

export const startSpotGatewayAccount = async (
  ctx: SpotGatewayContext,
  dependencies: GatewayDependencies = {},
): Promise<void> => {
  const client = new SpotClient({
    baseUrl: ctx.account.baseUrl,
    token: ctx.account.token,
    signal: ctx.abortSignal,
  });
  const createWebSocket =
    dependencies.createWebSocket ??
    ((url: string, options: ClientOptions) => new WebSocket(url, options));
  const delay = dependencies.delay ?? defaultDelay;
  const avatarLeaseDelay = dependencies.avatarLeaseDelay ?? defaultDelay;
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
      result = await connectOnce(
        ctx,
        client,
        deduper,
        createWebSocket,
        avatarLeaseDelay,
      );
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
