import { describe, expect, it } from "vitest";

import {
  formatMissingSpotScopes,
  missingSpotScopes,
  requiredSpotScopes,
} from "./scopes.js";
import type { ResolvedSpotAccount } from "./types.js";

const account = (
  patch: Partial<ResolvedSpotAccount> = {},
): ResolvedSpotAccount => ({
  accountId: "default",
  enabled: true,
  baseUrl: "https://spot.test",
  token: "token",
  activationMode: "direct-or-mention",
  allowFrom: ["user-1"],
  allowBotMessages: false,
  subscribeWorlds: [],
  subscribeThreads: [],
  ...patch,
});

describe("Spot scope health", () => {
  it("always requires EventRead and EventWrite for channel operation", () => {
    expect(requiredSpotScopes(account())).toEqual(["EventRead", "EventWrite"]);
    expect(missingSpotScopes(account(), ["EventRead"])).toEqual(["EventWrite"]);
  });

  it("requires WorldRead for configured world subscriptions", () => {
    expect(requiredSpotScopes(account({ worldId: "world-1" }))).toEqual([
      "EventRead",
      "EventWrite",
      "WorldRead",
    ]);
    expect(requiredSpotScopes(account({ subscribeWorlds: ["world-2"] }))).toContain(
      "WorldRead",
    );
  });

  it("requires AvatarWrite when avatar behavior is configured", () => {
    const configured = account({
      worldId: "world-1",
      avatar: { joinOnStart: true, spotId: "spot-1" },
    });
    expect(requiredSpotScopes(configured)).toEqual([
      "EventRead",
      "EventWrite",
      "WorldRead",
      "AvatarWrite",
    ]);
    expect(
      formatMissingSpotScopes(configured, ["EventRead", "EventWrite", "WorldRead"]),
    ).toBe("Spot token is missing required scopes: AvatarWrite.");
  });
});
