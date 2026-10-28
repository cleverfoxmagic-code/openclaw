import { expect } from "vitest";
import { captureFreshDoctorMigrationTables } from "../commands/doctor-migration-backup.js";
import { CLIENT_CREDENTIAL_LEGACY_TABLES_SQL } from "../infra/client-credential-schema.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { quoteSqliteIdentifier } from "../infra/sqlite-schema-sql.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { createOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db-contract.js";
import { FIRST_USE_STATE_TABLES } from "./openclaw-state-db-contract.js";
import { TEMPLATE_STATE_TABLE_RENAMES } from "./openclaw-state-db-schema-v36-template-names.js";
import { repairOpenClawStateDatabaseSchema } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { createSqliteSchemaShapeFromSql } from "./sqlite-schema-shape.test-support.js";

/** Restore predecessor identifiers without filling missing columns or changing rows under test. */
export function restorePreTemplateStateIdentifiersForTest(database: EngineConnection): void {
  for (const [previous, current] of TEMPLATE_STATE_TABLE_RENAMES) {
    if (!database.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(current)) {
      continue;
    }
    database.exec(
      `ALTER TABLE ${quoteSqliteIdentifier(current)} RENAME TO ${quoteSqliteIdentifier(previous)};`,
    );
    const columns: readonly (readonly [string, string])[] =
      current === "template_installs"
        ? [
            ["template_name", "claw_name"],
            ["template_version", "claw_version"],
          ]
        : current === "template_package_refs"
          ? [["template_name", "claw_name"]]
          : [];
    for (const [column, oldColumn] of columns) {
      database.exec(
        `ALTER TABLE ${quoteSqliteIdentifier(previous)} RENAME COLUMN ${quoteSqliteIdentifier(column)} TO ${quoteSqliteIdentifier(oldColumn)};`,
      );
    }
  }
}

/** Current catalogs omit credentials and use names that no pre-cutover source understood. */
export function addPreCutoverClientCredentialTablesForTest(database: EngineConnection): void {
  restorePreTemplateStateIdentifiersForTest(database);
  database.exec(CLIENT_CREDENTIAL_LEGACY_TABLES_SQL);
}

/** Historical schema success paths retain the real owner and Doctor's fresh table backup. */
export async function withStateMigrationBackupForTest<T>(
  options: OpenClawStateDatabaseOptions,
  operation: () => T,
): Promise<Awaited<T>> {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env);
  const lease = acquireGatewayStateOwner({ databasePath: pathname });
  const resources = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    // Retain asynchronous work in the resource scope until process custody is released.
    return await resources.run(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, operation),
    );
  } finally {
    await resources.close();
    lease.release();
  }
}

export function createInitialStateSchemaShape(
  deletionJournal: "present" | "unavailable" = "present",
) {
  const shape = createSqliteSchemaShapeFromSql(
    new URL("./openclaw-state-schema.sql", import.meta.url),
  );
  for (const tableName of FIRST_USE_STATE_TABLES) {
    delete shape[tableName];
  }
  if (deletionJournal === "unavailable") {
    delete shape.agent_deletion_journal;
  }
  return shape;
}

export async function expectStateSchemaRepair(
  options: NonNullable<Parameters<typeof repairOpenClawStateDatabaseSchema>[0]>,
  changes: unknown[],
  warnings: unknown[] = [],
) {
  expect(
    await withStateMigrationBackupForTest(options, () =>
      repairOpenClawStateDatabaseSchema(options),
    ),
  ).toEqual({ changes, warnings });
}
