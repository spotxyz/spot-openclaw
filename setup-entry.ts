import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { spotChannelPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(spotChannelPlugin);
