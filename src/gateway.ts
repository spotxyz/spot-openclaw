import type {
  ChannelGatewayContext,
  ChannelLogSink,
} from "openclaw/plugin-sdk/channel-contract";
import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-outbound";
import {
  classifyChannelInboundEvent,
  formatInboundMediaUnavailableText,
  resolveUnmentionedGroupInboundPolicy,
} from "openclaw/plugin-sdk/channel-inbound";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import WebSocket, { type ClientOptions, type RawData } from "ws";

import {
  beginManagedAvatarLeaseAttempt,
  getManagedAvatarLeaseRevision,
  isManagedAvatarLeaseSuppressed,
  subscribeManagedAvatarLeaseChange,
} from "./avatar-lease-state.js";
import {
  formatUnavailableSpotAttachments,
  hydrateSpotAttachedFiles,
  materializeSpotAttachedFiles,
} from "./attachments.js";
import { SpotClient } from "./client.js";
import { resolveSpotThreadActivationMode } from "./config.js";
import {
  createSpotHistoryCursorStore,
  type SpotHistoryCursorStore,
} from "./history-cursor-state.js";
import {
  resolveSpotHistoryThreadIds,
  SpotHistoryReconciler,
} from "./history-reconciler.js";
import { chunkSpotText } from "./outbound.js";
import { formatMissingSpotScopes, SPOT_SCOPE } from "./scopes.js";
import {
  SPOT_CHANNEL_ID,
  type ResolvedSpotAccount,
  type SpotAckFrame,
  type SpotAvatarStartupConfig,
  type SpotAvatarActivityPayload,
  type SpotEventFrame,
  type SpotMessageEvent,
  type SpotMessagePayload,
  type SpotOrgMember,
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
  historyCursorStore?: SpotHistoryCursorStore;
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
      throw new Error(
        "Spot hello event buffer capacity must be a positive integer.",
      );
    }
  }

  push(
    frame: SpotEventFrame,
    consume: (frame: SpotEventFrame) => void,
  ): boolean {
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

const defaultDelay = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
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
      nextDelayMs = Math.min(renewalIntervalMs, MAX_SPOT_AVATAR_RETRY_DELAY_MS);
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

const AVATAR_ACTIVITY_EVENT_TYPES = new Set([
  "avatar.entered",
  "avatar.left",
  "avatar.room_changed",
  "avatar.emoted",
  "avatar.gesture.requested",
  "avatar.gesture.cancelled",
  "avatar.gesture.completed",
]);

const isAvatarActivityPayload = (
  value: unknown,
): value is SpotAvatarActivityPayload => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.worldId === "string" &&
    typeof record.userId === "string" &&
    (record.spotId === undefined || typeof record.spotId === "string") &&
    (record.oldSpotId === undefined || typeof record.oldSpotId === "string")
  );
};

const getChannelLifecycleThreadId = (value: unknown): string | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const thread = (value as { thread?: unknown }).thread;
  if (!thread || typeof thread !== "object") return undefined;
  const record = thread as Record<string, unknown>;
  return record.type === "Channel" && typeof record.id === "string"
    ? record.id
    : undefined;
};

export const resolveSpotMessageActivationMode = (
  account: ResolvedSpotAccount,
  event: SpotMessageEvent,
): ResolvedSpotAccount["activationMode"] =>
  resolveSpotThreadActivationMode(account, event.threadId);

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
  if (event.thread.type === "Event" && event.thread.parentEventId) return true;
  switch (resolveSpotMessageActivationMode(account, event)) {
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

export const resolveSpotSubscribedThreads = async (
  client: Pick<SpotClient, "getOrgThreads">,
  account: ResolvedSpotAccount,
  options?: { signal?: AbortSignal },
): Promise<string[]> => {
  const configured = unique(account.subscribeThreads);
  if (!account.monitorOrgChannels) return configured;
  const channels = await client.getOrgThreads(account.orgId!, options);
  return unique([
    ...configured,
    ...channels
      .filter((thread) => thread.type === "Channel")
      .map((thread) => thread.id),
  ]);
};

const sendSubscription = (
  ws: WebSocket,
  id: string,
  targets: { worlds?: string[]; threads?: string[]; include?: string[] },
  op: "subscribe" | "unsubscribe" = "subscribe",
): void => {
  const worlds = unique(targets.worlds ?? []);
  const threads = unique(targets.threads ?? []);
  const include = unique(targets.include ?? []);
  if (worlds.length === 0 && threads.length === 0) return;
  ws.send(
    JSON.stringify({
      op,
      id,
      ...(worlds.length > 0 ? { worlds } : {}),
      ...(threads.length > 0 ? { threads } : {}),
      ...(include.length > 0 ? { include } : {}),
    }),
  );
};

export const subscribeSpotGatewayTargets = async (params: {
  ws: Pick<WebSocket, "send">;
  client: Pick<SpotClient, "getOrgThreads">;
  account: ResolvedSpotAccount;
  connectionId: string;
  requestedThreadIds?: Set<string>;
  signal?: AbortSignal;
}): Promise<Set<string>> => {
  const requestedThreadIds =
    params.requestedThreadIds ?? new Set(params.account.subscribeThreads);
  sendSubscription(params.ws as WebSocket, `openclaw-${params.connectionId}`, {
    worlds: unique([params.account.worldId, ...params.account.subscribeWorlds]),
    threads: [...requestedThreadIds],
    ...(params.account.monitorAvatarActivity
      ? { include: ["avatar-activity"] }
      : {}),
  });
  if (!params.account.monitorOrgChannels) return requestedThreadIds;
  const allThreads = await resolveSpotSubscribedThreads(
    params.client,
    params.account,
    params.signal ? { signal: params.signal } : undefined,
  );
  const discovered = allThreads.filter(
    (threadId) => !requestedThreadIds.has(threadId),
  );
  for (const threadId of discovered) requestedThreadIds.add(threadId);
  sendSubscription(
    params.ws as WebSocket,
    `openclaw-org-${params.connectionId}`,
    { threads: discovered },
  );
  return requestedThreadIds;
};

export const subscribeSpotChannelLifecycle = (params: {
  ws: Pick<WebSocket, "send">;
  account: ResolvedSpotAccount;
  frame: SpotEventFrame;
  requestedThreadIds: Set<string>;
}): boolean => {
  if (
    params.frame.type !== "channel.created" &&
    params.frame.type !== "channel.updated" &&
    params.frame.type !== "conversation.joined"
  ) {
    return false;
  }
  const threadId = getChannelLifecycleThreadId(params.frame.payload);
  if (
    !threadId ||
    (!params.account.monitorOrgChannels &&
      !params.account.subscribeThreads.includes(threadId))
  ) {
    return false;
  }
  params.requestedThreadIds.add(threadId);
  sendSubscription(
    params.ws as WebSocket,
    `openclaw-channel-${params.frame.seq}`,
    { threads: [threadId] },
  );
  return true;
};

export const unsubscribeSpotChannelLifecycle = (params: {
  ws: Pick<WebSocket, "send">;
  account: ResolvedSpotAccount;
  frame: SpotEventFrame;
  requestedThreadIds: Set<string>;
}): boolean => {
  if (
    (params.frame.type !== "channel.deleted" &&
      params.frame.type !== "conversation.left") ||
    !params.frame.payload ||
    typeof params.frame.payload !== "object"
  ) {
    return false;
  }
  const threadId =
    params.frame.type === "conversation.left"
      ? getChannelLifecycleThreadId(params.frame.payload)
      : (params.frame.payload as { threadId?: unknown }).threadId;
  if (
    typeof threadId !== "string" ||
    (!params.account.monitorOrgChannels &&
      !params.account.subscribeThreads.includes(threadId)) ||
    !params.requestedThreadIds.has(threadId)
  ) {
    return false;
  }
  params.requestedThreadIds.delete(threadId);
  sendSubscription(
    params.ws as WebSocket,
    `openclaw-channel-${params.frame.seq}`,
    { threads: [threadId] },
    "unsubscribe",
  );
  return true;
};

export const applySpotSubscriptionAck = (
  rejections: Map<string, string>,
  frame: SpotAckFrame,
): string | undefined => {
  for (const threadId of frame.subscribed.threads) {
    rejections.delete(`thread:${threadId}`);
  }
  for (const worldId of frame.subscribed.worlds) {
    rejections.delete(`world:${worldId}`);
  }
  for (const item of frame.rejected) {
    rejections.set(`${item.kind}:${item.id}`, item.code);
  }
  if (rejections.size === 0) return undefined;
  return `Spot rejected subscriptions: ${[...rejections]
    .map(([target, code]) => `${target} (${code})`)
    .join(", ")}`;
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
  let attachedFiles = event.attachedFiles;
  try {
    attachedFiles = await hydrateSpotAttachedFiles(client, event, {
      signal: params.signal,
    });
  } catch (error) {
    log?.warn(
      `Spot attachment metadata lookup failed for event ${event.id}: ${String(error)}`,
    );
  }
  const materializedAttachments = await materializeSpotAttachedFiles(
    runtime.media,
    attachedFiles,
    event.id,
    { signal: params.signal },
  );
  for (const { error } of materializedAttachments.errors) {
    log?.warn(
      `Spot attachment download failed for event ${event.id}: ${String(error)}`,
    );
  }
  const media = materializedAttachments.media;
  const unavailableAttachmentNotice =
    formatUnavailableSpotAttachments(materializedAttachments.unavailable);
  const bodyForAgent = unavailableAttachmentNotice
    ? formatInboundMediaUnavailableText({
        body: event.text,
        notice: unavailableAttachmentNotice,
      })
    : event.text;
  const isDirect = event.isDirectMessage;
  const isChannel = event.thread.type === "Channel";
  const isReplyThread =
    event.thread.type === "Event" && !!event.thread.parentEventId;
  const activationMode = resolveSpotMessageActivationMode(account, event);
  const initialPeer = {
    kind: "group" as const,
    id: event.threadId,
  };
  let replyParentPeer: { kind: "group"; id: string } | undefined;
  if (isReplyThread) {
    const parentEvent = await client.getEvent(event.thread.parentEventId!, {
      signal: params.signal,
    });
    if (!parentEvent.threadId) {
      throw new Error(
        "Spot returned a reply-thread parent without a thread id.",
      );
    }
    replyParentPeer = { kind: "group", id: parentEvent.threadId };
  }
  const replyParentRoute = replyParentPeer
    ? runtime.routing.resolveAgentRoute({
        cfg,
        channel: SPOT_CHANNEL_ID,
        accountId: account.accountId,
        peer: replyParentPeer,
      })
    : undefined;
  const initialRoute = runtime.routing.resolveAgentRoute({
    cfg,
    channel: SPOT_CHANNEL_ID,
    accountId: account.accountId,
    peer: initialPeer,
    ...(replyParentPeer ? { parentPeer: replyParentPeer } : {}),
  });
  const inboundEventKind = classifyChannelInboundEvent({
    conversation: { kind: isDirect ? "direct" : "group" },
    unmentionedGroupPolicy: resolveUnmentionedGroupInboundPolicy({
      cfg,
      agentId: initialRoute.agentId,
    }),
    wasMentioned: event.isMentioned || isReplyThread,
  });
  let deliveryThreadId = event.threadId;
  if (isChannel && inboundEventKind === "user_request") {
    const replyThread = await client.getOrCreateEventThread(event.id, {
      signal: params.signal,
    });
    if (!replyThread.id) {
      throw new Error(
        "Spot created the channel reply thread but returned no thread id.",
      );
    }
    deliveryThreadId = replyThread.id;
  }
  const peer = {
    kind: "group" as const,
    id: deliveryThreadId,
  };
  const route =
    deliveryThreadId === event.threadId
      ? initialRoute
      : runtime.routing.resolveAgentRoute({
          cfg,
          channel: SPOT_CHANNEL_ID,
          accountId: account.accountId,
          peer,
          parentPeer: initialPeer,
        });
  const parentRoute =
    replyParentRoute ??
    (isChannel && deliveryThreadId !== event.threadId
      ? initialRoute
      : undefined);
  const parentPeer =
    replyParentPeer ??
    (isChannel && deliveryThreadId !== event.threadId
      ? initialPeer
      : undefined);
  const sessionParentRoute =
    parentRoute && parentRoute.sessionKey !== route.sessionKey
      ? parentRoute
      : undefined;
  const senderName =
    event.user?.displayName || event.user?.fullName || event.userId;
  const conversationLabel =
    event.thread.name ||
    (isDirect ? senderName : `Spot ${event.thread.spotId ?? event.threadId}`);
  const target = `thread:${deliveryThreadId}`;
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
      id: deliveryThreadId,
      label: conversationLabel,
      threadId: deliveryThreadId,
      ...(parentPeer ? { parentId: parentPeer.id } : {}),
      routePeer: peer,
    },
    route: {
      agentId: route.agentId,
      accountId: account.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
      ...(sessionParentRoute
        ? {
            parentSessionKey: sessionParentRoute.sessionKey,
            modelParentSessionKey: sessionParentRoute.sessionKey,
          }
        : {}),
    },
    reply: {
      to: target,
      originatingTo: target,
      replyToId: event.id,
      messageThreadId: deliveryThreadId,
      sourceReplyDeliveryMode: "thread",
    },
    message: {
      rawBody: event.text,
      bodyForAgent,
      commandBody: event.text,
      senderLabel: senderName,
      inboundEventKind,
    },
    ...(media.length > 0 ? { media } : {}),
    access: {
      commands: {
        authorized: true,
      },
      mentions: {
        canDetectMention: true,
        wasMentioned: event.isMentioned,
        explicitlyMentionedBot: event.isMentioned,
        requireMention: activationMode === "mentions" && !isReplyThread,
        effectiveWasMentioned: event.isMentioned || isReplyThread,
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
  const typingCallbacks =
    inboundEventKind === "user_request"
      ? createTypingCallbacks({
          start: () =>
            client.setThreadTyping(
              isChannel ? event.threadId : deliveryThreadId,
              false,
              {
                signal: params.signal,
              },
            ),
          stop: () =>
            client.setThreadTyping(
              isChannel ? event.threadId : deliveryThreadId,
              true,
            ),
          onStartError: (error) =>
            log?.warn(`Spot typing indicator failed: ${String(error)}`),
          onStopError: (error) =>
            log?.warn(`Spot typing cleanup failed: ${String(error)}`),
        })
      : undefined;

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
          const created = await client.sendThreadMessage(
            deliveryThreadId,
            chunk,
            {
              signal: params.signal,
            },
          );
          messageIds.push(created.id);
          params.onOutbound?.();
        }
        return {
          messageIds,
          threadId: deliveryThreadId,
          visibleReplySent: true,
        };
      },
      onError: (error, info) =>
        log?.error(`Spot ${info.kind} reply failed: ${String(error)}`),
    },
    ...(typingCallbacks
      ? {
          // The buffered dispatcher owns reply lifecycle callbacks. Passing
          // typing through dispatcherOptions lets it start at model-run time
          // even when visible room replies are sent with the message tool.
          dispatcherOptions: { typingCallbacks },
        }
      : {}),
    record: {
      onRecordError: (error) =>
        log?.warn(`Spot session metadata update failed: ${String(error)}`),
    },
    replyOptions: {
      ...(params.signal ? { abortSignal: params.signal } : {}),
      ...(typingCallbacks
        ? {
            // createTypingCallbacks owns the 3s keepalive and 60s TTL.
            typingKeepalive: false,
          }
        : { suppressTyping: true }),
    },
  });
};

const formatSpotAvatarActivity = (
  type: string,
  payload: SpotAvatarActivityPayload,
  senderName: string,
  roomName: string,
): string => {
  switch (type) {
    case "avatar.entered":
      return `${senderName} entered ${roomName}.`;
    case "avatar.left":
      return `${senderName} left ${roomName}.`;
    case "avatar.room_changed":
      return `${senderName} moved into ${roomName}.`;
    case "avatar.emoted": {
      const details = [
        payload.animation ? `animation ${payload.animation}` : undefined,
        payload.emojiName ? `emoji :${payload.emojiName}:` : undefined,
      ].filter(Boolean);
      return `${senderName} used an avatar emote${
        details.length > 0 ? ` (${details.join(", ")})` : ""
      } in ${roomName}.`;
    }
    case "avatar.gesture.requested":
      return `${senderName} requested ${
        payload.gesture ?? "a social gesture"
      } in ${roomName}. The requester user id is ${payload.userId}.`;
    case "avatar.gesture.cancelled":
      return `${senderName} cancelled their social gesture in ${roomName}.`;
    case "avatar.gesture.completed":
      return `${senderName}'s ${
        payload.gesture ?? "social gesture"
      } was completed in ${roomName}.`;
    default:
      return `${senderName} had avatar activity in ${roomName}.`;
  }
};

export const dispatchSpotAvatarActivity = async (params: {
  cfg: SpotGatewayContext["cfg"];
  account: ResolvedSpotAccount;
  runtime: SpotChannelRuntime;
  client: SpotClient;
  frame: SpotEventFrame;
  payload: SpotAvatarActivityPayload;
  selfUserId?: string;
  signal?: AbortSignal;
  log?: ChannelLogSink;
  onOutbound?: () => void;
  resolveMember?: (
    orgId: string,
    userId: string,
    signal?: AbortSignal,
  ) => Promise<SpotOrgMember | undefined>;
}): Promise<boolean> => {
  const { account, client, frame, payload } = params;
  if (
    !account.monitorAvatarActivity ||
    payload.userId === params.selfUserId ||
    payload.completerUserId === params.selfUserId
  ) {
    return false;
  }
  if (
    !account.allowFrom.includes("*") &&
    !account.allowFrom.includes(payload.userId)
  ) {
    return false;
  }

  const rooms = await client.getSpots(payload.worldId, {
    signal: params.signal,
  });
  const roomSpotId = payload.spotId ?? payload.oldSpotId;
  const room = rooms.find((candidate) => candidate.id === roomSpotId);
  if (!room) {
    params.log?.warn(
      `Spot avatar activity ${frame.type} referenced an unknown room.`,
    );
    return false;
  }
  const orgId = account.orgId ?? frame.orgId ?? undefined;
  const member = orgId
    ? params.resolveMember
      ? await params.resolveMember(orgId, payload.userId, params.signal)
      : (await client.getOrgMembers(orgId, { signal: params.signal })).find(
          (candidate) => candidate.userId === payload.userId,
        )
    : undefined;
  if (!account.allowBotMessages && member?.isBot) {
    return false;
  }
  const senderName = member?.displayName || member?.fullName || payload.userId;
  const text = formatSpotAvatarActivity(
    frame.type,
    payload,
    senderName,
    room.name,
  );
  const event: SpotMessageEvent = {
    id: `avatar-activity:${payload.worldId}:${frame.seq}`,
    threadId: room.threadId,
    thread: {
      id: room.threadId,
      type: "Spot",
      name: room.name,
      orgId: orgId ?? null,
      isPrivate: false,
      spotId: room.id,
      parentEventId: null,
    },
    userId: payload.userId,
    user: member
      ? {
          id: member.userId,
          fullName: member.fullName,
          displayName: member.displayName,
          isBot: member.isBot,
        }
      : null,
    timestamp: frame.ts,
    message: text,
    text,
    attachedFiles: [],
    mentions: [],
    isMentioned: false,
    isDirectMessage: false,
  };
  await dispatchSpotMessage({
    cfg: params.cfg,
    account,
    runtime: params.runtime,
    client,
    event,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.onOutbound ? { onOutbound: params.onOutbound } : {}),
  });
  return true;
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
  channelDiscoveryIssue?: string | undefined;
  gatewayIssue?: string | undefined;
  sequenceIssue?: string | undefined;
  historyIssue?: string | undefined;
  avatarLeaseIssue?: string | undefined;
}

export const selectGatewayHealthIssue = (
  issues: GatewayHealthIssues,
): string | undefined =>
  issues.scopeIssue ??
  issues.subscriptionIssue ??
  issues.channelDiscoveryIssue ??
  issues.gatewayIssue ??
  issues.sequenceIssue ??
  issues.historyIssue ??
  issues.avatarLeaseIssue;

const connectOnce = async (
  ctx: SpotGatewayContext,
  client: SpotClient,
  deduper: BoundedEventDeduper,
  createWebSocket: NonNullable<GatewayDependencies["createWebSocket"]>,
  avatarLeaseDelay: NonNullable<GatewayDependencies["avatarLeaseDelay"]>,
  historyCursorStore: SpotHistoryCursorStore,
): Promise<ConnectionResult> => {
  const runtime = ctx.channelRuntime as SpotChannelRuntime | undefined;
  if (!runtime) {
    throw new Error(
      "OpenClaw did not provide channelRuntime to the Spot plugin.",
    );
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
    channelDiscoveryIssue: string | undefined;
    gatewayIssue: string | undefined;
    sequenceIssue: string | undefined;
    historyIssue: string | undefined;
    avatarLeaseIssue: string | undefined;
  } = {
    lastSeq: 0,
    helloReceived: false,
    lastError: undefined,
    scopeIssue: undefined,
    subscriptionIssue: undefined,
    channelDiscoveryIssue: undefined,
    gatewayIssue: undefined,
    sequenceIssue: undefined,
    historyIssue: undefined,
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
  const requestedThreadIds = new Set(ctx.account.subscribeThreads);
  const subscriptionRejections = new Map<string, string>();
  const memberDirectories = new Map<
    string,
    { expiresAt: number; members: Promise<SpotOrgMember[]> }
  >();
  let avatarLeaseTask: Promise<void> | undefined;
  let historyReconciler: SpotHistoryReconciler | undefined;
  let reconciliationTask: Promise<void> | undefined;

  const resolveAvatarActivityMember = async (
    orgId: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<SpotOrgMember | undefined> => {
    let directory = memberDirectories.get(orgId);
    if (!directory || directory.expiresAt <= Date.now()) {
      const members = client.getOrgMembers(orgId, { signal }).catch((error) => {
        memberDirectories.delete(orgId);
        throw error;
      });
      directory = { expiresAt: Date.now() + 60_000, members };
      memberDirectories.set(orgId, directory);
    }
    return (await directory.members).find((member) => member.userId === userId);
  };

  const processSpotMessage = async (event: SpotMessageEvent): Promise<void> => {
    if (deduper.hasOrAdd(event.id)) return;
    if (!shouldActivateSpotMessage(ctx.account, event, state.selfUserId))
      return;
    updateStatus(ctx, { lastInboundAt: Date.now(), lastEventAt: Date.now() });
    await dispatchSpotMessage({
      cfg: ctx.cfg,
      account: ctx.account,
      runtime,
      client,
      event,
      signal: connectionController.signal,
      ...(ctx.log ? { log: ctx.log } : {}),
      onOutbound: () => updateStatus(ctx, { lastOutboundAt: Date.now() }),
    });
  };

  const enqueueSpotMessage = (
    event: SpotMessageEvent,
    advanceCursor: boolean,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const accepted = queue.enqueue(event.threadId, async () => {
        try {
          await processSpotMessage(event);
          if (advanceCursor && event.cursor) {
            await historyCursorStore.set(event.threadId, event.cursor);
          }
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      });
      if (!accepted) {
        const issue =
          `Spot inbound backlog reached ${MAX_SPOT_INBOUND_BACKLOG}; ` +
          `dropped message ${event.id} from thread ${event.threadId}.`;
        ctx.log?.error(issue);
        markGatewayIssue(issue);
        reject(new Error(issue));
      }
    });

  const enqueueSpotAvatarActivity = (
    frame: SpotEventFrame,
    payload: SpotAvatarActivityPayload,
  ): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const key = `avatar:${payload.worldId}:${payload.spotId ?? payload.oldSpotId ?? "world"}`;
      const accepted = queue.enqueue(key, async () => {
        try {
          const dispatched = await dispatchSpotAvatarActivity({
            cfg: ctx.cfg,
            account: ctx.account,
            runtime,
            client,
            frame,
            payload,
            ...(state.selfUserId ? { selfUserId: state.selfUserId } : {}),
            signal: connectionController.signal,
            ...(ctx.log ? { log: ctx.log } : {}),
            resolveMember: resolveAvatarActivityMember,
            onOutbound: () => updateStatus(ctx, { lastOutboundAt: Date.now() }),
          });
          if (dispatched) {
            updateStatus(ctx, {
              lastInboundAt: Date.now(),
              lastEventAt: Date.now(),
            });
          }
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      });
      if (!accepted) {
        const issue =
          `Spot inbound backlog reached ${MAX_SPOT_INBOUND_BACKLOG}; ` +
          `dropped avatar activity ${frame.type} from ${payload.userId}.`;
        ctx.log?.error(issue);
        markGatewayIssue(issue);
        reject(new Error(issue));
      }
    });

  const reconcileKnownThreads = (): Promise<void> => {
    if (reconciliationTask) return reconciliationTask;
    if (!historyReconciler) return Promise.resolve();
    reconciliationTask = (async () => {
      const threadIds = await resolveSpotHistoryThreadIds({
        client,
        account: ctx.account,
        subscribedThreadIds: requestedThreadIds,
        options: { signal: connectionController.signal },
        ...(ctx.log ? { log: ctx.log } : {}),
      });
      const replayed = await historyReconciler!.reconcileThreads(threadIds);
      if (replayed > 0) {
        ctx.log?.info(`Spot replayed ${replayed} missed message(s).`);
      }
      state.sequenceIssue = undefined;
      state.historyIssue = undefined;
      refreshGatewayHealth();
    })()
      .catch((error) => {
        if (connectionController.signal.aborted) return;
        state.historyIssue = `Spot history reconciliation failed: ${String(
          error,
        )}`;
        ctx.log?.warn(state.historyIssue);
        refreshGatewayHealth();
      })
      .finally(() => {
        reconciliationTask = undefined;
      });
    return reconciliationTask;
  };

  const handleControlFrame = (
    frame: Exclude<SpotServerFrame, SpotEventFrame>,
  ): void => {
    if (frame.op === "hello") {
      state.helloReceived = true;
      state.selfUserId = frame.self.id;
      historyReconciler = new SpotHistoryReconciler({
        client,
        selfUserId: frame.self.id,
        cursorStore: historyCursorStore,
        handleEvent: (event) => enqueueSpotMessage(event, false),
        options: { signal: connectionController.signal },
      });
      state.scopeIssue = formatMissingSpotScopes(ctx.account, frame.scopes);
      if (ctx.account.orgId && !frame.orgIds.includes(ctx.account.orgId)) {
        state.gatewayIssue =
          `Spot account is configured for organization ${ctx.account.orgId}, ` +
          "but the API token cannot access it.";
      }
      void subscribeSpotGatewayTargets({
        ws,
        client,
        account: ctx.account,
        connectionId: frame.connectionId,
        requestedThreadIds,
        signal: connectionController.signal,
      })
        .then(() => {
          state.channelDiscoveryIssue = undefined;
          refreshGatewayHealth();
        })
        .catch((error) => {
          if (connectionController.signal.aborted) return;
          state.channelDiscoveryIssue = `Spot organization channel discovery failed: ${String(
            error,
          )}`;
          ctx.log?.warn(state.channelDiscoveryIssue);
          refreshGatewayHealth();
        })
        .then(() => reconcileKnownThreads())
        .finally(() => {
          helloEventBuffer.open(handleEventFrame);
        });
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
          const issue = `Spot avatar lease stopped unexpectedly: ${String(
            error,
          )}`;
          ctx.log?.warn(issue);
          state.avatarLeaseIssue = issue;
          refreshGatewayHealth();
        });
      }
      return;
    }
    if (frame.op === "ack") {
      state.subscriptionIssue = applySpotSubscriptionAck(
        subscriptionRejections,
        frame,
      );
      if (state.subscriptionIssue) {
        ctx.log?.warn(state.subscriptionIssue);
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
    let sequenceGap = false;
    if (state.lastSeq > 0 && eventFrame.seq !== state.lastSeq + 1) {
      sequenceGap = true;
      state.sequenceIssue =
        `Spot Agent Gateway sequence gap: expected ${state.lastSeq + 1}, ` +
        `received ${eventFrame.seq}; reconciling known room and thread history.`;
      ctx.log?.warn(state.sequenceIssue);
      refreshGatewayHealth();
      void reconcileKnownThreads();
    }
    state.lastSeq = eventFrame.seq;
    if (!shouldAcceptSpotEventFrame(ctx.account, eventFrame)) return;
    const channelLifecycleParams = {
      ws,
      account: ctx.account,
      frame: eventFrame,
      requestedThreadIds,
    };
    if (subscribeSpotChannelLifecycle(channelLifecycleParams)) {
      void reconcileKnownThreads();
      return;
    }
    if (unsubscribeSpotChannelLifecycle(channelLifecycleParams)) {
      return;
    }
    if (AVATAR_ACTIVITY_EVENT_TYPES.has(eventFrame.type)) {
      if (isAvatarActivityPayload(eventFrame.payload)) {
        void enqueueSpotAvatarActivity(eventFrame, eventFrame.payload).catch(
          () => {},
        );
      }
      return;
    }
    if (
      eventFrame.type !== "message.created" ||
      !isMessagePayload(eventFrame.payload)
    ) {
      return;
    }
    const event = eventFrame.payload.event;
    void enqueueSpotMessage(event, !sequenceGap && !state.sequenceIssue).catch(
      () => {},
    );
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
  const historyCursorStore =
    dependencies.historyCursorStore ??
    createSpotHistoryCursorStore(ctx.account.accountId);
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
        historyCursorStore,
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
    ctx.log?.warn(
      `Spot Agent Gateway disconnected; reconnecting in ${waitMs}ms.`,
    );
    await delay(waitMs, ctx.abortSignal);
  }

  updateStatus(ctx, {
    running: false,
    connected: false,
    lastStopAt: Date.now(),
  });
};
