import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";

/**
 * Clears all binding storage and reapplies migrations, so a test starts from a
 * known empty schema. `reset()` drops the D1 schema as well, hence the reapply.
 */
export async function resetDatabase(): Promise<void> {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/**
 * A D1 stand-in whose queries never answer until `release()`, like D1 during
 * the 2026-10-24 outage. Release before `waitOnExecutionContext`, or the
 * writes left in `waitUntil` keep it waiting.
 */
export function stuckDatabase(): { db: D1Database; release(): void } {
  const pending: Array<(error: Error) => void> = [];
  const hang = () => new Promise<never>((_, reject) => pending.push(reject));
  const statement = { bind: () => statement, run: hang, first: hang, all: hang, raw: hang };
  const db = { prepare: () => statement, batch: hang } as unknown as D1Database;
  return { db, release: () => pending.splice(0).forEach((reject) => reject(new Error("released"))) };
}

/** Wraps a database and counts round trips: every statement run and every `batch`. */
export function countingDatabase(db: D1Database): { db: D1Database; calls(): number } {
  let calls = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values));
        }
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
            calls += 1;
          }
          return value.apply(target, args);
        };
      },
    });
    real.set(wrapped, statement);
    return wrapped;
  };
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => wrap(target.prepare(query));
      }
      if (prop === "batch") {
        return (statements: D1PreparedStatement[]) => {
          calls += 1;
          return target.batch(statements.map((statement) => real.get(statement) ?? statement));
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: counted, calls: () => calls };
}
