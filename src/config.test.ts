import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";

import {
  applySpotAccountConfig,
  getMergedSpotAccountConfig,
  listSpotAccountIds,
  resolveSpotAccount,
} from "./config.js";

const config = (spot: Record<string, unknown>): OpenClawConfig =>
  ({ channels: { spot } }) as OpenClawConfig;

describe("Spot account config", () => {
  it("uses the hosted Spot API origin by default", () => {
    expect(resolveSpotAccount(config({ token: "resolved-token" })).baseUrl).toBe(
      "https://spotvirtual.com",
    );
  });

  it("requires TLS except for loopback development servers", () => {
    expect(() =>
      resolveSpotAccount(
        config({ token: "resolved-token", baseUrl: "http://spot.example.com" }),
      ),
    ).toThrow(/https.*loopback/i);
    expect(
      resolveSpotAccount(
        config({ token: "resolved-token", baseUrl: "http://localhost:3210/" }),
      ).baseUrl,
    ).toBe("http://localhost:3210");
    expect(
      resolveSpotAccount(
        config({ token: "resolved-token", baseUrl: "http://127.0.0.1:3210" }),
      ).baseUrl,
    ).toBe("http://127.0.0.1:3210");
  });

  it("resolves root defaults and applies secure runtime token strings", () => {
    const cfg = config({
      baseUrl: "https://spot.test/",
      token: "resolved-token",
      worldId: "world-1",
    });

    expect(resolveSpotAccount(cfg)).toMatchObject({
      accountId: "default",
      baseUrl: "https://spot.test",
      token: "resolved-token",
      worldId: "world-1",
      activationMode: "direct-or-mention",
      allowBotMessages: false,
      monitorOrgChannels: false,
    });
    expect(listSpotAccountIds(cfg)).toEqual(["default"]);
  });

  it("lets named accounts override inherited top-level fields", () => {
    const cfg = config({
      baseUrl: "https://spot.test",
      activationMode: "mentions",
      accounts: {
        hq: { token: "hq-token", worldId: "hq-world", activationMode: "all" },
        eu: { token: "eu-token", worldId: "eu-world" },
      },
    });

    expect(listSpotAccountIds(cfg)).toEqual(["hq", "eu"]);
    expect(resolveSpotAccount(cfg, "hq")).toMatchObject({
      baseUrl: "https://spot.test",
      worldId: "hq-world",
      activationMode: "all",
    });
    expect(getMergedSpotAccountConfig(cfg, "eu").tokenPath).toBe(
      "channels.spot.accounts.eu.token",
    );
  });

  it("refuses an unresolved SecretRef at execution time", () => {
    const cfg = config({
      token: { source: "env", provider: "default", id: "SPOT_AGENT_TOKEN" },
    });
    expect(() => resolveSpotAccount(cfg)).toThrow(/SecretRef|resolved|token/i);
  });

  it("rejects managed-avatar startup without a world", () => {
    expect(() =>
      resolveSpotAccount(
        config({ token: "resolved-token", avatar: { joinOnStart: true } }),
      ),
    ).toThrow(/joinOnStart.*worldId/);
  });

  it("requires orgId when organization channel monitoring is enabled", () => {
    expect(() =>
      resolveSpotAccount(
        config({ token: "resolved-token", monitorOrgChannels: true }),
      ),
    ).toThrow(/monitorOrgChannels.*orgId/);
    expect(
      resolveSpotAccount(
        config({
          token: "resolved-token",
          orgId: "org-1",
          monitorOrgChannels: true,
        }),
      ).monitorOrgChannels,
    ).toBe(true);
  });

  it("writes setup input into the default channel account", () => {
    const updated = applySpotAccountConfig({
      cfg: config({}),
      accountId: "default",
      input: {
        token: "new-token",
        baseUrl: "http://127.0.0.1:3000",
        name: "Local Spot",
      },
    });
    expect(updated.channels?.spot).toMatchObject({
      enabled: true,
      token: "new-token",
      baseUrl: "http://127.0.0.1:3000",
      name: "Local Spot",
    });
  });
});
