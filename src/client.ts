import type {
  SpotAvatarEmote,
  SpotAvatarGesture,
  SpotAvatarStartupConfig,
  SpotAvatarState,
  SpotAttachedFile,
  SpotCreatedMessage,
  SpotEventReaction,
  SpotLegacyHistoryPage,
  SpotMeResponse,
  SpotMessageHistoryPage,
  SpotOrgMember,
  SpotThreadSummary,
  SpotWorldSpot,
  SpotWorldAvatar,
} from "./types.js";

export class SpotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SpotApiError";
  }
}

export interface SpotClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
}

export interface SpotRequestOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number;
}

export interface SpotEventSummary {
  id: string;
  threadId: string;
  payload?: {
    attachedFiles?: SpotAttachedFile[] | null;
    [key: string]: unknown;
  };
}

export interface SpotHistoryPagination {
  before?: string;
  after?: string;
  first?: number;
  last?: number;
}

export const DEFAULT_SPOT_REQUEST_TIMEOUT_MS = 15_000;

const extractApiError = (
  value: unknown,
): { code?: string; message?: string } => {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const directMessage = record.message;
  const directCode = record.code;
  const error = record.error;
  if (error && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    return {
      ...(typeof nested.code === "string" ? { code: nested.code } : {}),
      ...(typeof nested.message === "string" && nested.message.trim()
        ? { message: nested.message }
        : {}),
    };
  }
  return {
    ...(typeof directCode === "string" ? { code: directCode } : {}),
    ...(typeof directMessage === "string" && directMessage.trim()
      ? { message: directMessage }
      : {}),
  };
};

const normalizeWorldSpot = (value: unknown): SpotWorldSpot | null => {
  if (!value || typeof value !== "object") return null;
  const spot = value as Record<string, unknown>;
  if (
    typeof spot.id !== "string" ||
    typeof spot.name !== "string" ||
    typeof spot.slug !== "string" ||
    typeof spot.roomId !== "string" ||
    typeof spot.threadId !== "string" ||
    typeof spot.isDefault !== "boolean" ||
    typeof spot.isMeetingRoom !== "boolean" ||
    typeof spot.canAccess !== "boolean"
  ) {
    return null;
  }

  return {
    id: spot.id,
    name: spot.name,
    slug: spot.slug,
    roomId: spot.roomId,
    threadId: spot.threadId,
    isDefault: spot.isDefault,
    isMeetingRoom: spot.isMeetingRoom,
    canAccess: spot.canAccess,
    ...(spot.accessDeniedReason === "spot_locked" ||
    spot.accessDeniedReason === "spot_access_denied"
      ? { accessDeniedReason: spot.accessDeniedReason }
      : {}),
  };
};

export class SpotClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly signal: AbortSignal | undefined;
  private readonly requestTimeoutMs: number;

  constructor(options: SpotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.signal = options.signal;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_SPOT_REQUEST_TIMEOUT_MS;
    if (!this.baseUrl) throw new Error("Spot baseUrl is required.");
    if (!this.token) throw new Error("Spot token is required.");
    if (!this.fetchImpl) throw new Error("A fetch implementation is required.");
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("Spot requestTimeoutMs must be a positive number.");
    }
  }

  gatewayUrl(): string {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/agent/v1";
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  authorizationHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  async getMe(options?: SpotRequestOptions): Promise<SpotMeResponse> {
    return this.request("GET", "/api/me", undefined, options);
  }

  async getSpots(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotWorldSpot[]> {
    const result = await this.request<unknown>(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/spots`,
      undefined,
      options,
    );
    if (!Array.isArray(result)) {
      throw new SpotApiError(
        "Spot API returned an invalid spot-discovery response.",
        200,
        "GET",
        `/api/world/${encodeURIComponent(worldId)}/spots`,
      );
    }
    return result
      .map(normalizeWorldSpot)
      .filter((spot): spot is SpotWorldSpot => !!spot);
  }

  async getAvatarState(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatar`,
      undefined,
      options,
    );
  }

  async getWorldAvatars(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotWorldAvatar[]> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatars`,
      undefined,
      options,
    );
  }

  async joinAvatar(
    worldId: string,
    input: SpotAvatarStartupConfig = {},
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    const { joinOnStart: _joinOnStart, ...body } = input;
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/join`,
      body,
      options,
    );
  }

  async moveAvatar(
    worldId: string,
    input: { x: number; z: number; facing?: number },
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/move`,
      input,
      options,
    );
  }

  async walkAvatarToSpot(
    worldId: string,
    input: { spotId: string; facing?: number },
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/walk-to-spot`,
      input,
      options,
    );
  }

  async teleportAvatar(
    worldId: string,
    input: { x: number; z: number; facing?: number },
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/teleport`,
      input,
      options,
    );
  }

  async setAvatarFacing(
    worldId: string,
    facing: number,
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "PUT",
      `/api/world/${encodeURIComponent(worldId)}/avatar/facing`,
      { facing },
      options,
    );
  }

  async emote(
    worldId: string,
    input: { emojiName?: string; animation?: string },
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/emote`,
      input,
      options,
    );
  }

  async getAvatarEmotes(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarEmote[]> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatar/emotes`,
      undefined,
      options,
    );
  }

  async getAvatarGestures(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarGesture[]> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatar/gestures`,
      undefined,
      options,
    );
  }

  async requestAvatarGesture(
    worldId: string,
    gesture: string | null,
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/gesture`,
      { gesture },
      options,
    );
  }

  async completeAvatarGesture(
    worldId: string,
    input: { requesterUserId: string; response?: string },
    options?: SpotRequestOptions,
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/gesture/complete`,
      input,
      options,
    );
  }

  async leaveAvatar(
    worldId: string,
    options?: SpotRequestOptions,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/leave`,
      undefined,
      options,
    );
  }

  async sendThreadMessage(
    threadId: string,
    message: string,
    options?: SpotRequestOptions,
  ): Promise<SpotCreatedMessage> {
    return this.request(
      "POST",
      `/api/thread/${encodeURIComponent(threadId)}/events`,
      { message },
      options,
    );
  }

  async getOrgThreads(
    orgId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotThreadSummary[]> {
    return this.request(
      "GET",
      `/api/org/${encodeURIComponent(orgId)}/threads`,
      undefined,
      options,
    );
  }

  async getOrgMembers(
    orgId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotOrgMember[]> {
    return this.request(
      "GET",
      `/api/org/${encodeURIComponent(orgId)}/members`,
      undefined,
      options,
    );
  }

  async getThreadHistory(
    threadId: string,
    pagination: SpotHistoryPagination = {},
    options?: SpotRequestOptions,
  ): Promise<SpotMessageHistoryPage> {
    return this.request(
      "GET",
      this.threadHistoryPath(
        `/api/agent/v1/thread/${encodeURIComponent(threadId)}/events`,
        pagination,
      ),
      undefined,
      options,
    );
  }

  async getLegacyThreadHistory(
    threadId: string,
    pagination: SpotHistoryPagination = {},
    options?: SpotRequestOptions,
  ): Promise<SpotLegacyHistoryPage> {
    return this.request(
      "GET",
      this.threadHistoryPath(
        `/api/thread/${encodeURIComponent(threadId)}/events`,
        pagination,
      ),
      undefined,
      options,
    );
  }

  async getThread(
    threadId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotThreadSummary> {
    return this.request(
      "GET",
      `/api/thread/${encodeURIComponent(threadId)}`,
      undefined,
      options,
    );
  }

  async getEvent(
    eventId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotEventSummary> {
    return this.request(
      "GET",
      `/api/event/${encodeURIComponent(eventId)}`,
      undefined,
      options,
    );
  }

  async getOrCreateEventThread(
    eventId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotThreadSummary> {
    return this.request(
      "POST",
      `/api/event/${encodeURIComponent(eventId)}/thread`,
      undefined,
      options,
    );
  }

  async setThreadTyping(
    threadId: string,
    isEmpty: boolean,
    options?: SpotRequestOptions,
  ): Promise<void> {
    await this.request(
      "POST",
      `/api/thread/${encodeURIComponent(threadId)}/typing`,
      { isEmpty },
      options,
    );
  }

  async getEventReactions(
    eventId: string,
    options?: SpotRequestOptions,
  ): Promise<SpotEventReaction[]> {
    return this.request(
      "GET",
      `/api/event/${encodeURIComponent(eventId)}/reactions`,
      undefined,
      options,
    );
  }

  async addEventReaction(
    eventId: string,
    emoji: string,
    options?: SpotRequestOptions,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/event/${encodeURIComponent(eventId)}/reactions`,
      { emoji },
      options,
    );
  }

  async removeEventReaction(
    eventId: string,
    reactionId: string,
    options?: SpotRequestOptions,
  ): Promise<void> {
    await this.request(
      "DELETE",
      `/api/event/${encodeURIComponent(eventId)}/reactions/${encodeURIComponent(
        reactionId,
      )}`,
      undefined,
      options,
    );
  }

  async getOrCreateDm(
    userId: string,
    options?: SpotRequestOptions,
  ): Promise<{ id: string }> {
    return this.request("POST", "/api/dm", { userIds: [userId] }, options);
  }

  private threadHistoryPath(
    path: string,
    pagination: SpotHistoryPagination,
  ): string {
    const query = new URLSearchParams();
    if (pagination.before) query.set("before", pagination.before);
    if (pagination.after) query.set("after", pagination.after);
    if (pagination.first !== undefined)
      query.set("first", String(pagination.first));
    if (pagination.last !== undefined)
      query.set("last", String(pagination.last));
    const suffix = query.toString();
    return suffix ? `${path}?${suffix}` : path;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: SpotRequestOptions = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Spot request timeout must be a positive number.");
    }
    const signals = [
      this.signal,
      options.signal,
      AbortSignal.timeout(timeoutMs),
    ].filter((signal): signal is AbortSignal => !!signal);
    const signal =
      signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers: {
        ...this.authorizationHeaders(),
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 204) return undefined as T;
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const detail = extractApiError(parsed);
      throw new SpotApiError(
        detail.message
          ? `Spot API ${method} ${path} failed: ${detail.message}`
          : `Spot API ${method} ${path} failed with HTTP ${response.status}.`,
        response.status,
        method,
        path,
        detail.code,
      );
    }
    if (parsed === undefined && raw) {
      throw new SpotApiError(
        `Spot API ${method} ${path} returned invalid JSON.`,
        response.status,
        method,
        path,
      );
    }
    return parsed as T;
  }
}
