import sql from "mssql";
import { setTimeout as sleep } from "node:timers/promises";

const LIST_API_URL = "https://apis.data.go.kr/1613000/AptListService4/getTotalAptList4";
const BASIS_API_ROOT = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5";
const SEOUL_TIME_ZONE = "Asia/Seoul";
const RUN_LOCK_NAME = "MuteLab:AptDailyMigration:v1";

type ApiName = "LIST" | "BASIS";
type DetailEndpoint = "BASIC" | "EXTENDED";
type JsonObject = Record<string, unknown>;

type RunMetrics = {
  listRequests: number;
  listItems: number;
  listTotal: number | null;
  detailRequests: number;
  detailSaved: number;
  detailNoData: number;
  detailFailed: number;
};

type ApiEnvelope = {
  response?: {
    header?: { resultCode?: string | number; resultMsg?: string };
    body?: {
      item?: unknown;
      items?: { item?: unknown } | unknown[];
      totalCount?: string | number;
    };
  };
};

type ListState = {
  nextPage: number;
  pageSize: number;
  totalCount: number | null;
  lastCompletedDate: Date | string | null;
};

type DetailCandidate = {
  kaptCode: string;
  endpoint: DetailEndpoint;
  attemptCount: number;
};

const DETAIL_ENDPOINTS: Record<DetailEndpoint, string> = {
  BASIC: "getAphusBassInfoV5",
  EXTENDED: "getAphusDtlInfoV5",
};

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const LIST_PAGE_SIZE = integerEnv("APT_LIST_PAGE_SIZE", integerEnv("APT_PAGE_SIZE", 500, 1, 1000), 1, 1000);
const LIST_DAILY_LIMIT = integerEnv("APT_LIST_DAILY_REQUEST_LIMIT", 5000, 1, 5000);
const BASIS_DAILY_LIMIT = integerEnv("APT_BASIS_DAILY_REQUEST_LIMIT", 5000, 1, 5000);
const LIST_REQUEST_DELAY_MS = integerEnv("APT_LIST_REQUEST_DELAY_MS", 200, 0, 60_000);
const DETAIL_REQUEST_DELAY_MS = integerEnv("APT_DETAIL_REQUEST_DELAY_MS", 1250, 0, 60_000);
const DETAIL_REFRESH_DAYS = integerEnv("APT_DETAIL_REFRESH_DAYS", 30, 1, 3650);
const NO_DATA_RETRY_DAYS = integerEnv("APT_NO_DATA_RETRY_DAYS", 7, 1, 3650);
const FAILED_RETRY_MINUTES = integerEnv("APT_FAILED_RETRY_MINUTES", 60, 1, 43_200);
const HTTP_RETRIES = integerEnv("APT_HTTP_RETRIES", 3, 0, 10);
const HTTP_TIMEOUT_MS = integerEnv("APT_HTTP_TIMEOUT_MS", 60_000, 1000, 300_000);
const MAX_RETRY_DELAY_MS = integerEnv("APT_MAX_RETRY_DELAY_MS", 300_000, 1000, 3_600_000);
const MAX_CONSECUTIVE_FAILURES = integerEnv("APT_MAX_CONSECUTIVE_FAILURES", 10, 1, 100);
const lastRequestAt: Record<ApiName, number> = { LIST: 0, BASIS: 0 };

class QuotaExhaustedError extends Error {
  constructor(public readonly apiName: ApiName, message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

class BusinessDateChangedError extends Error {
  constructor() {
    super("Asia/Seoul business date changed while the migration was running");
    this.name = "BusinessDateChangedError";
  }
}

class ApiCallError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly quotaExceeded = false,
    public readonly retryAfterMs: number | null = null,
    public readonly fatal = false,
  ) {
    super(message);
    this.name = "ApiCallError";
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Environment variable ${name} is required`);
  return value;
}

function sqlConfig(poolSize = 5): sql.config {
  const server = requiredEnv("SQL_SERVER");
  const localServer = ["localhost", "127.0.0.1", "."].includes(server.toLowerCase());
  const encrypt = process.env.SQL_ENCRYPT == null
    ? !localServer
    : process.env.SQL_ENCRYPT === "true";
  return {
    server,
    port: integerEnv("SQL_PORT", 1433, 1, 65_535),
    database: requiredEnv("SQL_DATABASE"),
    user: process.env.SQL_USER?.trim() || requiredEnv("DB_USER"),
    password: process.env.SQL_PASSWORD || requiredEnv("DB_PASSWORD"),
    options: {
      encrypt,
      trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === "true" ||
        (process.env.SQL_TRUST_SERVER_CERTIFICATE == null && localServer),
    },
    pool: { max: poolSize, min: poolSize === 1 ? 1 : 0, idleTimeoutMillis: 300_000 },
    requestTimeout: 120_000,
  };
}

function decodePortalKey(key: string): string {
  try { return decodeURIComponent(key); } catch { return key; }
}

function seoulBusinessDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SEOUL_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateParameter(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateOnly(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObjectArray(value: unknown): JsonObject[] {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter(isObject);
}

function envelopeFrom(payload: unknown): NonNullable<ApiEnvelope["response"]> {
  if (!isObject(payload) || !isObject(payload.response)) {
    throw new ApiCallError("Public API response envelope is missing", true);
  }
  return payload.response as NonNullable<ApiEnvelope["response"]>;
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

function portalXmlError(text: string): ApiCallError | null {
  const code = text.match(/<(?:returnReasonCode|resultCode)>\s*([^<]+)\s*<\//i)?.[1]?.trim();
  if (!code) return null;
  const message = text.match(/<(?:returnAuthMsg|errMsg|resultMsg)>\s*([^<]+)\s*<\//i)?.[1]?.trim() ??
    "Public API XML error";
  const quotaExceeded = code === "22";
  const fatal = ["10", "20", "21", "30", "31", "32"].includes(code);
  return new ApiCallError(
    `Public API error ${code}: ${message.slice(0, 300)}`,
    !fatal && !quotaExceeded,
    quotaExceeded,
    null,
    fatal,
  );
}

function portalJsonError(payload: unknown): ApiCallError | null {
  if (!isObject(payload) || !isObject(payload.OpenAPI_ServiceResponse)) return null;
  const service = payload.OpenAPI_ServiceResponse;
  if (!isObject(service.cmmMsgHeader)) return null;
  const header = service.cmmMsgHeader;
  const code = String(header.returnReasonCode ?? header.resultCode ?? "").trim();
  if (!code) return null;
  const message = String(header.returnAuthMsg ?? header.errMsg ?? header.resultMsg ?? "Public API error");
  const quotaExceeded = code === "22";
  const fatal = ["10", "20", "21", "30", "31", "32"].includes(code);
  return new ApiCallError(
    `Public API error ${code}: ${message.slice(0, 300)}`,
    !fatal && !quotaExceeded,
    quotaExceeded,
    null,
    fatal,
  );
}

function sanitizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/serviceKey=[^&\s]+/gi, "serviceKey=[REDACTED]").slice(0, 2000);
}

function retryDelay(attempt: number): number {
  const exponential = Math.min(1000 * 2 ** Math.max(0, attempt - 1), MAX_RETRY_DELAY_MS);
  return exponential + Math.floor(Math.random() * 250);
}

async function throttle(apiName: ApiName): Promise<void> {
  const minimumDelay = apiName === "LIST" ? LIST_REQUEST_DELAY_MS : DETAIL_REQUEST_DELAY_MS;
  const wait = lastRequestAt[apiName] + minimumDelay - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt[apiName] = Date.now();
}

async function assertSchema(pool: sql.ConnectionPool): Promise<void> {
  const result = await pool.request().query<{ missingCount: number }>(`
    SELECT COUNT(*) AS missingCount
    FROM (VALUES
      (N'dbo.AptComplex',N'U'),(N'dbo.AptComplexDetail',N'U'),
      (N'dbo.AptApiDailyUsage',N'U'),(N'dbo.AptListMigrationState',N'U'),
      (N'dbo.AptDetailFetchState',N'U'),(N'dbo.AptDailyMigrationRun',N'U'),
      (N'dbo.UpsertAptComplexListPage',N'P'),(N'dbo.UpsertAptComplexEndpoint',N'P')
    ) expected(objectName,objectType)
    WHERE OBJECT_ID(expected.objectName,expected.objectType) IS NULL;
  `);
  if (Number(result.recordset[0]?.missingCount ?? 1) !== 0) {
    throw new Error("Apartment migration schema is missing. Run apt_collector/daily-schema.sql with a DBA account first.");
  }
}

async function acquireRunLock(lockPool: sql.ConnectionPool): Promise<boolean> {
  const result = await lockPool.request()
    .input("resource", sql.NVarChar(255), RUN_LOCK_NAME)
    .query<{ result: number }>(`
      DECLARE @result int;
      EXEC @result=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Session',@LockTimeout=0;
      SELECT @result AS result;
    `);
  return Number(result.recordset[0]?.result ?? -999) >= 0;
}

async function releaseRunLock(lockPool: sql.ConnectionPool): Promise<void> {
  await lockPool.request().input("resource", sql.NVarChar(255), RUN_LOCK_NAME).query(`
    DECLARE @result int;
    EXEC @result=sys.sp_releaseapplock @Resource=@resource,@LockOwner='Session';
  `);
}

async function reserveApiCall(
  pool: sql.ConnectionPool,
  businessDate: string,
  apiName: ApiName,
  limit: number,
): Promise<boolean> {
  const result = await pool.request()
    .input("usageDate", sql.Date, dateParameter(businessDate))
    .input("apiName", sql.VarChar(20), apiName)
    .input("limit", sql.Int, limit)
    .query<{ reserved: boolean | number }>(`
      SET NOCOUNT ON;
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      MERGE dbo.AptApiDailyUsage WITH (HOLDLOCK) AS target
      USING (SELECT @usageDate AS usageDate,@apiName AS apiName) AS source
        ON target.usageDate=source.usageDate AND target.apiName=source.apiName
      WHEN NOT MATCHED THEN INSERT(usageDate,apiName) VALUES(source.usageDate,source.apiName);

      UPDATE dbo.AptApiDailyUsage WITH (UPDLOCK,HOLDLOCK)
         SET requestCount=requestCount+1,updatedAt=SYSUTCDATETIME()
       WHERE usageDate=@usageDate AND apiName=@apiName AND requestCount<@limit;
      DECLARE @reserved bit=IIF(@@ROWCOUNT=1,1,0);
      COMMIT TRANSACTION;
      SELECT @reserved AS reserved;
    `);
  return Boolean(result.recordset[0]?.reserved);
}

async function completeApiCall(
  pool: sql.ConnectionPool,
  businessDate: string,
  apiName: ApiName,
  succeeded: boolean,
): Promise<void> {
  await pool.request()
    .input("usageDate", sql.Date, dateParameter(businessDate))
    .input("apiName", sql.VarChar(20), apiName)
    .input("succeeded", sql.Bit, succeeded)
    .query(`
      UPDATE dbo.AptApiDailyUsage
         SET successCount=successCount+IIF(@succeeded=1,1,0),
             failureCount=failureCount+IIF(@succeeded=0,1,0),
             updatedAt=SYSUTCDATETIME()
       WHERE usageDate=@usageDate AND apiName=@apiName;
    `);
}

async function remainingQuota(
  pool: sql.ConnectionPool,
  businessDate: string,
  apiName: ApiName,
  limit: number,
): Promise<number> {
  const result = await pool.request()
    .input("usageDate", sql.Date, dateParameter(businessDate))
    .input("apiName", sql.VarChar(20), apiName)
    .input("limit", sql.Int, limit)
    .query<{ remaining: number }>(`
      SELECT @limit-COALESCE((SELECT requestCount FROM dbo.AptApiDailyUsage
        WHERE usageDate=@usageDate AND apiName=@apiName),0) AS remaining;
    `);
  return Math.max(0, Number(result.recordset[0]?.remaining ?? 0));
}

async function requestJson(
  pool: sql.ConnectionPool,
  businessDate: string,
  apiName: ApiName,
  url: URL,
  metrics: RunMetrics,
): Promise<unknown> {
  const limit = apiName === "LIST" ? LIST_DAILY_LIMIT : BASIS_DAILY_LIMIT;
  let lastError: unknown = new Error("Public API request failed");

  for (let attempt = 1; attempt <= HTTP_RETRIES + 1; attempt += 1) {
    if (seoulBusinessDate() !== businessDate) throw new BusinessDateChangedError();
    if (!(await reserveApiCall(pool, businessDate, apiName, limit))) {
      throw new QuotaExhaustedError(apiName, `${apiName} daily request budget ${limit} is exhausted`);
    }
    if (apiName === "LIST") metrics.listRequests += 1;
    else metrics.detailRequests += 1;

    let completed = false;
    try {
      await throttle(apiName);
      if (seoulBusinessDate() !== businessDate) throw new BusinessDateChangedError();
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
        const temporaryRateLimit = response.status === 429 && retryAfterMs != null &&
          retryAfterMs <= MAX_RETRY_DELAY_MS;
        const quotaExceeded = response.status === 429 && !temporaryRateLimit;
        throw new ApiCallError(
          `Public API HTTP ${response.status}`,
          response.status === 408 || response.status === 425 || temporaryRateLimit || response.status >= 500,
          quotaExceeded,
          retryAfterMs,
        );
      }

      const text = await response.text();
      let payload: unknown;
      try { payload = JSON.parse(text); }
      catch {
        const portalError = portalXmlError(text);
        throw portalError ?? new ApiCallError("Public API returned a non-JSON response", true);
      }
      const portalError = portalJsonError(payload);
      if (portalError) throw portalError;
      const envelope = envelopeFrom(payload);
      const code = String(envelope.header?.resultCode ?? "").trim();
      const message = String(envelope.header?.resultMsg ?? "Unknown public API error").slice(0, 300);
      if (["00", "0", "03"].includes(code)) {
        await completeApiCall(pool, businessDate, apiName, true);
        completed = true;
        return payload;
      }

      const quotaExceeded = code === "22";
      const fatal = ["10", "20", "21", "30", "31", "32"].includes(code);
      throw new ApiCallError(
        `Public API error ${code || "UNKNOWN"}: ${message}`,
        !fatal && !quotaExceeded,
        quotaExceeded,
        null,
        fatal,
      );
    } catch (error) {
      if (!completed) {
        await completeApiCall(pool, businessDate, apiName, false);
        completed = true;
      }
      lastError = error;
      if (error instanceof BusinessDateChangedError) throw error;
      const apiError = error instanceof ApiCallError
        ? error
        : new ApiCallError("Public API network request failed", true);
      if (apiError.quotaExceeded) {
        throw new QuotaExhaustedError(apiName, `${apiName} quota was rejected by the public API`);
      }
      if (apiError.fatal || !apiError.retryable || attempt > HTTP_RETRIES) throw error;
      if (apiError.retryAfterMs != null && apiError.retryAfterMs > MAX_RETRY_DELAY_MS) throw error;
      await sleep(apiError.retryAfterMs ?? retryDelay(attempt));
    }
  }
  throw lastError;
}

async function createRun(pool: sql.ConnectionPool, businessDate: string): Promise<number> {
  const result = await pool.request().input("businessDate", sql.Date, dateParameter(businessDate)).query<{ runId: number }>(`
    INSERT dbo.AptDailyMigrationRun(businessDate,startedAt,status)
    VALUES(@businessDate,SYSUTCDATETIME(),'RUNNING');
    SELECT CONVERT(bigint,SCOPE_IDENTITY()) AS runId;
  `);
  return Number(result.recordset[0].runId);
}

async function finishRun(
  pool: sql.ConnectionPool,
  runId: number,
  metrics: RunMetrics,
  remainingEndpoints: number | null,
  status: "SUCCEEDED" | "FAILED",
  error: string | null,
): Promise<void> {
  await pool.request()
    .input("runId", sql.BigInt, runId)
    .input("listRequests", sql.Int, metrics.listRequests)
    .input("listItems", sql.Int, metrics.listItems)
    .input("listTotal", sql.Int, metrics.listTotal)
    .input("detailRequests", sql.Int, metrics.detailRequests)
    .input("detailSaved", sql.Int, metrics.detailSaved)
    .input("detailNoData", sql.Int, metrics.detailNoData)
    .input("detailFailed", sql.Int, metrics.detailFailed)
    .input("remainingEndpoints", sql.BigInt, remainingEndpoints)
    .input("status", sql.VarChar(20), status)
    .input("error", sql.NVarChar(2000), error)
    .query(`
      UPDATE dbo.AptDailyMigrationRun SET completedAt=SYSUTCDATETIME(),
        listRequests=@listRequests,listItems=@listItems,listTotal=@listTotal,
        detailRequests=@detailRequests,detailSaved=@detailSaved,detailNoData=@detailNoData,
        detailFailed=@detailFailed,remainingEndpoints=@remainingEndpoints,status=@status,error=@error
      WHERE runId=@runId;
    `);
}

async function getListState(pool: sql.ConnectionPool): Promise<ListState> {
  const result = await pool.request().query<ListState>(`
    SELECT nextPage,pageSize,totalCount,lastCompletedDate
    FROM dbo.AptListMigrationState WHERE stateId=1;
  `);
  const state = result.recordset[0];
  if (!state) throw new Error("AptListMigrationState singleton row is missing");
  return state;
}

function listItemsFrom(payload: unknown): { items: JsonObject[]; totalCount: number } {
  const envelope = envelopeFrom(payload);
  const body = envelope.body ?? {};
  let item: unknown;
  if (isObject(body.items)) item = body.items.item;
  else if (Array.isArray(body.items)) item = body.items;
  const totalCount = Number(body.totalCount ?? 0);
  if (!Number.isFinite(totalCount) || totalCount < 0) {
    throw new Error("Public list API returned an invalid totalCount");
  }
  return { items: asObjectArray(item), totalCount };
}

async function saveListPage(pool: sql.ConnectionPool, items: JsonObject[]): Promise<void> {
  const invalidItem = items.find((item) => typeof item.kaptCode !== "string" || item.kaptCode.trim() === "");
  if (invalidItem) {
    throw new Error("Public list API returned an item without kaptCode; page cursor was not advanced");
  }
  await pool.request()
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify(items))
    .execute("dbo.UpsertAptComplexListPage");
}

async function collectList(
  pool: sql.ConnectionPool,
  serviceKey: string,
  businessDate: string,
  metrics: RunMetrics,
): Promise<void> {
  const state = await getListState(pool);
  if (dateOnly(state.lastCompletedDate) === businessDate) {
    metrics.listTotal = state.totalCount;
    console.info(`list: already synchronized for ${businessDate}`);
    return;
  }

  let pageNo = Math.max(1, Number(state.nextPage));
  const pageSize = pageNo === 1 ? LIST_PAGE_SIZE : Math.max(1, Number(state.pageSize));
  if (pageNo === 1) {
    await pool.request().input("pageSize", sql.Int, pageSize).query(`
      UPDATE dbo.AptListMigrationState SET pageSize=@pageSize,totalCount=NULL,
        cycleStartedAt=SYSUTCDATETIME(),updatedAt=SYSUTCDATETIME() WHERE stateId=1;
    `);
  }

  for (;;) {
    if ((await remainingQuota(pool, businessDate, "LIST", LIST_DAILY_LIMIT)) === 0) {
      console.warn("list: daily request budget exhausted; cursor retained for the next run");
      return;
    }
    const url = new URL(LIST_API_URL);
    url.search = new URLSearchParams({
      serviceKey,
      pageNo: String(pageNo),
      numOfRows: String(pageSize),
      _type: "json",
    }).toString();

    let response: { items: JsonObject[]; totalCount: number };
    try {
      response = listItemsFrom(await requestJson(pool, businessDate, "LIST", url, metrics));
    } catch (error) {
      if (error instanceof QuotaExhaustedError) {
        console.warn(`list: ${error.message}; cursor retained for the next run`);
        return;
      }
      throw error;
    }

    await saveListPage(pool, response.items);
    metrics.listItems += response.items.length;
    metrics.listTotal = response.totalCount;
    const completed = response.items.length === 0 || pageNo * pageSize >= response.totalCount;
    await pool.request()
      .input("nextPage", sql.Int, completed ? 1 : pageNo + 1)
      .input("pageSize", sql.Int, pageSize)
      .input("totalCount", sql.Int, response.totalCount)
      .input("completed", sql.Bit, completed)
      .input("businessDate", sql.Date, dateParameter(businessDate))
      .query(`
        UPDATE dbo.AptListMigrationState SET nextPage=@nextPage,pageSize=@pageSize,totalCount=@totalCount,
          lastCompletedAt=IIF(@completed=1,SYSUTCDATETIME(),lastCompletedAt),
          lastCompletedDate=IIF(@completed=1,@businessDate,lastCompletedDate),updatedAt=SYSUTCDATETIME()
        WHERE stateId=1;
      `);
    console.info(`list: page=${pageNo} rows=${response.items.length} total=${response.totalCount}`);
    if (completed) return;
    pageNo += 1;
  }
}

async function detailCandidates(pool: sql.ConnectionPool, take: number): Promise<DetailCandidate[]> {
  if (take <= 0) return [];
  const result = await pool.request().input("take", sql.Int, take).query<DetailCandidate>(`
    SELECT TOP (@take) a.kaptCode,endpoints.endpoint,COALESCE(state.attemptCount,0) AS attemptCount
    FROM dbo.AptComplex AS a
    CROSS JOIN (VALUES('BASIC',1),('EXTENDED',2)) endpoints(endpoint,sortOrder)
    LEFT JOIN dbo.AptDetailFetchState AS state
      ON state.kaptCode=a.kaptCode AND state.endpoint=endpoints.endpoint
    WHERE state.kaptCode IS NULL OR state.nextAttemptAt IS NULL OR state.nextAttemptAt<=SYSUTCDATETIME()
    ORDER BY CASE WHEN state.kaptCode IS NULL THEN 0 ELSE 1 END,a.kaptCode,endpoints.sortOrder;
  `);
  return result.recordset;
}

function detailItemFrom(payload: unknown): JsonObject | null {
  const body = envelopeFrom(payload).body ?? {};
  const directItems = asObjectArray(body.item);
  if (directItems.length) return directItems[0];
  if (isObject(body.items)) return asObjectArray(body.items.item)[0] ?? null;
  if (Array.isArray(body.items)) return asObjectArray(body.items)[0] ?? null;
  return null;
}

async function saveDetail(
  pool: sql.ConnectionPool,
  candidate: DetailCandidate,
  item: JsonObject,
): Promise<void> {
  const returnedCode = item.kaptCode == null ? null : String(item.kaptCode).trim();
  if (returnedCode && returnedCode !== candidate.kaptCode) {
    throw new Error(`Detail API returned an unexpected apartment code for ${candidate.kaptCode}`);
  }
  await pool.request()
    .input("kaptCode", sql.NVarChar(50), candidate.kaptCode)
    .input("endpoint", sql.VarChar(20), candidate.endpoint)
    .input("payload", sql.NVarChar(sql.MAX), JSON.stringify(item))
    .execute("dbo.UpsertAptComplexEndpoint");
}

async function markDetailState(
  pool: sql.ConnectionPool,
  candidate: DetailCandidate,
  status: "SUCCEEDED" | "NO_DATA" | "FAILED",
  error: string | null,
): Promise<void> {
  const retryValue = status === "SUCCEEDED"
    ? DETAIL_REFRESH_DAYS
    : status === "NO_DATA"
      ? NO_DATA_RETRY_DAYS
      : Math.min(FAILED_RETRY_MINUTES * 2 ** Math.min(candidate.attemptCount, 6), 43_200);
  const unit = status === "FAILED" ? "minute" : "day";
  await pool.request()
    .input("kaptCode", sql.NVarChar(50), candidate.kaptCode)
    .input("endpoint", sql.VarChar(20), candidate.endpoint)
    .input("status", sql.VarChar(20), status)
    .input("retryValue", sql.Int, retryValue)
    .input("error", sql.NVarChar(2000), error)
    .query(`
      MERGE dbo.AptDetailFetchState WITH (HOLDLOCK) AS target
      USING (SELECT @kaptCode AS kaptCode,@endpoint AS endpoint) AS source
        ON target.kaptCode=source.kaptCode AND target.endpoint=source.endpoint
      WHEN MATCHED THEN UPDATE SET status=@status,attemptCount=target.attemptCount+1,
        lastAttemptAt=SYSUTCDATETIME(),
        nextAttemptAt=CASE WHEN '${unit}'='day' THEN DATEADD(day,@retryValue,SYSUTCDATETIME())
                           ELSE DATEADD(minute,@retryValue,SYSUTCDATETIME()) END,
        completedAt=IIF(@status IN('SUCCEEDED','NO_DATA'),SYSUTCDATETIME(),target.completedAt),lastError=@error
      WHEN NOT MATCHED THEN INSERT(kaptCode,endpoint,status,attemptCount,lastAttemptAt,nextAttemptAt,completedAt,lastError)
        VALUES(source.kaptCode,source.endpoint,@status,1,SYSUTCDATETIME(),
          CASE WHEN '${unit}'='day' THEN DATEADD(day,@retryValue,SYSUTCDATETIME())
               ELSE DATEADD(minute,@retryValue,SYSUTCDATETIME()) END,
          IIF(@status IN('SUCCEEDED','NO_DATA'),SYSUTCDATETIME(),NULL),@error);
    `);
}

async function collectDetails(
  pool: sql.ConnectionPool,
  serviceKey: string,
  businessDate: string,
  metrics: RunMetrics,
): Promise<void> {
  const available = await remainingQuota(pool, businessDate, "BASIS", BASIS_DAILY_LIMIT);
  if (available <= 0) {
    console.warn("detail: daily BASIS request budget already exhausted");
    return;
  }
  const candidates = await detailCandidates(pool, available);
  let consecutiveFailures = 0;

  for (const candidate of candidates) {
    if ((await remainingQuota(pool, businessDate, "BASIS", BASIS_DAILY_LIMIT)) === 0) {
      console.warn("detail: daily BASIS request budget exhausted");
      return;
    }
    const url = new URL(`${BASIS_API_ROOT}/${DETAIL_ENDPOINTS[candidate.endpoint]}`);
    url.search = new URLSearchParams({
      serviceKey,
      kaptCode: candidate.kaptCode,
      _type: "json",
    }).toString();
    try {
      const item = detailItemFrom(await requestJson(pool, businessDate, "BASIS", url, metrics));
      if (item == null) {
        await markDetailState(pool, candidate, "NO_DATA", null);
        metrics.detailNoData += 1;
      } else {
        await saveDetail(pool, candidate, item);
        await markDetailState(pool, candidate, "SUCCEEDED", null);
        metrics.detailSaved += 1;
      }
      consecutiveFailures = 0;
    } catch (error) {
      if (error instanceof BusinessDateChangedError) throw error;
      if (error instanceof QuotaExhaustedError) {
        console.warn(`detail: ${error.message}; remaining work retained for the next run`);
        return;
      }
      if (error instanceof ApiCallError && error.fatal) throw error;
      await markDetailState(pool, candidate, "FAILED", sanitizedError(error));
      metrics.detailFailed += 1;
      consecutiveFailures += 1;
      console.error(
        `detail: failed kaptCode=${candidate.kaptCode} endpoint=${candidate.endpoint}: ${sanitizedError(error)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`Stopped after ${consecutiveFailures} consecutive detail failures`);
      }
    }
  }
}

async function countRemainingInitialEndpoints(pool: sql.ConnectionPool): Promise<number> {
  const result = await pool.request().query<{ remaining: number | string }>(`
    SELECT COUNT_BIG(*) AS remaining
    FROM dbo.AptComplex AS a
    CROSS JOIN (VALUES('BASIC'),('EXTENDED')) endpoints(endpoint)
    LEFT JOIN dbo.AptDetailFetchState AS state
      ON state.kaptCode=a.kaptCode AND state.endpoint=endpoints.endpoint
    WHERE state.kaptCode IS NULL OR state.status='FAILED';
  `);
  return Number(result.recordset[0]?.remaining ?? 0);
}

async function printSummary(
  pool: sql.ConnectionPool,
  businessDate: string,
  runId: number,
  metrics: RunMetrics,
  remainingEndpoints: number,
): Promise<void> {
  const usage = await pool.request()
    .input("usageDate", sql.Date, dateParameter(businessDate))
    .query<{ apiName: ApiName; requestCount: number; successCount: number; failureCount: number }>(`
      SELECT apiName,requestCount,successCount,failureCount
      FROM dbo.AptApiDailyUsage WHERE usageDate=@usageDate ORDER BY apiName;
    `);
  console.info(JSON.stringify({
    runId,
    businessDate,
    metrics,
    remainingInitialEndpoints: remainingEndpoints,
    dailyUsage: usage.recordset,
  }));
}

async function main(): Promise<void> {
  const serviceKey = decodePortalKey(requiredEnv("DATA_GO_KR_SERVICE_KEY"));
  const businessDate = seoulBusinessDate();
  const pool = await new sql.ConnectionPool(sqlConfig()).connect();
  const lockPool = await new sql.ConnectionPool(sqlConfig(1)).connect();
  let lockAcquired = false;
  try {
    await assertSchema(pool);
    lockAcquired = await acquireRunLock(lockPool);
    if (!lockAcquired) {
      console.info("Another apartment migration run is already active; exiting without API calls");
      return;
    }

    const metrics: RunMetrics = {
      listRequests: 0,
      listItems: 0,
      listTotal: null,
      detailRequests: 0,
      detailSaved: 0,
      detailNoData: 0,
      detailFailed: 0,
    };
    const runId = await createRun(pool, businessDate);
    let remainingEndpoints: number | null = null;
    try {
      await collectList(pool, serviceKey, businessDate, metrics);
      await collectDetails(pool, serviceKey, businessDate, metrics);
      remainingEndpoints = await countRemainingInitialEndpoints(pool);
      await finishRun(pool, runId, metrics, remainingEndpoints, "SUCCEEDED", null);
      await printSummary(pool, businessDate, runId, metrics, remainingEndpoints);
    } catch (error) {
      try {
        remainingEndpoints = await countRemainingInitialEndpoints(pool);
        await finishRun(pool, runId, metrics, remainingEndpoints, "FAILED", sanitizedError(error));
      } catch (finishError) {
        console.error(`Could not finalize migration run ${runId}: ${sanitizedError(finishError)}`);
      }
      throw error;
    }
  } finally {
    if (lockAcquired) {
      try { await releaseRunLock(lockPool); }
      catch (error) { console.warn(`Could not explicitly release migration lock: ${sanitizedError(error)}`); }
    }
    await lockPool.close();
    await pool.close();
  }
}

main().catch((error: unknown) => {
  console.error(`Apartment migration failed: ${sanitizedError(error)}`);
  process.exitCode = 1;
});
