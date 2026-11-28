import 'dotenv/config';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import sql, { ConnectionPool } from 'mssql';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { committeeDocumentType } from './committee-document-type';
import { decryptInquiryImage, formatInquiry, type InquiryRow } from './committee-inquiry-files';
import { matchingOtpStep, otpSetupKey } from './supervisor-otp';

type JsonObject = Record<string, unknown>;
type BrowserSession = { ip: string; userAgent: string; expiresAt: number; reviewedDocuments: Map<number, string> };
type WindowState = { startedAt: number; count: number };
type PendingApplication = { ApplicationId: number; DocumentSha256: string };
type SupervisorAccount = { EmailHash: string; PasswordHash: string; OtpSecretCipher: Buffer | null; LastOtpStep: number | string };
type Enrollment = { account: SupervisorAccount; secret: Buffer; ip: string; userAgent: string; expiresAt: number };

const host = process.env.SUPERVISOR_HOST ?? '127.0.0.1';
const port = Number(process.env.SUPERVISOR_PORT ?? 3102);
const allowedOrigin = process.env.SUPERVISOR_ORIGIN ?? 'https://mutelab.kr';
const memberDataKey = process.env.MEMBER_DATA_KEY ?? '';
const dbUser = process.env.COMMITTEE_APPROVER_DB_USER ?? '';
const dbPassword = process.env.COMMITTEE_APPROVER_DB_PASSWORD ?? '';

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SUPERVISOR_PORT is invalid.');
if (memberDataKey.length < 32) throw new Error('MEMBER_DATA_KEY must contain at least 32 characters.');
if (!dbUser || !dbPassword) throw new Error('The dedicated committee approver database credentials are required.');
if (!/^https:\/\/[^/]+$/i.test(allowedOrigin)) throw new Error('SUPERVISOR_ORIGIN must be an HTTPS origin.');

let poolPromise: Promise<ConnectionPool> | undefined;
function getPool(): Promise<ConnectionPool> {
  if (!poolPromise) {
    const pool = new sql.ConnectionPool({
      user: dbUser,
      password: dbPassword,
      server: process.env.SQL_SERVER ?? '127.0.0.1',
      port: Number(process.env.SQL_PORT ?? 1433),
      database: process.env.SQL_DATABASE ?? 'mutelab',
      connectionTimeout: 8_000,
      requestTimeout: 30_000,
      pool: { max: 5, min: 0, idleTimeoutMillis: 30_000 },
      options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
    });
    pool.on('error', (error: Error) => console.error('supervisor SQL pool error:', error.message));
    poolPromise = pool.connect().catch((error: Error) => { poolPromise = undefined; throw error; });
  }
  return poolPromise;
}

const sessions = new Map<string, BrowserSession>();
const enrollments = new Map<string, Enrollment>();
const rateWindows = new Map<string, WindowState>();
const sessionTtlMs = 30 * 60_000;
const otpKey = crypto.createHash('sha256').update(memberDataKey).update(':supervisor-otp:v1').digest();

function encryptOtp(secret: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', otpKey, iv);
  return Buffer.concat([iv, cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
}

function decryptOtp(value: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', otpKey, value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(-16));
  return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]);
}

function cleanSessions(now = Date.now()): void {
  for (const [token, enrollment] of enrollments) if (enrollment.expiresAt <= now) enrollments.delete(token);
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  if (sessions.size > 10_000) for (const token of sessions.keys()) {
    sessions.delete(token); if (sessions.size <= 10_000) break;
  }
}

function limited(key: string, maximum: number, durationMs: number): boolean {
  const now = Date.now();
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= durationMs) {
    rateWindows.set(key, { startedAt: now, count: 1 });
    if (rateWindows.size > 20_000) {
      for (const [entry, state] of rateWindows) if (now - state.startedAt > 60 * 60_000) rateWindows.delete(entry);
    }
    return false;
  }
  current.count += 1;
  return current.count > maximum;
}

function requestIp(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 100);
}

function browserRequestAllowed(req: Request, mutation = false): boolean {
  const origin = req.get('origin');
  if (origin && origin !== allowedOrigin) return false;
  if (mutation && origin !== allowedOrigin) return false;
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return false;
  const referer = req.get('referer');
  if (referer) {
    try { if (new URL(referer).origin !== allowedOrigin) return false; }
    catch { return false; }
  }
  return true;
}

function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (limited(`read:${requestIp(req)}`, 300, 10 * 60_000)) {
    res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }); return;
  }
  const token = req.get('x-supervisor-token') ?? req.get('x-supervisor-session') ?? '';
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now() || session.ip !== requestIp(req)
      || session.userAgent !== (req.get('user-agent') ?? '')) {
    if (token) sessions.delete(token);
    res.status(401).json({ error: '관리 화면 연결이 만료되었습니다. 화면을 새로고침해 주세요.' }); return;
  }
  if (req.path !== '/notifications' || req.query.passive !== '1') {
    session.expiresAt = Date.now() + sessionTtlMs;
  }
  next();
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

function parseMember(value: unknown): JsonObject {
  let source: unknown = value;
  if (typeof value === 'string') {
    try { source = JSON.parse(value); }
    catch { return {}; }
  }
  const member = asObject(source);
  const result: JsonObject = {};
  for (const key of ['name', 'mobile', 'contact', 'address', 'baseAddress', 'addressDetail', 'docName']) {
    if (typeof member[key] === 'string') result[key] = String(member[key]).slice(0, key === 'address' ? 400 : 254);
  }
  return result;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) {
    const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function decryptDocument(envelope: Buffer): Buffer {
  if (!Buffer.isBuffer(envelope) || envelope.length <= 28) throw new Error('Invalid encrypted committee document.');
  const key = crypto.createHash('sha256').update(memberDataKey).update(':committee-document').digest();
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(envelope.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(envelope.subarray(12, envelope.length - 16)), decipher.final()]);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(helmet({ contentSecurityPolicy: false }));
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

app.get('/api/supervisor/health', async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS Ready;');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('supervisor health error:', error instanceof Error ? error.message : String(error));
    res.status(503).json({ status: 'unavailable' });
  }
});

function issueSession(req: Request, res: Response): void {
  cleanSessions();
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { ip: requestIp(req), userAgent: req.get('user-agent') ?? '', expiresAt: Date.now() + sessionTtlMs,
    reviewedDocuments: new Map<number, string>() });
  res.json({ sessionToken: token, expiresInSeconds: sessionTtlMs / 1000 });
}

const authJson = express.json({ limit: '8kb', type: 'application/json' });
function allowAuthRequest(req: Request, res: Response, rateKey: string): boolean {
  if (!browserRequestAllowed(req, true)) {
    res.status(403).json({ error: '허용되지 않은 요청입니다.' }); return false;
  }
  if (limited(`auth:${requestIp(req)}`, 35, 10 * 60_000)
    || (rateKey && limited(`auth-account:${rateKey}`, 10, 10 * 60_000))) {
    res.status(429).json({ error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' }); return false;
  }
  return true;
}

app.post('/api/supervisor/login', authJson, async (req, res) => {
  const body = asObject(req.body);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, 254) : '';
  if (!allowAuthRequest(req, res, '')) return;
  const password = typeof body.password === 'string' ? body.password : '';
  const pool = await getPool();
  const { recordset: [account] } = await pool.request().input('email', email).input('key', memberDataKey)
    .query<SupervisorAccount>(`SELECT EmailHash,PasswordHash,OtpSecretCipher,LastOtpStep FROM dbo.SupervisorAccounts
      WHERE EmailHash=dbo.MemberLookupHash(@email,@key)`);
  if (account && limited(`auth-account:${account.EmailHash}`, 10, 10 * 60_000)) {
    return res.status(429).json({ error: '인증 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
  }
  if (!account || !password || Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, account.PasswordHash)) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  if (!account.OtpSecretCipher) {
    const secret = crypto.randomBytes(20);
    const setupKey = otpSetupKey(secret);
    const issuer = 'MuteLab Supervisor';
    const parameters = new URLSearchParams({ secret: setupKey, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
    const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?${parameters}`;
    const qrCode = await QRCode.toDataURL(uri, { width: 260, margin: 4 });
    cleanSessions();
    for (const [token, enrollment] of enrollments) if (enrollment.account.EmailHash === account.EmailHash) enrollments.delete(token);
    const token = crypto.randomBytes(32).toString('base64url');
    enrollments.set(token, { account, secret, ip: requestIp(req), userAgent: req.get('user-agent') ?? '',
      expiresAt: Date.now() + 5 * 60_000 });
    return res.json({ enrollmentToken: token, setupKey, qrCode });
  }
  const step = matchingOtpStep(decryptOtp(account.OtpSecretCipher), String(body.code ?? ''), Number(account.LastOtpStep));
  if (step === null) {
    return res.status(401).json({ code: 'OTP_REQUIRED', error: 'Google OTP의 새 6자리 코드를 입력해 주세요.' });
  }
  const { recordset: [updated] } = await pool.request().input('emailHash', account.EmailHash).input('hash', account.PasswordHash)
    .input('step', step).query<{ Updated: number }>(`
      UPDATE dbo.SupervisorAccounts SET LastOtpStep=@step WHERE EmailHash=@emailHash AND PasswordHash=@hash AND LastOtpStep<@step;
      SELECT @@ROWCOUNT AS Updated;`);
  if (updated?.Updated !== 1) return res.status(401).json({ code: 'OTP_REQUIRED', error: '새 인증코드로 다시 시도해 주세요.' });
  issueSession(req, res);
});

app.post('/api/supervisor/enroll', authJson, async (req, res) => {
  const body = asObject(req.body);
  const token = typeof body.enrollmentToken === 'string' ? body.enrollmentToken : '';
  const enrollment = enrollments.get(token);
  if (!allowAuthRequest(req, res, enrollment?.account.EmailHash ?? '')) return;
  if (!enrollment || enrollment.expiresAt <= Date.now() || enrollment.ip !== requestIp(req)
      || enrollment.userAgent !== (req.get('user-agent') ?? '')) {
    return res.status(401).json({ error: '등록 시간이 만료되었습니다. 다시 로그인해 주세요.' });
  }
  const password = typeof body.newPassword === 'string' ? body.newPassword : '';
  if (password.length < 10 || Buffer.byteLength(password) > 72 || password !== body.confirmPassword) {
    return res.status(400).json({ error: '새 비밀번호를 10자 이상 입력하고 확인란과 일치시켜 주세요.' });
  }
  const step = matchingOtpStep(enrollment.secret, String(body.code ?? ''), -1);
  if (step === null) return res.status(400).json({ error: 'Google OTP의 6자리 코드를 확인해 주세요.' });
  if (await bcrypt.compare(password, enrollment.account.PasswordHash)) {
    return res.status(400).json({ error: '초기 비밀번호와 다른 비밀번호를 입력해 주세요.' });
  }
  const hash = await bcrypt.hash(password, 12);
  const pool = await getPool();
  if (enrollments.get(token) !== enrollment || enrollment.expiresAt <= Date.now()) {
    return res.status(401).json({ error: '등록 시간이 만료되었습니다. 다시 로그인해 주세요.' });
  }
  enrollments.delete(token);
  const { recordset: [updated] } = await pool.request().input('emailHash', enrollment.account.EmailHash)
    .input('oldHash', enrollment.account.PasswordHash).input('hash', hash).input('secret', encryptOtp(enrollment.secret))
    .input('step', step).query<{ Updated: number }>(`
      UPDATE dbo.SupervisorAccounts SET PasswordHash=@hash,OtpSecretCipher=@secret,LastOtpStep=@step
      WHERE EmailHash=@emailHash AND PasswordHash=@oldHash AND OtpSecretCipher IS NULL;
      SELECT @@ROWCOUNT AS Updated;`);
  if (updated?.Updated !== 1) return res.status(409).json({ error: '이미 설정된 계정입니다. 다시 로그인해 주세요.' });
  issueSession(req, res);
});

app.use('/api/supervisor', requireSession);

app.post('/api/supervisor/logout', (req, res) => {
  if (!browserRequestAllowed(req, true)) return res.sendStatus(403);
  sessions.delete(req.get('x-supervisor-token') ?? req.get('x-supervisor-session') ?? '');
  res.sendStatus(204);
});

async function readBusinessRegistrations(pool: ConnectionPool, kaptCodes: string[]) {
  if (!kaptCodes.length) return new Map<string, { businessRegistrationNumber: string; documentApplicationId: number | null }>();
  const result = await pool.request().input('KaptCodes', JSON.stringify(kaptCodes)).input('MemberDataKey', memberDataKey)
    .execute<JsonObject>('dbo.GetSupervisorComplexBusinessRegistrations');
  return new Map(result.recordset.map(row => [String(row.KaptCode), {
    businessRegistrationNumber: typeof row.BusinessRegistrationNumber === 'string' ? row.BusinessRegistrationNumber : '',
    documentApplicationId: row.DocumentApplicationId == null ? null : numberValue(row.DocumentApplicationId),
  }]));
}

app.get('/api/supervisor/notifications', async (req, res) => {
  const page = Number(req.query.page ?? 1);
  if (!Number.isInteger(page) || page < 1 || page > 2147483647) {
    res.status(400).json({ error: '알림 페이지를 확인해 주세요.' });
    return;
  }
  const pool = await getPool();
  const result = await pool.request().input('MemberDataKey', memberDataKey).input('Page', page)
    .input('CountOnly', req.query.passive === '1')
    .execute<JsonObject>('dbo.ListSupervisorNotifications');
  const rows = (result.recordsets[1] ?? []) as JsonObject[];
  res.json({
    total: numberValue(result.recordsets[0]?.[0]?.Total),
    items: rows.map(row => ({
      kind: row.Kind, id: numberValue(row.Id), kaptCode: row.KaptCode, role: row.RequestedRole,
      complexName: row.ComplexName, createdAt: iso(row.CreatedAt), title: row.InquiryTitle,
    })),
  });
});

app.get('/api/supervisor/inquiries', async (req, res) => {
  const id = req.query.id === undefined ? null : Number(req.query.id);
  if (id !== null && (!Number.isInteger(id) || id < 1 || id > 2147483647)) {
    res.status(400).json({ error: '문의 번호를 확인해 주세요.' });
    return;
  }
  const pool = await getPool();
  const { recordset } = await pool.request().input('MemberDataKey', memberDataKey)
    .input('InquiryId', id).execute<InquiryRow>('dbo.ListSupervisorInquiries');
  res.json({ inquiries: recordset.map(formatInquiry) });
});

app.get('/api/supervisor/inquiries/:id/image', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.sendStatus(404);
  const pool = await getPool();
  const { recordset: [row] } = await pool.request().input('InquiryId', id)
    .execute<{ AttachmentCipher: Buffer | null; AttachmentType: string | null }>('dbo.GetSupervisorInquiryAttachment');
  if (!row?.AttachmentCipher || !row.AttachmentType) return res.sendStatus(404);
  res.type(row.AttachmentType).send(decryptInquiryImage(row.AttachmentCipher, memberDataKey));
});

app.post('/api/supervisor/inquiries/:id/reply', authJson, async (req, res) => {
  if (!browserRequestAllowed(req, true)) return res.sendStatus(403);
  const id = Number(req.params.id), body = asObject(req.body);
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  if (!Number.isInteger(id) || id < 1 || id > 2147483647 || !reply || reply.length > 2000) {
    return res.status(400).json({ error: '답변을 2,000자 이내로 입력해 주세요.' });
  }
  const pool = await getPool();
  const { recordset: [result] } = await pool.request().input('InquiryId', id).input('Reply', reply)
    .input('MemberDataKey', memberDataKey).execute<{ Updated: number }>('dbo.ReplySupervisorInquiry');
  if (result?.Updated !== 1) return res.status(409).json({ error: '이미 답변했거나 조회할 수 없는 문의입니다.' });
  res.sendStatus(204);
});

app.get('/api/supervisor/complexes', async (req, res, next) => {
  const search = typeof req.query.query === 'string' ? req.query.query.trim().slice(0, 100) : '';
  const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'ALL';
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? req.query.size ?? 50);
  if (!['ALL', 'JOINED', 'UNREGISTERED', 'PENDING', 'APPROVED', 'REJECTED'].includes(status)
      || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    res.status(400).json({ error: '조회 조건을 확인해 주세요.' }); return;
  }
  try {
    const pool = await getPool();
    const result = await pool.request().input('Search', search).input('Status', status)
      .input('Page', page).input('PageSize', pageSize).execute<JsonObject>('dbo.ListSupervisorComplexes');
    const sets = result.recordsets ?? [];
    const summaryRow = asObject(sets[0]?.[0]);
    const rows = (sets[1] ?? []) as JsonObject[];
    const registrations = await readBusinessRegistrations(pool, rows.map(row => String(row.KaptCode ?? '')));
    const items = rows.map(row => ({
      kaptCode: String(row.KaptCode ?? ''), kaptName: String(row.KaptName ?? ''), address: String(row.Address ?? ''),
      status: String(row.CommitteeStatus ?? 'UNREGISTERED'), approvedMemberCount: numberValue(row.ApprovedMemberCount),
      pendingApplicationCount: numberValue(row.PendingApplicationCount), rejectedApplicationCount: numberValue(row.RejectedApplicationCount),
      chairCount: numberValue(row.ChairCount), firstSubmittedAt: iso(row.FirstSubmittedAt), lastReviewedAt: iso(row.LastReviewedAt),
      ...registrations.get(String(row.KaptCode)),
    }));
    res.json({
      summary: { total: numberValue(summaryRow.TotalComplexes), registered: numberValue(summaryRow.RegisteredComplexes),
        pending: numberValue(summaryRow.PendingComplexes), unregistered: numberValue(summaryRow.UnregisteredComplexes),
        approved: numberValue(summaryRow.ApprovedComplexes), rejected: numberValue(summaryRow.RejectedComplexes) },
      items, total: numberValue(rows[0]?.TotalRows), page, pageSize,
    });
  } catch (error) { next(error); }
});

app.get('/api/supervisor/complexes/:kaptCode', async (req, res, next) => {
  const kaptCode = req.params.kaptCode;
  if (!/^[A-Z0-9]{1,50}$/.test(kaptCode)) { res.status(400).json({ error: '단지 코드를 확인해 주세요.' }); return; }
  try {
    const pool = await getPool();
    const result = await pool.request().input('KaptCode', kaptCode).input('MemberDataKey', memberDataKey)
      .execute<JsonObject>('dbo.GetSupervisorComplexDetails');
    const sets = result.recordsets ?? [];
    const complexRow = asObject(sets[0]?.[0]);
    if (!complexRow.KaptCode) { res.status(404).json({ error: '단지 정보를 찾을 수 없습니다.' }); return; }
    const registration = (await readBusinessRegistrations(pool, [kaptCode])).get(kaptCode);
    const members = ((sets[1] ?? []) as JsonObject[]).map(row => ({
      memberId: numberValue(row.MemberId), seat: numberValue(row.Seat), role: String(row.Role ?? ''), email: String(row.Email ?? ''),
      ...parseMember(row.MemberJson), approvedAt: iso(row.ApprovedAt), consentedAt: iso(row.ConsentedAt),
    }));
    const applications = ((sets[2] ?? []) as JsonObject[]).map(row => ({
      applicationId: numberValue(row.ApplicationId), requestedRole: String(row.RequestedRole ?? ''), status: String(row.Status ?? ''),
      email: String(row.Email ?? ''), ...parseMember(row.MemberJson), documentSha256: String(row.DocumentSha256 ?? '').trim(),
      submittedAt: iso(row.SubmittedAt), reviewedAt: iso(row.ReviewedAt), reviewReason: row.ReviewNote ? String(row.ReviewNote) : null,
      approvedMemberId: row.ApprovedMemberId == null ? null : numberValue(row.ApprovedMemberId),
    }));
    res.json({ complex: { kaptCode: String(complexRow.KaptCode), kaptName: String(complexRow.KaptName ?? ''),
      address: String(complexRow.Address ?? ''), ...registration }, members, applications });
  } catch (error) { next(error); }
});

app.put('/api/supervisor/complexes/:kaptCode/business-registration', authJson, async (req, res) => {
  if (!browserRequestAllowed(req, true)) return res.status(403).json({ error: '허용되지 않은 요청입니다.' });
  const kaptCode = req.params.kaptCode;
  const input = asObject(req.body).businessRegistrationNumber;
  const number = typeof input === 'string' ? input.trim().replace(/[\s-]/g, '') : '';
  if (!/^[A-Z0-9]{1,50}$/.test(kaptCode) || !/^\d{10}$/.test(number)) {
    return res.status(400).json({ error: '사업자등록번호 숫자 10자리를 입력해 주세요.' });
  }
  const pool = await getPool();
  const { recordset: [result] } = await pool.request().input('KaptCode', kaptCode)
    .input('BusinessRegistrationNumber', number).input('MemberDataKey', memberDataKey)
    .execute<{ Saved: number }>('dbo.SaveSupervisorComplexBusinessRegistration');
  if (result?.Saved !== 1) return res.status(404).json({ error: '단지 정보를 찾을 수 없습니다.' });
  res.json({ businessRegistrationNumber: number });
});

app.get('/api/supervisor/applications/:applicationId/document', async (req, res, next) => {
  const applicationId = Number(req.params.applicationId);
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) { res.status(400).json({ error: '신청 번호를 확인해 주세요.' }); return; }
  try {
    const pool = await getPool();
    const result = await pool.request().input('ApplicationId', applicationId).input('MemberDataKey', memberDataKey)
      .input('IncludeReviewed', 1)
      .execute<JsonObject>('dbo.GetCommitteeApplicationForReview');
    const row = asObject(result.recordset[0]);
    if (!row.ApplicationId || !Buffer.isBuffer(row.DocumentCipher)) { res.status(404).json({ error: '첨부된 사업자등록증을 찾을 수 없습니다.' }); return; }
    const document = decryptDocument(row.DocumentCipher);
    const sha256 = crypto.createHash('sha256').update(document).digest('hex').toUpperCase();
    if (sha256 !== String(row.DocumentSha256 ?? '').trim().toUpperCase()) throw new Error('Committee document hash mismatch.');
    const sessionToken = req.get('x-supervisor-token') ?? req.get('x-supervisor-session') ?? '';
    const type = committeeDocumentType(document);
    if (!type) { res.status(415).json({ error: '지원하지 않는 사업자등록증 파일 형식입니다.' }); return; }
    if (row.Status === 'PENDING') sessions.get(sessionToken)?.reviewedDocuments.set(applicationId, sha256);
    const member = parseMember(row.MemberJson);
    const rawName = typeof member.docName === 'string' ? member.docName : `committee-application-${applicationId}.${type.extension}`;
    const safeName = rawName.replace(/[\r\n"\\/]/g, '_').slice(0, 120) || `committee-application-${applicationId}.${type.extension}`;
    res.set('Content-Type', type.mime);
    res.set('Content-Length', String(document.length));
    res.set('X-Document-Sha256', sha256);
    res.set('Content-Disposition', `inline; filename="committee-document-${applicationId}.${type.extension}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.send(document);
  } catch (error) { next(error); }
});

app.post('/api/supervisor/complexes/:kaptCode/decision', express.json({ limit: '100kb', type: 'application/json' }), async (req, res, next) => {
  if (!browserRequestAllowed(req, true)) { res.status(403).json({ error: '허용되지 않은 요청입니다.' }); return; }
  const ip = requestIp(req);
  if (limited(`decision:${ip}`, 10, 10 * 60_000)) { res.status(429).json({ error: '결정 요청이 너무 많습니다.' }); return; }
  const kaptCode = req.params.kaptCode;
  const body = asObject(req.body);
  const decision = String(body.decision ?? '').toUpperCase();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const suppliedSource = Array.isArray(body.reviewedDocuments) ? body.reviewedDocuments : body.applications;
  const supplied = Array.isArray(suppliedSource) ? suppliedSource.map(asObject) : [];
  if (!/^[A-Z0-9]{1,50}$/.test(kaptCode) || !['APPROVE', 'REJECT'].includes(decision)
      || reason.length > 1000 || (decision === 'REJECT' && !reason) || supplied.length < 1 || supplied.length > 50
      || (decision === 'APPROVE' && supplied.length > 3)) {
    res.status(400).json({ error: decision === 'REJECT' && !reason ? '반려 사유를 입력해 주세요.' : '결정 내용을 확인해 주세요.' }); return;
  }
  const reviewed = supplied.map(item => ({ applicationId: Number(item.applicationId),
    documentSha256: String(item.documentSha256 ?? '').trim().toUpperCase() }));
  if (reviewed.some(item => !Number.isSafeInteger(item.applicationId) || item.applicationId < 1
      || (decision === 'APPROVE' && !/^[A-F0-9]{64}$/.test(item.documentSha256)))
      || new Set(reviewed.map(item => item.applicationId)).size !== reviewed.length) {
    res.status(400).json({ error: '검토한 신청 및 문서 정보를 확인해 주세요.' }); return;
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    const pendingResult = await new sql.Request(transaction).input('KaptCode', kaptCode)
      .execute<PendingApplication>('dbo.GetSupervisorPendingApplications');
    const pending = pendingResult.recordset;
    const suppliedById = new Map(reviewed.map(item => [item.applicationId, item.documentSha256]));
    if (!pending.length || pending.length !== reviewed.length
        || pending.some(item => !suppliedById.has(numberValue(item.ApplicationId)))
        || (decision === 'APPROVE' && pending.some(item => suppliedById.get(numberValue(item.ApplicationId))
          !== String(item.DocumentSha256).trim().toUpperCase()))) {
      const conflict = new Error('PENDING_SET_CHANGED'); conflict.name = 'ConflictError'; throw conflict;
    }
    const sessionToken = req.get('x-supervisor-token') ?? req.get('x-supervisor-session') ?? '';
    const browserSession = sessions.get(sessionToken);
    if (decision === 'APPROVE' && pending.some(item => browserSession?.reviewedDocuments.get(numberValue(item.ApplicationId))
        !== String(item.DocumentSha256).trim().toUpperCase())) {
      const reviewError = new Error('DOCUMENT_REVIEW_REQUIRED'); reviewError.name = 'DocumentReviewError'; throw reviewError;
    }
    let notificationCount = 0;
    for (let applicationIndex = 0; applicationIndex < pending.length; applicationIndex += 1) {
      const application = pending[applicationIndex];
      const applicationId = numberValue(application.ApplicationId);
      if (decision === 'APPROVE') {
        await new sql.Request(transaction).input('ApplicationId', applicationId)
          .input('ReviewedDocumentSha256', suppliedById.get(applicationId) ?? '')
          .input('ReviewNote', reason || '위원회 가입 신청 승인')
          .input('MemberDataKey', memberDataKey)
          .execute('dbo.ApproveCommitteeApplication');
      } else {
        await new sql.Request(transaction).input('ApplicationId', applicationId).input('ReviewNote', reason)
          .input('MemberDataKey', memberDataKey)
          .execute('dbo.RejectCommitteeApplication');
      }
      const queued = await new sql.Request(transaction).input('ApplicationId', applicationId)
        .input('MemberDataKey', memberDataKey).input('NotifyExistingMembers', applicationIndex === 0 ? 1 : 0)
        .input('ApplicationCount', pending.length).execute<JsonObject>('dbo.EnqueueCommitteeDecisionNotification');
      notificationCount += numberValue(queued.recordset[0]?.CreatedCount);
    }
    await new sql.Request(transaction).input('KaptCode', kaptCode)
      .input('Decision', decision === 'APPROVE' ? 'APPROVED' : 'REJECTED')
      .input('ApplicationCount', pending.length).input('RemoteAddress', ip)
      .input('UserAgent', (req.get('user-agent') ?? '').slice(0, 500)).input('Reason', reason || null)
      .input('MemberDataKey', memberDataKey).execute('dbo.RecordSupervisorDecisionAudit');
    await transaction.commit();
    for (const application of pending) browserSession?.reviewedDocuments.delete(numberValue(application.ApplicationId));
    res.json({ message: decision === 'APPROVE' ? `${pending.length}명의 위원회 가입을 승인했습니다.`
      : `${pending.length}명의 위원회 가입을 반려했습니다.`, reviewedCount: pending.length, notificationCount });
  } catch (error) {
    try { await transaction.rollback(); } catch { /* transaction may already be rolled back by XACT_ABORT */ }
    const message = String(error);
    if (error instanceof Error && error.name === 'ConflictError') {
      res.status(409).json({ error: '승인 대기 신청이 변경되었습니다. 상세 정보를 다시 불러와 주세요.' }); return;
    }
    if (error instanceof Error && error.name === 'DocumentReviewError') {
      res.status(400).json({ error: '승인 전에 모든 사업자등록증을 열어 원본과 해시를 확인해 주세요.' }); return;
    }
    if ((error as { number?: number }).number === 51114) {
      res.status(409).json({ error: '이미 등록했거나 승인 대기 중인 이메일과 중복되어 승인할 수 없습니다.' }); return;
    }
    if (/already reviewed|Pending committee application not found|Committee is full|chair already exists|identity already registered/i.test(message)) {
      res.status(409).json({ error: '위원회 구성 또는 신청 상태가 변경되었습니다. 상세 정보를 다시 확인해 주세요.' }); return;
    }
    next(error);
  }
});

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const httpError = error as { status?: number; type?: string };
  if (httpError.status === 400 && httpError.type === 'entity.parse.failed') {
    res.status(400).json({ error: '요청 형식을 확인해 주세요.' }); return;
  }
  const requestId = crypto.randomBytes(8).toString('hex');
  console.error(`supervisor error ${requestId} ${req.method} ${req.path}:`, error instanceof Error ? error.message : String(error));
  res.status(500).json({ error: '관리 요청을 처리하지 못했습니다.', requestId });
});

let server: ReturnType<typeof app.listen> | undefined;
async function start(): Promise<void> {
  const pool = await getPool();
  await pool.request().input('Search', '').input('Status', 'ALL').input('Page', 1).input('PageSize', 1)
    .execute('dbo.ListSupervisorComplexes');
  server = app.listen(port, host, () => console.log(`MuteLab supervisor listening on http://${host}:${port}`));
}

async function shutdown(): Promise<void> {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  if (poolPromise) await (await poolPromise).close();
}

process.on('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
async function seedAccounts(): Promise<void> {
  const password = process.env.SUPERVISOR_INITIAL_PASSWORD ?? '';
  const supervisorEmails = [...new Set((process.env.SUPERVISOR_ACCOUNT_EMAILS ?? '').split(',')
    .map(email => email.trim().toLowerCase()).filter(Boolean))];
  if (password.length < 8 || Buffer.byteLength(password) > 72) throw new Error('SUPERVISOR_INITIAL_PASSWORD is invalid.');
  if (!supervisorEmails.length || supervisorEmails.some(email => email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new Error('SUPERVISOR_ACCOUNT_EMAILS is invalid.');
  }
  const pool = await getPool();
  try {
    for (const email of supervisorEmails) {
      await pool.request().input('email', email).input('hash', await bcrypt.hash(password, 12)).input('key', memberDataKey).query(`
        DECLARE @emailHash char(64)=dbo.MemberLookupHash(@email,@key);
        INSERT dbo.SupervisorAccounts(EmailHash,EmailCipher,PasswordHash)
        SELECT @emailHash,dbo.EncryptMemberData(@email,@key),@hash WHERE NOT EXISTS (
          SELECT 1 FROM dbo.SupervisorAccounts WITH (UPDLOCK,HOLDLOCK) WHERE EmailHash=@emailHash
        );`);
    }
    console.log('Supervisor accounts initialized.');
  } finally {
    await pool.close();
  }
}

void (process.argv.includes('--seed-accounts') ? seedAccounts() : start())
  .catch(error => { console.error('supervisor startup failed:', error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
