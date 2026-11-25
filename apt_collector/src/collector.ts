import sql from "mssql";

const API_URL = "https://apis.data.go.kr/1613000/AptListService4/getTotalAptList4";
const DETAIL_API_URL = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5";
const DETAIL_REQUEST_DELAY_MS = 1_250;
const PAGE_SIZE = numberEnv("APT_PAGE_SIZE", 500);
const POLL_SECONDS = numberEnv("APT_POLL_SECONDS", 3600);
const REQUEST_DELAY_MS = numberEnv("APT_REQUEST_DELAY_SECONDS", 200);

type AptItem = Record<string, unknown>;
type ApiEnvelope = { response?: { header?: { resultCode?: string; resultMsg?: string }; body?: { items?: { item?: AptItem | AptItem[] }; totalCount?: number | string } } };

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function sqlConfig(): sql.config {
  const server = requiredEnv("SQL_SERVER");
  const localServer = ["localhost", "127.0.0.1", "."].includes(server.toLowerCase());
  const encrypt = process.env.SQL_ENCRYPT == null
    ? !localServer
    : process.env.SQL_ENCRYPT === "true";
  return {
    server, port: numberEnv("SQL_PORT", 1433),
    database: requiredEnv("SQL_DATABASE"),
    user: process.env.SQL_USER || requiredEnv("DB_USER"),
    password: process.env.SQL_PASSWORD || requiredEnv("DB_PASSWORD"),
    options: {
      encrypt,
      trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === "true" ||
        (process.env.SQL_TRUST_SERVER_CERTIFICATE === undefined && localServer),
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
  };
}

function decodePortalKey(key: string): string {
  try { return decodeURIComponent(key); } catch { return key; }
}

async function fetchPage(pageNo: number): Promise<{ items: AptItem[]; totalCount: number }> {
  const params = new URLSearchParams({ serviceKey: decodePortalKey(requiredEnv("DATA_GO_KR_SERVICE_KEY")), pageNo: String(pageNo), numOfRows: String(PAGE_SIZE), _type: "json" });
  const response = await fetch(`${API_URL}?${params}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`API HTTP ${response.status}: ${await response.text()}`);
  const envelope = (await response.json() as ApiEnvelope).response;
  if (!envelope) throw new Error("API response is missing the response object");
  const code = envelope.header?.resultCode ?? "00";
  if (code !== "00" && code !== "0") throw new Error(`API error ${code}: ${envelope.header?.resultMsg ?? "Unknown error"}`);
  const body = envelope.body ?? {};
  const rawItems = body.items?.item;
  return { items: rawItems == null ? [] : Array.isArray(rawItems) ? rawItems : [rawItems], totalCount: Number(body.totalCount ?? 0) };
}

async function ensureSchema(pool: sql.ConnectionPool): Promise<void> {
  await pool.request().query(`
IF OBJECT_ID(N'dbo.AptComplex', N'U') IS NULL
BEGIN
 CREATE TABLE dbo.AptComplex (
  kaptCode nvarchar(50) NOT NULL CONSTRAINT PK_AptComplex PRIMARY KEY,
  kaptName nvarchar(500) NULL, sido nvarchar(100) NULL, sigungu nvarchar(100) NULL,
  address nvarchar(1000) NULL, rawJson nvarchar(max) NOT NULL,
  firstSeenAt datetime2(0) NOT NULL CONSTRAINT DF_AptComplex_firstSeen DEFAULT SYSUTCDATETIME(),
  lastSeenAt datetime2(0) NOT NULL,
  CONSTRAINT CK_AptComplex_rawJson CHECK (ISJSON(rawJson) = 1)
 );
END;
IF OBJECT_ID(N'dbo.AptCollectionRun', N'U') IS NULL
BEGIN
 CREATE TABLE dbo.AptCollectionRun (
  runId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_AptCollectionRun PRIMARY KEY,
  startedAt datetime2(0) NOT NULL, completedAt datetime2(0) NULL, apiTotalCount int NULL,
  fetchedCount int NOT NULL CONSTRAINT DF_AptCollectionRun_fetched DEFAULT 0,
  status nvarchar(20) NOT NULL, error nvarchar(2000) NULL
 );
END;`);
}

function field(item: AptItem, ...names: string[]): string | null {
  for (const name of names) { const value = item[name]; if (value != null && String(value).trim()) return String(value).trim(); }
  return null;
}

async function upsertPage(pool: sql.ConnectionPool, items: AptItem[]): Promise<void> {
  for (const item of items) {
    const kaptCode = field(item, "kaptCode", "KAPT_CODE");
    if (!kaptCode) throw new Error(`API item is missing kaptCode: ${JSON.stringify(item)}`);
    await pool.request()
      .input("kaptCode", sql.NVarChar(50), kaptCode)
      .input("kaptName", sql.NVarChar(500), field(item, "kaptName", "KAPT_NAME"))
      .input("sido", sql.NVarChar(100), field(item, "as1", "sido"))
      .input("sigungu", sql.NVarChar(100), field(item, "as2", "sigungu"))
      .input("address", sql.NVarChar(1000), field(item, "kaptAddr", "roadname") ??
        ([field(item, "as3"), field(item, "as4")].filter(Boolean).join(" ") || null))
      .input("rawJson", sql.NVarChar(sql.MAX), JSON.stringify(item))
      .query(`MERGE dbo.AptComplex WITH (HOLDLOCK) AS target
USING (SELECT @kaptCode AS kaptCode, @kaptName AS kaptName, @sido AS sido, @sigungu AS sigungu, @address AS address, @rawJson AS rawJson) AS source
ON target.kaptCode=source.kaptCode
WHEN MATCHED THEN UPDATE SET kaptName=source.kaptName,sido=source.sido,sigungu=source.sigungu,address=source.address,rawJson=source.rawJson,lastSeenAt=SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT(kaptCode,kaptName,sido,sigungu,address,rawJson,lastSeenAt) VALUES(source.kaptCode,source.kaptName,source.sido,source.sigungu,source.address,source.rawJson,SYSUTCDATETIME());`);
  }
}

async function collectOnce(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().input("startedAt", sql.DateTime2, new Date())
    .query(`INSERT dbo.AptCollectionRun(startedAt,status) VALUES(@startedAt,'RUNNING'); SELECT CONVERT(bigint,SCOPE_IDENTITY()) AS runId;`);
  const runId = result.recordset[0].runId as number;
  let fetched = 0; let total = 0;
  try {
    for (let pageNo = 1; ; pageNo++) {
      const page = await fetchPage(pageNo);
      if (pageNo === 1) total = page.totalCount;
      if (!page.items.length) break;
      await upsertPage(pool, page.items);
      fetched += page.items.length;
      console.info(`run=${runId} page=${pageNo} fetched=${fetched}/${total}`);
      if (fetched >= total || page.items.length < PAGE_SIZE) break;
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS));
    }
    await pool.request().input("runId", sql.BigInt, runId).input("total", sql.Int, total).input("fetched", sql.Int, fetched)
      .query(`UPDATE dbo.AptCollectionRun SET completedAt=SYSUTCDATETIME(),apiTotalCount=@total,fetchedCount=@fetched,status='SUCCEEDED' WHERE runId=@runId`);
    if (total > 0 && fetched < total) console.warn(`API total ${total}; fetched ${fetched}. Next run will retry.`);
  } catch (error) {
    await pool.request().input("runId", sql.BigInt, runId).input("fetched", sql.Int, fetched).input("error", sql.NVarChar(2000), String(error).slice(0, 2000))
      .query(`UPDATE dbo.AptCollectionRun SET completedAt=SYSUTCDATETIME(),fetchedCount=@fetched,status='FAILED',error=@error WHERE runId=@runId`);
    throw error;
  }
}

async function collectDetails(pool: sql.ConnectionPool): Promise<void> {
  const limit = numberEnv("APT_DETAIL_LIMIT", 100);
  if (!Number.isInteger(limit) || limit < 1 || limit > 2_147_483_647) {
    throw new Error("APT_DETAIL_LIMIT must be a positive SQL Server int");
  }
  const key = decodePortalKey(requiredEnv("DATA_GO_KR_SERVICE_KEY"));
  const { recordset } = await pool.request().input("limit", sql.Int, limit).query<{ kaptCode: string }>(`
    SELECT TOP (@limit) a.kaptCode
    FROM dbo.AptComplex AS a
    LEFT JOIN dbo.AptComplexDetail AS d ON d.kaptCode=a.kaptCode
    ORDER BY d.fetchedAt, a.kaptCode;
  `);
  let saved = 0;
  for (const { kaptCode } of recordset) {
    try {
      const params = new URLSearchParams({ serviceKey: key, kaptCode, _type: "json" });
      const response = await fetch(`${DETAIL_API_URL}?${params}`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error("HTTP error");
      const { response: envelope } = await response.json() as {
        response?: { header?: { resultCode?: string }; body?: { item?: AptItem } };
      };
      const detail = envelope?.body?.item;
      if (!["00", "0"].includes(String(envelope?.header?.resultCode)) || !detail || detail.kaptCode !== kaptCode) {
        throw new Error("Invalid detail response");
      }
      await pool.request().input("payload", sql.NVarChar(sql.MAX), JSON.stringify([detail]))
        .execute("dbo.UpsertAptComplexDetails");
      saved += 1;
    } catch {
      console.error(`Could not refresh detail for ${kaptCode}`);
    }
    await new Promise(resolve => setTimeout(resolve, DETAIL_REQUEST_DELAY_MS));
  }
  console.info(`Saved apartment details: ${saved}/${recordset.length}`);
  if (saved !== recordset.length) process.exitCode = 1;
}

async function main(): Promise<void> {
  const pool = await new sql.ConnectionPool(sqlConfig()).connect();
  try {
    if (process.argv.includes("--details")) {
      await collectDetails(pool);
      return;
    }
    await ensureSchema(pool);
    for (;;) {
      try { await collectOnce(pool); console.info("Collection completed"); }
      catch (error) { console.error("Collection failed; retrying at next interval:", error); }
      await new Promise(resolve => setTimeout(resolve, POLL_SECONDS * 1000));
    }
  } finally { await pool.close(); }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
