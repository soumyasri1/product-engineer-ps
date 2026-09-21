/**
 * Memory lifecycle.
 *
 * Exactly three states exist, and they are the only thing that decides whether a memory
 * can be presented as current. Anything else a memory might be -- contested, low
 * confidence, recently edited -- is modelled elsewhere (see `Conflict`) so that this
 * state machine stays small enough to reason about.
 *
 *   active      the fact is believed true now; the only state eligible for retrieval
 *   superseded  the fact was true and has been replaced by a newer memory
 *   deleted     the fact was withdrawn; never eligible for retrieval
 */
export const LIFECYCLE_STATES = ["active", "superseded", "deleted"] as const;

export type Lifecycle = (typeof LIFECYCLE_STATES)[number];

/**
 * Legal transitions. Both `superseded` and `deleted` are terminal: once a memory stops
 * being current it never becomes current again. A later identical value is a *new*
 * memory with a new identity, which is what keeps the history append-only and keeps
 * "I moved back to Pune" honest -- it does not resurrect the original Pune memory.
 */
const TRANSITIONS: Readonly<Record<Lifecycle, readonly Lifecycle[]>> = {
  active: ["superseded", "deleted"],
  superseded: [],
  deleted: [],
};

export function canTransition(from: Lifecycle, to: Lifecycle): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isRetrievable(state: Lifecycle): state is "active" {
  return state === "active";
}

export function isLifecycle(value: string): value is Lifecycle {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}
