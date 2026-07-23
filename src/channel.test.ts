import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";

import { spotChannelPlugin } from "./channel.js";
import type { ResolvedSpotAccount } from "./types.js";

const account: ResolvedSpotAccount = {
  accountId: "default",
  enabled: true,
  baseUrl: "https://spot.test",
  token: "token",
  activationMode: "direct-or-mention",
  threadPolicies: {},
  allowFrom: ["user-1"],
  allowBotMessages: false,
  subscribeWorlds: [],
  subscribeThreads: [],
  monitorOrgChannels: false,
  monitorAvatarActivity: false,
};

describe("Spot channel status", () => {
  it("preserves advanced activation settings during account promotion", () => {
    expect(spotChannelPlugin.setup?.singleAccountKeysToMove).toEqual(
      expect.arrayContaining(["monitorAvatarActivity", "threadPolicies"]),
    );
  });

  it("advertises reply threads and shared reactions", () => {
    expect(spotChannelPlugin.capabilities).toMatchObject({
      reply: true,
      threads: true,
      reactions: true,
    });
    expect(
      spotChannelPlugin.threading?.resolveReplyToMode?.({
        cfg: {} as OpenClawConfig,
      }),
    ).toBe("all");
    expect(spotChannelPlugin.actions?.supportsAction?.({ action: "react" })).toBe(
      true,
    );
  });

  it("projects standard lifecycle and activity fields from the gateway runtime", async () => {
    const buildAccountSnapshot = spotChannelPlugin.status?.buildAccountSnapshot;
    expect(buildAccountSnapshot).toBeDefined();

    const snapshot = await buildAccountSnapshot!({
      account,
      cfg: {} as OpenClawConfig,
      runtime: {
        accountId: "default",
        running: true,
        connected: true,
        lastStartAt: 1_784_616_200_000,
        reconnectAttempts: 2,
        lastInboundAt: 1_784_616_235_080,
        lastOutboundAt: 1_784_616_246_529,
      },
    });

    expect(snapshot).toMatchObject({
      accountId: "default",
      running: true,
      connected: true,
      lastStartAt: 1_784_616_200_000,
      lastStopAt: null,
      lastError: null,
      reconnectAttempts: 2,
      lastInboundAt: 1_784_616_235_080,
      lastOutboundAt: 1_784_616_246_529,
    });
  });
});
