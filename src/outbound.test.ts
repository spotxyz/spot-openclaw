import { describe, expect, it } from "vitest";

import {
  chunkSpotText,
  normalizeSpotTarget,
  parseSpotTarget,
  SPOT_MESSAGE_MAX_LENGTH,
  spotOutboundAdapter,
} from "./outbound.js";

describe("Spot target grammar", () => {
  it.each([
    ["thread:abc", { kind: "thread", id: "abc" }],
    ["user:user-1", { kind: "user", id: "user-1" }],
    ["world:world-1", { kind: "world", id: "world-1" }],
    ["spot:lobby", { kind: "spot", id: "lobby" }],
    ["spot:thread:abc", { kind: "thread", id: "abc" }],
    ["bare-thread-id", { kind: "thread", id: "bare-thread-id" }],
  ])("parses %s", (raw, expected) => {
    expect(parseSpotTarget(raw as string)).toEqual(expected);
  });

  it("normalizes provider-prefixed targets and rejects empty targets", () => {
    expect(normalizeSpotTarget(" spot:user:user-2 ")).toBe("user:user-2");
    expect(() => normalizeSpotTarget("   ")).toThrow(/required/);
    expect(() => normalizeSpotTarget("thread:   ")).toThrow(/empty/);
  });

  it("enforces Spot's 12,000-character boundary and advertises no native replyTo", () => {
    const boundary = "x".repeat(SPOT_MESSAGE_MAX_LENGTH);
    expect(chunkSpotText(boundary)).toEqual([boundary]);

    const overBoundary = `${boundary}y`;
    const chunks = chunkSpotText(overBoundary);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= SPOT_MESSAGE_MAX_LENGTH)).toBe(
      true,
    );
    expect(chunks.join("")).toBe(overBoundary);
    expect(spotOutboundAdapter.textChunkLimit).toBe(12_000);
    expect(spotOutboundAdapter.deliveryCapabilities?.durableFinal).toMatchObject({
      text: true,
      replyTo: false,
      thread: true,
    });
  });
});
