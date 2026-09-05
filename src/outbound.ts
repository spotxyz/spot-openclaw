import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { recordChannelActivity } from "openclaw/plugin-sdk/infra-runtime";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

import { SpotClient } from "./client.js";
import { resolveSpotAccount } from "./config.js";
import { SPOT_CHANNEL_ID, type ResolvedSpotAccount } from "./types.js";

export const SPOT_MESSAGE_MAX_LENGTH = 12_000;
const replyThreadRequests = new Map<string, Promise<string>>();

const getOrCreateReplyThread = async (
  client: SpotClient,
  eventId: string,
): Promise<string> => {
  const key = `${client.baseUrl}\n${eventId}`;
  const pending = replyThreadRequests.get(key);
  if (pending) return pending;
  const request = client
    .getOrCreateEventThread(eventId)
    .then((thread) => {
      if (!thread.id) {
        throw new Error(
          "Spot created the channel reply thread but returned no thread id.",
        );
      }
      return thread.id;
    })
    .finally(() => replyThreadRequests.delete(key));
  replyThreadRequests.set(key, request);
  return request;
};

export const resolveSpotReplyDestination = async (
  client: SpotClient,
  fallbackThreadId: string,
  replyToId?: string | null,
): Promise<string> => {
  const eventId = replyToId?.trim();
  if (!eventId) return fallbackThreadId;
  const event = await client.getEvent(eventId);
  if (!event.threadId) {
    throw new Error("Spot returned a reply target without a thread id.");
  }
  const sourceThread = await client.getThread(event.threadId);
  if (sourceThread.type !== "Channel") return event.threadId;
  return getOrCreateReplyThread(client, eventId);
};

export const chunkSpotText = (
  text: string,
  requestedLimit = SPOT_MESSAGE_MAX_LENGTH,
): string[] =>
  chunkMarkdownText(text, Math.min(requestedLimit, SPOT_MESSAGE_MAX_LENGTH));

export type SpotTargetKind = "thread" | "user" | "world" | "spot";

export interface ParsedSpotTarget {
  kind: SpotTargetKind;
  id: string;
}

const TARGET_PATTERN = /^(thread|user|world|spot):(.+)$/i;

export const parseSpotTarget = (raw: string): ParsedSpotTarget => {
  let value = raw.trim();
  if (
    /^spot:/i.test(value) &&
    !/^spot:(?:thread|user|world|spot):/i.test(value)
  ) {
    // `spot:<id>` is a room target, not an OpenClaw provider prefix.
  } else if (/^spot:/i.test(value)) {
    value = value.slice("spot:".length);
  }
  if (/^(?:thread|user|world|spot):\s*$/i.test(value)) {
    throw new Error("Spot target id cannot be empty.");
  }
  const match = TARGET_PATTERN.exec(value);
  if (match) {
    const id = match[2]?.trim();
    if (!id) throw new Error("Spot target id cannot be empty.");
    return { kind: match[1]!.toLowerCase() as SpotTargetKind, id };
  }
  if (!value) {
    throw new Error(
      "Spot target is required (thread:<id>, user:<id>, world:<id>, or spot:<id>).",
    );
  }
  // A bare id remains a convenient thread-id shorthand.
  return { kind: "thread", id: value };
};

export const normalizeSpotTarget = (raw: string): string => {
  const target = parseSpotTarget(raw);
  return `${target.kind}:${target.id}`;
};

const makeClient = (account: ResolvedSpotAccount): SpotClient =>
  new SpotClient({ baseUrl: account.baseUrl, token: account.token });

export const resolveSpotThread = async (
  client: SpotClient,
  account: ResolvedSpotAccount,
  target: ParsedSpotTarget,
): Promise<string> => {
  if (target.kind === "thread") return target.id;
  if (target.kind === "user") {
    const thread = await client.getOrCreateDm(target.id);
    if (!thread.id) {
      throw new Error("Spot created the direct message but returned no thread id.");
    }
    return thread.id;
  }

  const worldId = target.kind === "world" ? target.id : account.worldId;
  if (!worldId) {
    throw new Error(
      "A worldId is required to send to a Spot room. Configure channels.spot.worldId or use world:<id>.",
    );
  }
  const spots = await client.getSpots(worldId);
  let spotId = target.kind === "spot" ? target.id : undefined;
  if (!spotId) {
    const avatar = await client.getAvatarState(worldId);
    if (!avatar.joined || !avatar.spotId) {
      throw new Error(
        `The Spot avatar is not in world ${worldId}; join it before sending to world:${worldId}.`,
      );
    }
    spotId = avatar.spotId;
  }
  const spot = spots.find(
    (candidate) => candidate.id === spotId || candidate.slug === spotId,
  );
  if (!spot) {
    throw new Error(`Spot room ${spotId} was not found in world ${worldId}.`);
  }
  if (!spot.canAccess) {
    throw new Error(
      `Spot room ${spot.name} is not accessible (${spot.accessDeniedReason ?? "access_denied"}).`,
    );
  }
  return spot.threadId;
};

export const sendSpotText = async (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
  replyToId?: string | null;
}): Promise<{ messageId: string; threadId: string }> => {
  const account = resolveSpotAccount(params.cfg, params.accountId);
  const client = makeClient(account);
  const targetThreadId = await resolveSpotThread(
    client,
    account,
    parseSpotTarget(params.to),
  );
  const threadId = await resolveSpotReplyDestination(
    client,
    targetThreadId,
    params.replyToId,
  );
  const event = await client.sendThreadMessage(threadId, params.text);
  if (!event.id) {
    throw new Error("Spot accepted the message but did not return an event id.");
  }
  return { messageId: event.id, threadId };
};

// Both OpenClaw outbound interfaces share these inputs; their delivery callbacks
// differ, so accept only the fields used by Spot's text transport.
const sendSpotOutboundText = async (
  ctx: Pick<
    ChannelOutboundContext,
    "cfg" | "accountId" | "to" | "text" | "replyToId"
  >,
) => {
  const result = await sendSpotText({
    cfg: ctx.cfg,
    ...(ctx.accountId === undefined ? {} : { accountId: ctx.accountId }),
    to: ctx.to,
    text: ctx.text,
    ...(ctx.replyToId === undefined ? {} : { replyToId: ctx.replyToId }),
  });
  recordChannelActivity({
    channel: SPOT_CHANNEL_ID,
    ...(ctx.accountId === undefined ? {} : { accountId: ctx.accountId }),
    direction: "outbound",
  });
  return {
    channel: SPOT_CHANNEL_ID,
    messageId: result.messageId,
    conversationId: result.threadId,
  };
};

const spotDeliveryCapabilities = {
  durableFinal: {
    text: true,
    replyTo: true,
    thread: true,
    messageSendingHooks: true,
  },
};

export const spotOutboundAdapter: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: SPOT_MESSAGE_MAX_LENGTH,
  chunker: (text, limit) => chunkSpotText(text, limit),
  chunkerMode: "markdown",
  resolveTarget: ({ to }) => {
    try {
      if (!to) throw new Error("Spot target is required.");
      return { ok: true, to: normalizeSpotTarget(to) };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  },
  deliveryCapabilities: spotDeliveryCapabilities,
  sendText: sendSpotOutboundText,
};

export const spotMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: SPOT_CHANNEL_ID,
  outbound: {
    deliveryCapabilities: spotDeliveryCapabilities,
    sendText: sendSpotOutboundText,
  },
});
