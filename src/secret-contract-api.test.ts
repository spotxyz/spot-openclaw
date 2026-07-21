import { describe, expect, it } from "vitest";

import {
  collectRuntimeConfigAssignments,
  secretTargetRegistryEntries,
} from "../secret-contract-api.js";

describe("Spot public secret contract", () => {
  it("exposes the runtime collector before the full plugin loads", () => {
    expect(collectRuntimeConfigAssignments).toBeTypeOf("function");
    expect(secretTargetRegistryEntries.map((entry) => entry.id)).toEqual([
      "channels.spot.accounts.*.token",
      "channels.spot.token",
    ]);
  });
});
