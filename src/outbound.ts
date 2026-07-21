import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

import { SpotClient } from "./client.js";
import { resolveSpotAccount } from "./config.js";
import { SPOT_CHANNEL_ID, type ResolvedSpotAccount } from "./types.js";

export const SPOT_MESSAGE_MAX_LENGTH = 12_000;

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
}): Promise<{ messageId: string; threadId: string }> => {
  const account = resolveSpotAccount(params.cfg, params.accountId);
  const client = makeClient(account);
  const threadId = await resolveSpotThread(
    client,
    account,
    parseSpotTarget(params.to),
  );
  const event = await client.sendThreadMessage(threadId, params.text);
  if (!event.id) {
    throw new Error("Spot accepted the message but did not return an event id.");
  }
  return { messageId: event.id, threadId };
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
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      replyTo: false,
      thread: true,
      messageSendingHooks: true,
    },
  },
  async sendText(ctx) {
    const result = await sendSpotText({
      cfg: ctx.cfg,
      ...(ctx.accountId === undefined ? {} : { accountId: ctx.accountId }),
      to: ctx.to,
      text: ctx.text,
    });
    return {
      channel: SPOT_CHANNEL_ID,
      messageId: result.messageId,
      conversationId: result.threadId,
    };
  },
};

export const spotMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: SPOT_CHANNEL_ID,
  outbound: spotOutboundAdapter,
});
