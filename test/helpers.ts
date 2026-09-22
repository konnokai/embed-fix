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
