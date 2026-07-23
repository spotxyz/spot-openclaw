import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type {
  ChannelConfigSchema,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";

import { spotChannelPlugin, type SpotProbe } from "./src/channel.js";
import { configureSpotHistoryCursorPersistence } from "./src/history-cursor-state.js";
import { createSpotTools, SPOT_TOOL_NAMES } from "./src/tools.js";
import { SPOT_CHANNEL_ID, type ResolvedSpotAccount } from "./src/types.js";

export interface SpotOpenClawPluginEntry {
  id: string;
  name: string;
  description: string;
  configSchema: ChannelConfigSchema;
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: ChannelPlugin<ResolvedSpotAccount, SpotProbe>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
}

const entry: SpotOpenClawPluginEntry = defineChannelPluginEntry({
  id: SPOT_CHANNEL_ID,
  name: "Spot",
  description:
    "Spot chat channel and managed virtual-office avatar for OpenClaw.",
  plugin: spotChannelPlugin,
  registerFull(api) {
    configureSpotHistoryCursorPersistence(
      (options) => api.runtime.state.openKeyedStore(options),
      api.runtime.state.resolveStateDir(process.env)
    );
    api.registerTool(
      (context) => {
        const contextualAccountId =
          context.deliveryContext?.channel === SPOT_CHANNEL_ID
            ? context.deliveryContext.accountId
            : undefined;
        return createSpotTools({
          getConfig: () =>
            context.getRuntimeConfig?.() ??
            context.runtimeConfig ??
            context.config ??
            api.config,
          ...(contextualAccountId ? { accountId: contextualAccountId } : {}),
        });
      },
      { names: [...SPOT_TOOL_NAMES] }
    );
  },
});

export default entry;
export { spotChannelPlugin };
