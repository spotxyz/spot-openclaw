import type { ResolvedSpotAccount } from "./types.js";

export const SPOT_SCOPE = {
  EventRead: "EventRead",
  EventWrite: "EventWrite",
  ThreadRead: "ThreadRead",
  ThreadWrite: "ThreadWrite",
  WorldRead: "WorldRead",
  AvatarWrite: "AvatarWrite",
} as const;

export const requiredSpotScopes = (
  account: ResolvedSpotAccount,
): string[] => {
  const required: string[] = [SPOT_SCOPE.EventRead, SPOT_SCOPE.EventWrite];
  if (account.monitorOrgChannels || account.subscribeThreads.length > 0) {
    required.push(SPOT_SCOPE.ThreadRead, SPOT_SCOPE.ThreadWrite);
  }
  if (
    account.worldId ||
    account.subscribeWorlds.length > 0 ||
    account.avatar
  ) {
    required.push(SPOT_SCOPE.WorldRead);
  }
  if (account.avatar) required.push(SPOT_SCOPE.AvatarWrite);
  return required;
};

export const missingSpotScopes = (
  account: ResolvedSpotAccount,
  grantedScopes: readonly string[],
): string[] => {
  const granted = new Set(grantedScopes);
  return requiredSpotScopes(account).filter((scope) => !granted.has(scope));
};

export const formatMissingSpotScopes = (
  account: ResolvedSpotAccount,
  grantedScopes: readonly string[],
): string | undefined => {
  const missing = missingSpotScopes(account, grantedScopes);
  return missing.length > 0
    ? `Spot token is missing required scopes: ${missing.join(", ")}.`
    : undefined;
};
