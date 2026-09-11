const RELOAD_HANDOFFS = Symbol.for("@narumitw/pi-fleet/reload-handoffs");

export interface FleetReloadHandoff {
  invite: string;
  acceptsRequests: boolean;
  launchId?: string;
  kickoffCapability?: string;
  kickoffConsumed: boolean;
  expiresAt: number;
}

export function putReloadHandoff(owner: object, handoff: FleetReloadHandoff): void {
  reloadHandoffs().set(owner, handoff);
}

export function takeReloadHandoff(owner: object, now: number): FleetReloadHandoff | undefined {
  const store = reloadHandoffs();
  const value = store.get(owner);
  store.delete(owner);
  return value && value.expiresAt >= now ? value : undefined;
}

function reloadHandoffs(): WeakMap<object, FleetReloadHandoff> {
  const root = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = root[RELOAD_HANDOFFS];
  if (existing instanceof WeakMap) return existing as WeakMap<object, FleetReloadHandoff>;
  const created = new WeakMap<object, FleetReloadHandoff>();
  root[RELOAD_HANDOFFS] = created;
  return created;
}
