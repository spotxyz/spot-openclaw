import {
  SpotApiError,
  type SpotClient,
  type SpotHistoryPagination,
  type SpotRequestOptions,
} from "./client.js";
import type {
  SpotLegacyHistoryPage,
  SpotMessageEvent,
  SpotMessageHistoryPage,
  SpotOrgMember,
} from "./types.js";

const MENTION_PATTERN =
  /\[([^\]]*?)\]\((User|Spot|World|Role|Org|Channel)--(.*?)(?:--Active)?(?:--)?\)/g;
const MEMBER_CACHE_TTL_MS = 60_000;
const memberCaches = new WeakMap<
  SpotClient,
  Map<string, { expiresAt: number; members: Map<string, SpotOrgMember> }>
>();

export const parseSpotMentions = (message: string) =>
  [...message.matchAll(MENTION_PATTERN)].map((match) => ({
    label: match[1]!,
    kind: match[2]!,
    id: match[3]!,
  }));

export const renderSpotMessageText = (message: string): string =>
  message.replace(MENTION_PATTERN, "@$1");

const boundedLegacyEdges = (
  page: SpotLegacyHistoryPage,
  pagination: SpotHistoryPagination
): SpotLegacyHistoryPage["edges"] => {
  if (pagination.first !== undefined && page.edges.length > pagination.first) {
    return page.edges.slice(0, pagination.first);
  }
  if (pagination.last !== undefined && page.edges.length > pagination.last) {
    return page.edges.slice(-pagination.last);
  }
  return page.edges;
};

const memberMap = async (
  client: SpotClient,
  orgId: string | null,
  options?: SpotRequestOptions
): Promise<Map<string, SpotOrgMember>> => {
  if (!orgId) return new Map();
  const cache = memberCaches.get(client) ?? new Map();
  memberCaches.set(client, cache);
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.members;
  try {
    const members = await client.getOrgMembers(orgId, options);
    const resolved = new Map(
      members.map((member): [string, SpotOrgMember] => [member.userId, member])
    );
    cache.set(orgId, {
      members: resolved,
      expiresAt: Date.now() + MEMBER_CACHE_TTL_MS,
    });
    return resolved;
  } catch (error) {
    if (error instanceof SpotApiError && error.status === 403) {
      const resolved = new Map<string, SpotOrgMember>();
      cache.set(orgId, {
        members: resolved,
        expiresAt: Date.now() + MEMBER_CACHE_TTL_MS,
      });
      return resolved;
    }
    throw error;
  }
};

const normalizeLegacyHistory = async (params: {
  client: SpotClient;
  threadId: string;
  pagination: SpotHistoryPagination;
  selfUserId?: string;
  options?: SpotRequestOptions;
}): Promise<SpotMessageHistoryPage> => {
  const [page, thread] = await Promise.all([
    params.client.getLegacyThreadHistory(
      params.threadId,
      params.pagination,
      params.options
    ),
    params.client.getThread(params.threadId, params.options),
  ]);
  const members = await memberMap(params.client, thread.orgId, params.options);
  const edges = boundedLegacyEdges(page, params.pagination);
  const truncatedForward =
    params.pagination.first !== undefined && page.edges.length > edges.length;
  const truncatedBackward =
    params.pagination.last !== undefined && page.edges.length > edges.length;
  const events = edges.flatMap(({ cursor, node }): SpotMessageEvent[] => {
    if (
      node.type !== "ChatMessage" ||
      typeof node.payload?.message !== "string"
    ) {
      return [];
    }
    const message = node.payload.message;
    const mentions = parseSpotMentions(message);
    const member = members.get(node.userId);
    return [
      {
        id: node.id,
        cursor,
        threadId: node.threadId,
        thread,
        userId: node.userId,
        user: member
          ? {
              id: member.userId,
              fullName: member.fullName,
              displayName: member.displayName,
              isBot: member.isBot,
            }
          : null,
        timestamp: node.timestamp,
        message,
        text: renderSpotMessageText(message),
        attachedFiles: node.payload.attachedFiles ?? [],
        mentions,
        isMentioned: mentions.some(
          (mention) =>
            mention.kind === "User" && mention.id === params.selfUserId
        ),
        isDirectMessage: thread.type === "DirectMessage",
      },
    ];
  });
  return {
    events,
    pageInfo: {
      ...page.pageInfo,
      ...(edges[0] ? { startCursor: edges[0].cursor } : {}),
      ...(edges.at(-1) ? { endCursor: edges.at(-1)!.cursor } : {}),
      hasPreviousPage: page.pageInfo.hasPreviousPage || truncatedBackward,
      hasNextPage: page.pageInfo.hasNextPage || truncatedForward,
    },
  };
};

/**
 * Prefer Spot's normalized agent-history endpoint. During a rolling server
 * deployment, fall back to the older generic thread-events response so the
 * tool remains useful before every Spot node has the new endpoint.
 */
export const loadSpotHistoryPage = async (params: {
  client: SpotClient;
  threadId: string;
  pagination?: SpotHistoryPagination;
  selfUserId?: string;
  options?: SpotRequestOptions;
}): Promise<SpotMessageHistoryPage> => {
  const pagination = params.pagination ?? {};
  try {
    return await params.client.getThreadHistory(
      params.threadId,
      pagination,
      params.options
    );
  } catch (error) {
    const missingAgentHistoryRoute =
      error instanceof SpotApiError &&
      (error.status === 404 ||
        (error.status === 200 &&
          error.message.endsWith("returned invalid JSON.")));
    if (!missingAgentHistoryRoute) throw error;
    return normalizeLegacyHistory({ ...params, pagination });
  }
};
