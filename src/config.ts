import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/channel-runtime";
import {
  collectSimpleChannelFieldAssignments,
  getChannelSurface,
  type SecretTargetRegistryEntry,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
} from "openclaw/plugin-sdk/secret-input-runtime";

import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_SPOT_BASE_URL,
  type ResolvedSpotAccount,
  type SpotAccountConfig,
  type SpotChannelConfig,
} from "./types.js";

type MutableConfig = OpenClawConfig & {
  channels?: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
};

export const validateSpotBaseUrl = (raw: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Spot baseUrl must be a valid URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Spot baseUrl must use http or https.";
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    return "Spot baseUrl must use https unless it points to a loopback development server.";
  }
  return undefined;
};

const normalizeSpotBaseUrl = (raw: string): string => {
  const value = raw.trim();
  const issue = validateSpotBaseUrl(value);
  if (issue) throw new Error(issue);
  return value.replace(/\/+$/, "");
};

export const getSpotChannelConfig = (
  cfg: OpenClawConfig,
): SpotChannelConfig => {
  const section = (cfg.channels as Record<string, unknown> | undefined)?.spot;
  return isRecord(section) ? (section as SpotChannelConfig) : {};
};

export const listSpotAccountIds = (cfg: OpenClawConfig): string[] => {
  const section = getSpotChannelConfig(cfg);
  const ids = section.accounts ? Object.keys(section.accounts) : [];
  if (!section.accounts || ids.length === 0 || hasConfiguredSecretInput(section.token)) {
    if (!ids.includes(DEFAULT_ACCOUNT_ID)) ids.unshift(DEFAULT_ACCOUNT_ID);
  }
  return ids;
};

const getAccountLayer = (
  section: SpotChannelConfig,
  accountId: string,
): SpotAccountConfig => section.accounts?.[accountId] ?? {};

export const getMergedSpotAccountConfig = (
  cfg: OpenClawConfig,
  requestedAccountId?: string | null,
): { accountId: string; config: SpotAccountConfig; tokenPath: string } => {
  const section = getSpotChannelConfig(cfg);
  const accountId = requestedAccountId || DEFAULT_ACCOUNT_ID;
  const account = getAccountLayer(section, accountId);
  const { accounts: _accounts, ...defaults } = section;
  const config = { ...defaults, ...account };
  const tokenPath = Object.prototype.hasOwnProperty.call(account, "token")
    ? `channels.spot.accounts.${accountId}.token`
    : "channels.spot.token";
  return { accountId, config, tokenPath };
};

export const resolveSpotAccount = (
  cfg: OpenClawConfig,
  requestedAccountId?: string | null,
): ResolvedSpotAccount => {
  const { accountId, config, tokenPath } = getMergedSpotAccountConfig(
    cfg,
    requestedAccountId,
  );
  const token = normalizeResolvedSecretInputString({
    value: config.token,
    path: tokenPath,
  });
  if (!token) {
    throw new Error(`Spot account ${accountId} is missing its API token.`);
  }
  if (config.avatar?.joinOnStart && !config.worldId) {
    throw new Error(
      `Spot account ${accountId} enables avatar.joinOnStart but has no worldId.`,
    );
  }
  if (config.monitorOrgChannels && !config.orgId) {
    throw new Error(
      `Spot account ${accountId} enables monitorOrgChannels but has no orgId.`,
    );
  }
  const {
    token: _token,
    enabled,
    baseUrl,
    activationMode,
    allowFrom,
    allowBotMessages,
    subscribeWorlds,
    subscribeThreads,
    monitorOrgChannels,
    ...rest
  } = config;
  return {
    ...rest,
    accountId,
    enabled: enabled !== false,
    baseUrl: normalizeSpotBaseUrl(baseUrl || DEFAULT_SPOT_BASE_URL),
    token,
    activationMode: activationMode ?? "direct-or-mention",
    allowFrom: allowFrom ?? [],
    allowBotMessages: allowBotMessages === true,
    subscribeWorlds: subscribeWorlds ?? [],
    subscribeThreads: subscribeThreads ?? [],
    monitorOrgChannels: monitorOrgChannels === true,
  };
};

export const inspectSpotAccount = (
  cfg: OpenClawConfig,
  requestedAccountId?: string | null,
) => {
  const { accountId, config } = getMergedSpotAccountConfig(
    cfg,
    requestedAccountId,
  );
  const configured = hasConfiguredSecretInput(config.token);
  return {
    accountId,
    name: config.name,
    enabled: config.enabled !== false,
    configured,
    tokenStatus: configured ? "configured" : "missing",
    baseUrl: config.baseUrl ?? DEFAULT_SPOT_BASE_URL,
    mode: config.activationMode ?? "direct-or-mention",
  };
};

export const applySpotAccountConfig = ({
  cfg,
  accountId,
  input,
}: {
  cfg: OpenClawConfig;
  accountId: string;
  input: ChannelSetupInput;
}): OpenClawConfig => {
  const mutable = cfg as MutableConfig;
  const channels = { ...(mutable.channels ?? {}) };
  const current = isRecord(channels.spot)
    ? ({ ...channels.spot } as SpotChannelConfig)
    : ({} as SpotChannelConfig);
  const patch: SpotAccountConfig = {
    ...(input.name ? { name: input.name } : {}),
    ...(input.token ? { token: input.token } : {}),
    ...(input.baseUrl || input.url
      ? { baseUrl: input.baseUrl ?? input.url }
      : {}),
    ...(input.dmAllowlist ? { allowFrom: input.dmAllowlist } : {}),
    enabled: true,
  };

  if (accountId === DEFAULT_ACCOUNT_ID && !current.accounts) {
    channels.spot = { ...current, ...patch };
  } else {
    channels.spot = {
      ...current,
      accounts: {
        ...(current.accounts ?? {}),
        [accountId]: {
          ...(current.accounts?.[accountId] ?? {}),
          ...patch,
        },
      },
    };
  }
  return { ...cfg, channels } as OpenClawConfig;
};

export const spotSecretTargetRegistryEntries: readonly SecretTargetRegistryEntry[] = [
  {
    id: "channels.spot.accounts.*.token",
    targetType: "channels.spot.accounts.*.token",
    configFile: "openclaw.json",
    pathPattern: "channels.spot.accounts.*.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
    accountIdPathSegmentIndex: 3,
  },
  {
    id: "channels.spot.token",
    targetType: "channels.spot.token",
    configFile: "openclaw.json",
    pathPattern: "channels.spot.token",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
];

export const collectSpotRuntimeConfigAssignments = (
  params: Parameters<
    NonNullable<
      import("openclaw/plugin-sdk/channel-runtime").ChannelSecretsAdapter["collectRuntimeConfigAssignments"]
    >
  >[0],
): void => {
  const resolved = getChannelSurface(params.config, "spot");
  if (!resolved) return;
  collectSimpleChannelFieldAssignments({
    channelKey: "spot",
    field: "token",
    channel: resolved.channel,
    surface: resolved.surface,
    defaults: params.defaults,
    context: params.context,
    topInactiveReason: "no enabled Spot account inherits this top-level token.",
    accountInactiveReason: "Spot account is disabled.",
  });
};
