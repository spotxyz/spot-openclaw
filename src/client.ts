import type {
  SpotAvatarStartupConfig,
  SpotAvatarState,
  SpotCreatedMessage,
  SpotMeResponse,
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
}

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

  constructor(options: SpotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.baseUrl) throw new Error("Spot baseUrl is required.");
    if (!this.token) throw new Error("Spot token is required.");
    if (!this.fetchImpl) throw new Error("A fetch implementation is required.");
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

  async getMe(): Promise<SpotMeResponse> {
    return this.request("GET", "/api/me");
  }

  async getSpots(worldId: string): Promise<SpotWorldSpot[]> {
    const result = await this.request<unknown>(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/spots`,
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

  async getAvatarState(worldId: string): Promise<SpotAvatarState> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatar`,
    );
  }

  async getWorldAvatars(worldId: string): Promise<SpotWorldAvatar[]> {
    return this.request(
      "GET",
      `/api/world/${encodeURIComponent(worldId)}/avatars`,
    );
  }

  async joinAvatar(
    worldId: string,
    input: SpotAvatarStartupConfig = {},
  ): Promise<SpotAvatarState> {
    const { joinOnStart: _joinOnStart, ...body } = input;
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/join`,
      body,
    );
  }

  async moveAvatar(
    worldId: string,
    input: { x: number; z: number; facing?: number },
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/move`,
      input,
    );
  }

  async teleportAvatar(
    worldId: string,
    input: { x: number; z: number; facing?: number },
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/teleport`,
      input,
    );
  }

  async setAvatarFacing(
    worldId: string,
    facing: number,
  ): Promise<SpotAvatarState> {
    return this.request(
      "PUT",
      `/api/world/${encodeURIComponent(worldId)}/avatar/facing`,
      { facing },
    );
  }

  async emote(
    worldId: string,
    input: { emojiName?: string; animationName?: string },
  ): Promise<SpotAvatarState> {
    return this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/emote`,
      input,
    );
  }

  async leaveAvatar(worldId: string): Promise<void> {
    await this.request(
      "POST",
      `/api/world/${encodeURIComponent(worldId)}/avatar/leave`,
    );
  }

  async sendThreadMessage(
    threadId: string,
    message: string,
  ): Promise<SpotCreatedMessage> {
    return this.request(
      "POST",
      `/api/thread/${encodeURIComponent(threadId)}/events`,
      { message },
    );
  }

  async getOrCreateDm(userId: string): Promise<{ id: string }> {
    return this.request("POST", "/api/dm", { userIds: [userId] });
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
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
