import { DatabaseAdapter, Schema } from "./types.js";
/**
 * Checks that a `DatabaseAdapter` keeps the guarantees the homeserver relies on (see the
 * interface's documentation). Each check gets a fresh adapter on which `CONFORMANCE_SCHEMA` was
 * migrated, and throws (an `AssertionError`) when the adapter falls short. They do not depend on a
 * test framework:
 *
 *   for (const check of adapterConformance) test(check.name, async () => check.run(await freshAdapter()));
 *
 * https://github.com/k18k/katrix/issues/58: the contract was implicit, so a custom
 * adapter could miss a guarantee (an atomic conditional delete, a rollback) without anything noticing.
 */
export interface ConformanceCheck {
  name: string;
  run(adapter: DatabaseAdapter): Promise<void>;
}
/** The tables the checks use. Migrate them before each check (`adapter.migrate(CONFORMANCE_SCHEMA)`). */
export declare const CONFORMANCE_SCHEMA: Schema;
export declare const adapterConformance: ConformanceCheck[];
//# sourceMappingURL=conformance.d.ts.map