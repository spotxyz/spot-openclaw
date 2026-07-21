import {
  jsonResult,
  resolveReactionMessageId,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-runtime";
import { Type } from "typebox";

import { SpotClient } from "./client.js";
import { resolveSpotAccount } from "./config.js";
import type { ResolvedSpotAccount } from "./types.js";

export interface SpotMessageActionDependencies {
  createClient?: (account: ResolvedSpotAccount) => SpotClient;
}

const reactionSchema = {
  actions: ["react", "reactions"] as const,
  visibility: "current-channel" as const,
  properties: {
    messageId: Type.Optional(
      Type.String({ description: "Spot event id to react to or inspect." }),
    ),
    emoji: Type.Optional(
      Type.String({
        description:
          "Emoji to add or remove. For react, omit or pass an empty value to remove all of the agent's reactions.",
      }),
    ),
    remove: Type.Optional(
      Type.Boolean({
        description: "Remove the agent's matching reaction instead of adding it.",
      }),
    ),
  },
};

const resolveMessageId = (
  params: Record<string, unknown>,
  currentMessageId?: string | number | null,
): string => {
  const resolved = resolveReactionMessageId({
    args: params,
    ...(currentMessageId === undefined || currentMessageId === null
      ? {}
      : { toolContext: { currentMessageId } }),
  });
  if (resolved === undefined || resolved === null || !String(resolved).trim()) {
    throw new Error("Spot reactions require a messageId or current message context.");
  }
  return String(resolved).trim();
};

export const createSpotMessageActions = (
  dependencies: SpotMessageActionDependencies = {},
): ChannelMessageActionAdapter => ({
  describeMessageTool: ({ cfg, accountId, currentChannelProvider }) => {
    if (
      currentChannelProvider &&
      currentChannelProvider.toLowerCase() !== "spot"
    ) {
      return null;
    }
    try {
      const account = resolveSpotAccount(cfg, accountId);
      if (!account.enabled) return null;
      return {
        actions: ["react", "reactions"],
        capabilities: [],
        schema: reactionSchema,
      };
    } catch {
      return null;
    }
  },
  supportsAction: ({ action }) => action === "react" || action === "reactions",
  handleAction: async (ctx) => {
    if (ctx.action !== "react" && ctx.action !== "reactions") {
      throw new Error(`Unsupported Spot message action: ${ctx.action}.`);
    }
    const account = resolveSpotAccount(ctx.cfg, ctx.accountId);
    const client =
      dependencies.createClient?.(account) ??
      new SpotClient({ baseUrl: account.baseUrl, token: account.token });
    const messageId = resolveMessageId(
      ctx.params,
      ctx.toolContext?.currentMessageId,
    );
    const reactions = await client.getEventReactions(messageId);

    if (ctx.action === "reactions") {
      return jsonResult({
        ok: true,
        channel: "spot",
        messageId,
        reactions,
      });
    }

    const emoji =
      typeof ctx.params.emoji === "string" ? ctx.params.emoji.trim() : "";
    const remove = ctx.params.remove === true || !emoji;
    const me = await client.getMe();
    const ownMatching = reactions.filter(
      (reaction) =>
        reaction.userId === me.user.id && (!emoji || reaction.emoji === emoji),
    );

    if (remove) {
      await Promise.all(
        ownMatching.map((reaction) =>
          client.removeEventReaction(messageId, reaction.id),
        ),
      );
      return jsonResult({
        ok: true,
        channel: "spot",
        messageId,
        removed: ownMatching.length,
        ...(emoji ? { emoji } : {}),
      });
    }

    const existing = ownMatching[0];
    if (existing) {
      return jsonResult({
        ok: true,
        channel: "spot",
        messageId,
        emoji,
        reactionId: existing.id,
        alreadyPresent: true,
      });
    }

    await client.addEventReaction(messageId, emoji);
    return jsonResult({
      ok: true,
      channel: "spot",
      messageId,
      emoji,
      added: true,
    });
  },
});

export const spotMessageActions = createSpotMessageActions();
