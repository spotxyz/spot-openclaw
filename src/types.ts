export const SPOT_CHANNEL_ID = "spot" as const;
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SPOT_BASE_URL = "https://spotvirtual.com";

export type SpotActivationMode = "direct-or-mention" | "mentions" | "all";

export interface SpotSecretRef {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
}

export type SpotSecretInput = string | SpotSecretRef;

export interface SpotAvatarStartupConfig {
  joinOnStart?: boolean;
  spotId?: string;
  position?: { x: number; z: number };
  facing?: number;
  ttlSeconds?: number;
}

export interface SpotThreadPolicy {
  activationMode: SpotActivationMode;
}

export interface SpotAccountConfig {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  token?: SpotSecretInput;
  orgId?: string;
  worldId?: string;
  subscribeWorlds?: string[];
  subscribeThreads?: string[];
  monitorOrgChannels?: boolean;
  monitorAvatarActivity?: boolean;
  defaultTarget?: string;
  activationMode?: SpotActivationMode;
  threadPolicies?: Record<string, SpotThreadPolicy>;
  allowFrom?: string[];
  allowBotMessages?: boolean;
  avatar?: SpotAvatarStartupConfig;
}

export interface SpotChannelConfig extends SpotAccountConfig {
  accounts?: Record<string, SpotAccountConfig>;
}

export interface ResolvedSpotAccount extends Omit<
  SpotAccountConfig,
  "token" | "enabled"
> {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  token: string;
  activationMode: SpotActivationMode;
  threadPolicies: Record<string, SpotThreadPolicy>;
  allowFrom: string[];
  allowBotMessages: boolean;
  subscribeWorlds: string[];
  subscribeThreads: string[];
  monitorOrgChannels: boolean;
  monitorAvatarActivity: boolean;
}

export interface SpotUserSummary {
  id: string;
  fullName: string;
  displayName: string;
  isBot: boolean;
}

export interface SpotMeResponse {
  user: SpotUserSummary;
  orgIds: string[];
  scopes: string[];
}

export interface SpotThreadSummary {
  id: string;
  type: string;
  name: string | null;
  orgId: string | null;
  isPrivate: boolean;
  spotId: string | null;
  parentEventId: string | null;
}

/**
 * Attachment metadata from Spot. Older Agent Gateway versions only expose
 * `name` (and advertised an `id` that the stored attachment does not have), so
 * every field remains optional until the connector hydrates the full event.
 */
export interface SpotAttachedFile {
  id?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  url?: string;
  thumbnailUrl?: string | null;
  width?: number | null;
  height?: number | null;
}

export interface SpotMessageEvent {
  id: string;
  /** Opaque REST cursor used to resume this thread after a delivery gap. */
  cursor?: string;
  threadId: string;
  thread: SpotThreadSummary;
  userId: string;
  user: SpotUserSummary | null;
  timestamp: string;
  message: string;
  text: string;
  attachedFiles: SpotAttachedFile[];
  mentions: Array<{ kind?: string; id?: string; [key: string]: unknown }>;
  isMentioned: boolean;
  isDirectMessage: boolean;
}

export interface SpotMessagePayload {
  event: SpotMessageEvent;
}

export interface SpotHelloFrame {
  op: "hello";
  connectionId: string;
  heartbeatIntervalMs: number;
  self: SpotUserSummary;
  orgIds: string[];
  scopes: string[];
}

export interface SpotEventFrame {
  op: "event";
  seq: number;
  type: string;
  ts: string;
  orgId: string | null;
  payload: unknown;
}

export interface SpotAckFrame {
  op: "ack";
  id: string;
  subscribed: { threads: string[]; worlds: string[] };
  rejected: { kind: "thread" | "world"; id: string; code: string }[];
}

export interface SpotErrorFrame {
  op: "error";
  id?: string;
  code: string;
  message: string;
}

export type SpotServerFrame =
  SpotHelloFrame | SpotEventFrame | SpotAckFrame | SpotErrorFrame;

export interface SpotAvatarState {
  joined: boolean;
  spotId?: string;
  position?: { x: number; y: number; z: number };
  facing?: number;
}

export interface SpotAvatarEmote {
  id: string;
  animation: number;
  defaultEmojiName: string;
}

export interface SpotAvatarGesture {
  id: string;
  gesture: number;
  requiresResponse: boolean;
}

export interface SpotAvatarActivityPayload {
  worldId: string;
  userId: string;
  spotId?: string;
  oldSpotId?: string;
  animation?: string;
  emojiName?: string;
  gesture?: string;
  completerUserId?: string;
  completerGesture?: string;
}

export interface SpotWorldAvatar {
  userId: string;
  spotId?: string;
  position?: { x: number; y: number; z: number };
}

/** A Spot room mapped to a floorplan room and its chat thread. */
export interface SpotWorldSpot {
  id: string;
  name: string;
  slug: string;
  roomId: string;
  threadId: string;
  isDefault: boolean;
  isMeetingRoom: boolean;
  canAccess: boolean;
  accessDeniedReason?: "spot_locked" | "spot_access_denied";
}

export interface SpotCreatedMessage {
  id: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface SpotEventReaction {
  id: string;
  userId: string;
  emoji: string;
}

export interface SpotHistoryPageInfo {
  startCursor?: string | null;
  endCursor?: string | null;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
}

export interface SpotMessageHistoryPage {
  events: SpotMessageEvent[];
  pageInfo: SpotHistoryPageInfo;
}

export interface SpotOrgMember {
  userId: string;
  fullName: string;
  displayName: string;
  isBot: boolean;
  isGuest: boolean;
}

export interface SpotLegacyHistoryPage {
  edges: Array<{
    cursor: string;
    node: {
      id: string;
      type: string;
      threadId: string;
      userId: string;
      timestamp: string;
      payload?: {
        message?: string | null;
        attachedFiles?: SpotAttachedFile[] | null;
      };
    };
  }>;
  pageInfo: SpotHistoryPageInfo;
}
