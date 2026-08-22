/**
 * Parent seeding for the conformance suite.
 *
 * An adapter is entitled to enforce referential integrity, and the Postgres schema does: a checkpoint
 * belongs to a run, a message and a binding belong to a conversation. The in-memory reference adapter
 * holds no such constraint, so the shared harnesses never created those parent rows — and every
 * foreign key added to the schema broke them.
 *
 * #95 solved that for `CheckpointStore` with a bespoke fixture type. #96 needed the same thing for
 * `ConversationBindingStore`, which is the point at which a one-off becomes a pattern. This is the
 * shared mechanism: a harness accepts either a bare store (adapters with no constraints, unchanged)
 * or a fixture pairing the store with the seeders its constraints require.
 *
 * The alternative was to drop the foreign keys so the harness would pass, which would have traded a
 * real guarantee — orphan rows are impossible — for a green suite. That is the wrong direction.
 */

import type { ConversationId, RunId, TenantId } from "../../core/ids.js";

/** Creates whatever parent row an adapter's constraints require. Omitted when there are none. */
export type ParentSeeders = {
  readonly seedRun?: (input: { readonly tenantId: TenantId; readonly runId: RunId }) => Promise<void>;
  readonly seedConversation?: (input: {
    readonly tenantId: TenantId;
    readonly conversationId: ConversationId;
  }) => Promise<void>;
};

/** A store plus the seeders its adapter needs. Harnesses accept this or a bare store. */
export type Fixture<TStore> = ParentSeeders & { readonly store: TStore };

/** What a harness is handed: either shape. */
export type FixtureOrStore<TStore> = TStore | Fixture<TStore>;

const isFixture = <TStore>(value: FixtureOrStore<TStore>): value is Fixture<TStore> =>
  typeof value === "object" && value !== null && "store" in value;

/**
 * Normalise whichever shape the adapter supplied. Returns the store and the seeders, so a harness can
 * seed unconditionally without caring which form it was given.
 */
export const openFixture = <TStore>(made: FixtureOrStore<TStore>): Fixture<TStore> =>
  isFixture(made) ? made : { store: made };

/** Seed a run if the adapter needs one, then hand back the store. */
export const withRun = async <TStore>(
  made: FixtureOrStore<TStore>,
  runs: readonly { tenantId: TenantId; runId: RunId }[],
): Promise<TStore> => {
  const fixture = openFixture(made);
  if (fixture.seedRun) for (const r of runs) await fixture.seedRun(r);
  return fixture.store;
};

/** Seed a conversation if the adapter needs one, then hand back the store. */
export const withConversation = async <TStore>(
  made: FixtureOrStore<TStore>,
  conversations: readonly { tenantId: TenantId; conversationId: ConversationId }[],
): Promise<TStore> => {
  const fixture = openFixture(made);
  if (fixture.seedConversation) for (const c of conversations) await fixture.seedConversation(c);
  return fixture.store;
};
