export const SPOT_CHANNEL_ID = "spot" as const;
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_SPOT_BASE_URL = "https://spot.xyz";

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

export interface SpotAccountConfig {
  enabled?: boolean;
  name?: string;
  baseUrl?: string;
  token?: SpotSecretInput;
  orgId?: string;
  worldId?: string;
  subscribeWorlds?: string[];
  subscribeThreads?: string[];
  defaultTarget?: string;
  activationMode?: SpotActivationMode;
  allowFrom?: string[];
  allowBotMessages?: boolean;
  avatar?: SpotAvatarStartupConfig;
}

export interface SpotChannelConfig extends SpotAccountConfig {
  accounts?: Record<string, SpotAccountConfig>;
}

export interface ResolvedSpotAccount
  extends Omit<SpotAccountConfig, "token" | "enabled"> {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  token: string;
  activationMode: SpotActivationMode;
  allowFrom: string[];
  allowBotMessages: boolean;
  subscribeWorlds: string[];
  subscribeThreads: string[];
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

export interface SpotMessageEvent {
  id: string;
  threadId: string;
  thread: SpotThreadSummary;
  userId: string;
  user: SpotUserSummary | null;
  timestamp: string;
  message: string;
  text: string;
  attachedFiles: { id?: string; name?: string }[];
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
  | SpotHelloFrame
  | SpotEventFrame
  | SpotAckFrame
  | SpotErrorFrame;

export interface SpotAvatarState {
  joined: boolean;
  spotId?: string;
  position?: { x: number; y: number; z: number };
  facing?: number;
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
