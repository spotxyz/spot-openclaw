import {
  createChannelPluginBase,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";

import { SpotClient } from "./client.js";
import {
  applySpotAccountConfig,
  collectSpotRuntimeConfigAssignments,
  getMergedSpotAccountConfig,
  inspectSpotAccount,
  listSpotAccountIds,
  resolveSpotAccount,
  spotSecretTargetRegistryEntries,
} from "./config.js";
import {
  normalizeSpotTarget,
  parseSpotTarget,
  spotMessageAdapter,
  spotOutboundAdapter,
} from "./outbound.js";
import {
  DEFAULT_ACCOUNT_ID,
  SPOT_CHANNEL_ID,
  type ResolvedSpotAccount,
} from "./types.js";
import { formatMissingSpotScopes } from "./scopes.js";

export interface SpotProbe {
  ok: true;
  selfId: string;
  displayName: string;
  orgIds: string[];
  scopes: string[];
}

const sharedBase = createChannelPluginBase<ResolvedSpotAccount>({
    id: SPOT_CHANNEL_ID,
    meta: {
      label: "Spot",
      selectionLabel: "Spot virtual office",
      docsPath: "/channels/spot",
      docsLabel: "Spot",
      blurb: "Let an OpenClaw agent participate in Spot as a managed bot avatar.",
      aliases: ["spotxyz"],
      markdownCapable: true,
      showInSetup: true,
      showConfigured: true,
      selectionExtras: [
        "Inbound activation stays disabled until allowFrom contains exact Spot user ids or an explicit *.",
      ],
    },
    capabilities: {
      chatTypes: ["direct", "group", "thread"],
      reply: false,
      threads: true,
      media: false,
      blockStreaming: false,
    },
    setup: {
      applyAccountConfig: applySpotAccountConfig,
      validateInput: ({ input }) => {
        if (!input.token?.trim()) return "A Spot API token is required.";
        if (input.baseUrl || input.url) {
          try {
            const url = new URL(input.baseUrl ?? input.url!);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
              return "Spot baseUrl must use http or https.";
            }
          } catch {
            return "Spot baseUrl must be a valid URL.";
          }
        }
        return null;
      },
      singleAccountKeysToMove: [
        "enabled",
        "name",
        "baseUrl",
        "token",
        "orgId",
        "worldId",
        "subscribeWorlds",
        "subscribeThreads",
        "defaultTarget",
        "activationMode",
        "allowFrom",
        "allowBotMessages",
        "avatar",
      ],
    },
    config: {
      listAccountIds: listSpotAccountIds,
      resolveAccount: resolveSpotAccount,
      inspectAccount: inspectSpotAccount,
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isEnabled: (account) => account.enabled,
      disabledReason: () => "Spot account is disabled.",
      isConfigured: (account) => !!account.token,
      unconfiguredReason: () => "Spot API token is missing.",
      describeAccount: (account) => ({
        accountId: account.accountId,
        ...(account.name ? { name: account.name } : {}),
        enabled: account.enabled,
        configured: !!account.token,
        statusState: account.enabled ? "configured" : "disabled",
      }),
      resolveAllowFrom: ({ cfg, accountId }) =>
        getMergedSpotAccountConfig(cfg, accountId).config.allowFrom,
      formatAllowFrom: ({ allowFrom }) => allowFrom.map(String),
      resolveDefaultTo: ({ cfg, accountId }) => {
        const target = getMergedSpotAccountConfig(cfg, accountId).config.defaultTarget;
        if (!target) return undefined;
        try {
          return normalizeSpotTarget(target);
        } catch {
          return undefined;
        }
      },
    },
    groups: {
      resolveRequireMention: ({ cfg, accountId }) =>
        getMergedSpotAccountConfig(cfg, accountId).config.activationMode !== "all",
    },
    agentPrompt: {
      messageToolHints: () => [
        "Spot conversations use thread:<threadId> targets. Use user:<userId> only to get or create a direct-message thread.",
        "Avatar world operations use the configured worldId and the spot_* avatar tools; a gateway message does not contain a worldId.",
      ],
      messageToolCapabilities: () => ["send text to Spot threads"],
      inboundFormattingHints: () => ({
        text_markup: "plain text with optional Markdown",
        rules: ["Treat the inbound Spot thread id as the durable reply target."],
      }),
    },
  });

const base = {
  ...sharedBase,
  config: sharedBase.config!,
  capabilities: sharedBase.capabilities!,
  secrets: {
    secretTargetRegistryEntries: spotSecretTargetRegistryEntries,
    collectRuntimeConfigAssignments: collectSpotRuntimeConfigAssignments,
  },
  gateway: {
    startAccount: async (ctx) => {
      const { startSpotGatewayAccount } = await import("./gateway.js");
      return startSpotGatewayAccount(ctx);
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
    },
    probeAccount: async ({ account, timeoutMs }): Promise<SpotProbe> => {
      const client = new SpotClient({
        baseUrl: account.baseUrl,
        token: account.token,
        fetch: (input, init) =>
          globalThis.fetch(input, {
            ...init,
            signal: AbortSignal.timeout(timeoutMs),
          }),
      });
      const me = await client.getMe();
      const scopeIssue = formatMissingSpotScopes(account, me.scopes);
      if (scopeIssue) throw new Error(scopeIssue);
      return {
        ok: true,
        selfId: me.user.id,
        displayName: me.user.displayName || me.user.fullName,
        orgIds: me.orgIds,
        scopes: me.scopes,
      };
    },
    buildChannelSummary: ({ account, snapshot }) => ({
      accountId: account.accountId,
      baseUrl: account.baseUrl,
      worldId: account.worldId ?? null,
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
    }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      ...(account.name ? { name: account.name } : {}),
      enabled: account.enabled,
      configured: true,
      linked: !!probe,
      statusState: probe ? "linked" : "configured",
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      ...(runtime?.lastError ? { lastError: runtime.lastError } : {}),
      ...(runtime?.lastConnectedAt === undefined
        ? {}
        : { lastConnectedAt: runtime.lastConnectedAt }),
    }),
  },
  message: spotMessageAdapter,
  messaging: {
    targetPrefixes: [SPOT_CHANNEL_ID],
    normalizeTarget: (raw) => {
      try {
        return normalizeSpotTarget(raw);
      } catch {
        return undefined;
      }
    },
    inferTargetChatType: ({ to }) =>
      parseSpotTarget(to).kind === "user" ? "direct" : "channel",
    targetResolver: {
      looksLikeId: (raw) => {
        try {
          parseSpotTarget(raw);
          return /^(?:spot:)?(?:thread|user|world|spot):/i.test(raw) ||
            /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(raw.trim());
        } catch {
          return false;
        }
      },
      hint: "thread:<threadId> or user:<userId>",
      resolveTarget: async ({ normalized }) => {
        try {
          const target = parseSpotTarget(normalized);
          return {
            to: normalizeSpotTarget(normalized),
            kind: target.kind === "user" ? "user" : "channel",
            source: "normalized",
          };
        } catch {
          return null;
        }
      },
    },
  },
} satisfies Omit<
  ChannelPlugin<ResolvedSpotAccount, SpotProbe>,
  "security" | "threading" | "outbound"
>;

export const spotChannelPlugin = createChatChannelPlugin<
  ResolvedSpotAccount,
  SpotProbe
>({
  base,
  security: {
    dm: {
      channelKey: SPOT_CHANNEL_ID,
      resolvePolicy: (account) =>
        account.allowFrom.includes("*") ? "open" : "allowlist",
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "allowlist",
      allowFromPathSuffix: "allowFrom",
    },
  },
  threading: { topLevelReplyToMode: "off" },
  outbound: spotOutboundAdapter,
});
