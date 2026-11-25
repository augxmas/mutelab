import sql from "mssql";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const expectedObjects = [
  ["dbo.AptComplex", "U"],
  ["dbo.AptComplexDetail", "U"],
  ["dbo.AptApiDailyUsage", "U"],
  ["dbo.AptListMigrationState", "U"],
  ["dbo.AptDetailFetchState", "U"],
  ["dbo.AptDailyMigrationRun", "U"],
  ["dbo.UpsertAptComplexListPage", "P"],
  ["dbo.UpsertAptComplexEndpoint", "P"],
] as const;

const expectedColumns: ReadonlyArray<readonly [string, string]> = [
  ["dbo.AptComplex", "kaptCode"],
  ["dbo.AptComplex", "rawJson"],
  ["dbo.AptComplexDetail", "kaptCode"],
  ["dbo.AptComplexDetail", "rawJson"],
  ["dbo.AptComplexDetail", "extendedRawJson"],
  ["dbo.AptComplexDetail", "basicFetchedAt"],
  ["dbo.AptComplexDetail", "extendedFetchedAt"],
  ["dbo.AptApiDailyUsage", "usageDate"],
  ["dbo.AptApiDailyUsage", "requestCount"],
  ["dbo.AptListMigrationState", "nextPage"],
  ["dbo.AptListMigrationState", "lastCompletedDate"],
  ["dbo.AptDetailFetchState", "endpoint"],
  ["dbo.AptDetailFetchState", "nextAttemptAt"],
  ["dbo.AptDailyMigrationRun", "businessDate"],
  ["dbo.AptDailyMigrationRun", "remainingEndpoints"],
];

const expectedPermissions: ReadonlyArray<readonly [string, string]> = [
  ["dbo.AptComplex", "SELECT"],
  ["dbo.AptComplexDetail", "SELECT"],
  ["dbo.AptApiDailyUsage", "SELECT"],
  ["dbo.AptApiDailyUsage", "INSERT"],
  ["dbo.AptApiDailyUsage", "UPDATE"],
  ["dbo.AptListMigrationState", "SELECT"],
  ["dbo.AptListMigrationState", "UPDATE"],
  ["dbo.AptDetailFetchState", "SELECT"],
  ["dbo.AptDetailFetchState", "INSERT"],
  ["dbo.AptDetailFetchState", "UPDATE"],
  ["dbo.AptDailyMigrationRun", "INSERT"],
  ["dbo.AptDailyMigrationRun", "UPDATE"],
  ["dbo.UpsertAptComplexListPage", "EXECUTE"],
  ["dbo.UpsertAptComplexEndpoint", "EXECUTE"],
];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

async function validateSchemaSyntax(pool: sql.ConnectionPool): Promise<void> {
  const schema = await readFile(resolve(__dirname, "..", "daily-schema.sql"), "utf8");
  const batches = schema.split(/^\s*GO\s*$/gim).map((batch) => batch.trim()).filter(Boolean);
  await pool.request().batch("SET PARSEONLY ON;");
  try {
    for (const batch of batches) await pool.request().batch(batch);
  } finally {
    await pool.request().batch("SET PARSEONLY OFF;");
  }
}

async function main(): Promise<void> {
  const server = required("SQL_SERVER");
  const localServer = ["localhost", "127.0.0.1", "."].includes(server.toLowerCase());
  const encrypt = process.env.SQL_ENCRYPT == null
    ? !localServer
    : process.env.SQL_ENCRYPT === "true";
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY?.trim() ?? "";
  const serviceKeyConfigured = serviceKey.length > 0 &&
    !/replace|your[_-]?key|발급/i.test(serviceKey);
  const pool = await new sql.ConnectionPool({
    server,
    port: Number(process.env.SQL_PORT || 1433),
    database: required("SQL_DATABASE"),
    user: process.env.SQL_USER?.trim() || required("DB_USER"),
    password: process.env.SQL_PASSWORD || required("DB_PASSWORD"),
    options: {
      encrypt,
      trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === "true" ||
        (process.env.SQL_TRUST_SERVER_CERTIFICATE == null && localServer),
    },
    pool: { max: 1, min: 1, idleTimeoutMillis: 30_000 },
  }).connect();
  try {
    await validateSchemaSyntax(pool);
    const missingObjects: string[] = [];
    for (const [objectName, objectType] of expectedObjects) {
      const result = await pool.request()
        .input("objectName", sql.NVarChar(255), objectName)
        .input("objectType", sql.NVarChar(2), objectType)
        .query<{ present: boolean | number }>(
          "SELECT IIF(OBJECT_ID(@objectName,@objectType) IS NULL,0,1) AS present",
        );
      if (!Boolean(result.recordset[0]?.present)) missingObjects.push(objectName);
    }
    const missingColumns: string[] = [];
    for (const [tableName, columnName] of expectedColumns) {
      const result = await pool.request()
        .input("tableName", sql.NVarChar(255), tableName)
        .input("columnName", sql.NVarChar(255), columnName)
        .query<{ present: boolean | number }>(
          "SELECT IIF(COL_LENGTH(@tableName,@columnName) IS NULL,0,1) AS present",
        );
      if (!Boolean(result.recordset[0]?.present)) missingColumns.push(`${tableName}.${columnName}`);
    }
    const missingPermissions: string[] = [];
    for (const [objectName, permissionName] of expectedPermissions) {
      const result = await pool.request()
        .input("objectName", sql.NVarChar(255), objectName)
        .input("permissionName", sql.NVarChar(20), permissionName)
        .query<{ permitted: boolean | number }>(
          "SELECT COALESCE(HAS_PERMS_BY_NAME(@objectName,'OBJECT',@permissionName),0) AS permitted",
        );
      if (!Boolean(result.recordset[0]?.permitted)) {
        missingPermissions.push(`${permissionName} ${objectName}`);
      }
    }
    let listStateRowReady = false;
    if (!missingObjects.includes("dbo.AptListMigrationState")) {
      const state = await pool.request().query<{ present: boolean | number }>(
        "SELECT IIF(EXISTS(SELECT 1 FROM dbo.AptListMigrationState WHERE stateId=1),1,0) AS present",
      );
      listStateRowReady = Boolean(state.recordset[0]?.present);
    }
    let apartmentCount: number | null = null;
    let detailCount: number | null = null;
    if (!missingObjects.includes("dbo.AptComplex")) {
      const count = await pool.request().query<{ value: number | string }>(
        "SELECT COUNT_BIG(*) AS value FROM dbo.AptComplex",
      );
      apartmentCount = Number(count.recordset[0]?.value ?? 0);
    }
    if (!missingObjects.includes("dbo.AptComplexDetail")) {
      const count = await pool.request().query<{ value: number | string }>(
        "SELECT COUNT_BIG(*) AS value FROM dbo.AptComplexDetail",
      );
      detailCount = Number(count.recordset[0]?.value ?? 0);
    }
    const permission = await pool.request().query<{ canCreateTable: boolean | number }>(
      "SELECT HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE TABLE') AS canCreateTable",
    );
    const result = {
      ready: serviceKeyConfigured && missingObjects.length === 0 && missingColumns.length === 0 &&
        missingPermissions.length === 0 && listStateRowReady,
      serviceKeyConfigured,
      schemaSyntaxValid: true,
      migrationSchemaReady: missingObjects.length === 0,
      missingObjects,
      missingColumns,
      missingPermissions,
      listStateRowReady,
      apartmentCount,
      detailCount,
      currentLoginCanCreateTable: Boolean(permission.recordset[0]?.canCreateTable),
    };
    console.info(JSON.stringify(result));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await pool.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Apartment migration preflight failed: ${message.slice(0, 500)}`);
  process.exitCode = 1;
});
