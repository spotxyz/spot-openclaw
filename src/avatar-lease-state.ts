interface ManagedAvatarLeaseState {
  suppressed: boolean;
  activeAttempts: number;
  idleWaiters: Set<() => void>;
  revision: number;
  changeWaiters: Set<() => void>;
}

const states = new Map<string, ManagedAvatarLeaseState>();

const stateKey = (accountId: string, worldId: string): string =>
  `${accountId}\u0000${worldId}`;

const getState = (
  accountId: string,
  worldId: string,
): ManagedAvatarLeaseState => {
  const key = stateKey(accountId, worldId);
  let state = states.get(key);
  if (!state) {
    state = {
      suppressed: false,
      activeAttempts: 0,
      idleWaiters: new Set(),
      revision: 0,
      changeWaiters: new Set(),
    };
    states.set(key, state);
  }
  return state;
};

const maybeDeleteState = (
  accountId: string,
  worldId: string,
  state: ManagedAvatarLeaseState,
): void => {
  if (
    !state.suppressed &&
    state.activeAttempts === 0 &&
    state.idleWaiters.size === 0 &&
    state.changeWaiters.size === 0
  ) {
    states.delete(stateKey(accountId, worldId));
  }
};

const notifyStateChange = (state: ManagedAvatarLeaseState): void => {
  state.revision += 1;
  for (const resolve of [...state.changeWaiters]) resolve();
};

export interface ManagedAvatarLeaseChangeSubscription {
  revision: number;
  promise: Promise<void>;
  dispose: () => void;
}

export const subscribeManagedAvatarLeaseChange = (
  accountId: string,
  worldId: string,
  signal?: AbortSignal,
): ManagedAvatarLeaseChangeSubscription => {
  const state = getState(accountId, worldId);
  let settled = false;
  let resolvePromise!: () => void;
  const finish = () => {
    if (settled) return;
    settled = true;
    state.changeWaiters.delete(finish);
    signal?.removeEventListener("abort", finish);
    resolvePromise();
    maybeDeleteState(accountId, worldId, state);
  };
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  state.changeWaiters.add(finish);
  signal?.addEventListener("abort", finish, { once: true });
  if (signal?.aborted) finish();
  return { revision: state.revision, promise, dispose: finish };
};

export const getManagedAvatarLeaseRevision = (
  accountId: string,
  worldId: string,
): number => states.get(stateKey(accountId, worldId))?.revision ?? 0;

export const beginManagedAvatarLeaseAttempt = (
  accountId: string,
  worldId: string,
): (() => void) | null => {
  const state = getState(accountId, worldId);
  if (state.suppressed) return null;
  state.activeAttempts += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    state.activeAttempts -= 1;
    if (state.activeAttempts === 0) {
      for (const resolve of state.idleWaiters) resolve();
      state.idleWaiters.clear();
    }
    maybeDeleteState(accountId, worldId, state);
  };
};

export const suppressManagedAvatarLease = async (
  accountId: string,
  worldId: string,
  signal?: AbortSignal,
): Promise<void> => {
  const state = getState(accountId, worldId);
  state.suppressed = true;
  notifyStateChange(state);
  if (state.activeAttempts === 0) return;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      state.idleWaiters.delete(finish);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    state.idleWaiters.add(finish);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const resumeManagedAvatarLease = (
  accountId: string,
  worldId: string,
): void => {
  const state = getState(accountId, worldId);
  state.suppressed = false;
  notifyStateChange(state);
  maybeDeleteState(accountId, worldId, state);
};

export const isManagedAvatarLeaseSuppressed = (
  accountId: string,
  worldId: string,
): boolean => states.get(stateKey(accountId, worldId))?.suppressed === true;
