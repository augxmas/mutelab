import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { executeSql, initializeDatabase, querySql, sqlString, memberDataKey } from './db';
import { sendVerificationEmail, type EmailPurpose } from './verification-email';
import { committeeAuth, initializeCommittee } from './committee-auth';
import { cleanupCommitteeSubmissionArtifacts, committeeDataRouter, notifyRecordingIntegrityMismatch, readResidentNotification,
  residentCommitteeContacts, residentNotifications, retryPendingNotificationEmail, submitCommitteeIncident,
  uploadCommitteeSubmissionAudio, withdrawCommitteeIncident } from './committee-data';
import { initializeCommitteeDecisionNotifications, retryPendingCommitteeDecisionEmail } from './committee-decision-notifications';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3100);
const jwtSecret = process.env.JWT_SECRET ?? '';
const emailSecret = process.env.EMAIL_CODE_SECRET ?? '';
const emailFrom = process.env.EMAIL_FROM ?? 'no-reply@mutelab.kr';
const demoLoginEnabled = (process.env.DEMO_LOGIN ?? (process.env.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
const codeTtlMinutes = Number(process.env.EMAIL_CODE_TTL_MINUTES ?? 10);
const app = express();

if (jwtSecret.length < 32 || emailSecret.length < 32) {
  throw new Error('JWT_SECRET and EMAIL_CODE_SECRET must each contain at least 32 characters.');
}
if (!validEmail(emailFrom) || !Number.isInteger(codeTtlMinutes) || codeTtlMinutes < 3 || codeTtlMinutes > 30) {
  throw new Error('Check EMAIL_FROM and EMAIL_CODE_TTL_MINUTES (3–30).');
}

app.disable('x-powered-by');
if (process.env.TRUST_LOOPBACK_PROXY === 'true') app.set('trust proxy', 'loopback');
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: { directives: { mediaSrc: ["'self'", 'blob:'], frameSrc: ["'self'", 'blob:'] } },
}));
app.use(express.json({ limit: '32kb' }));

type UserClaims = { sub: string; loginId: string; email: string };
type RequestWithUser = Request & { user?: UserClaims };
type SqlUser = { UserId: number; LoginId: string; Email: string; PasswordHash: string; ProfileJson: string | null };

const requestWindows = new Map<string, { start: number; count: number }>();
function sqlLiteral(value: string): string { return sqlString(value); }
function digest(value: string, secret = emailSecret): string { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function tokenDigest(value: string): string { return crypto.createHash('sha256').update(value).digest('hex'); }
function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9_+%=-]+(?:\.[A-Za-z0-9_+%=-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
}
function validLoginId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,40}$/.test(value);
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 72;
}
function fail(res: Response, status: number, message: string): void { res.status(status).json({ error: message }); }
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const current = requestWindows.get(key);
  if (!current || now - current.start >= windowMs) { requestWindows.set(key, { start: now, count: 1 }); return false; }
  current.count += 1;
  return current.count > max;
}
function auth(req: RequestWithUser, res: Response, next: NextFunction): void {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  if (!match) { fail(res, 401, '로그인이 필요합니다.'); return; }
  try {
    req.user = jwt.verify(match[1], jwtSecret) as UserClaims;
    next();
  } catch { fail(res, 401, '로그인 정보가 만료되었습니다. 다시 로그인해 주세요.'); }
}
async function scalarJson<T>(query: string): Promise<T | null> {
  const rows = await querySql<Record<string, unknown>>(query);
  if (!rows.length) return null;
  const row = rows[0];
  const json = row.JsonResult;
  return typeof json === 'string' ? JSON.parse(json) as T : row as T;
}
async function lookupUserByEmail(email: string): Promise<SqlUser | null> {
  const row = await scalarJson<SqlUser>(`SELECT COALESCE((SELECT UserId, dbo.DecryptMemberData(LoginIdCipher,${sqlLiteral(memberDataKey)}) AS LoginId, dbo.DecryptMemberData(EmailCipher,${sqlLiteral(memberDataKey)}) AS Email, PasswordHash FROM dbo.AppUsers WHERE EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), N'{}') AS JsonResult`);
  return row?.UserId ? row : null;
}
async function committeeEmailExists(email: string): Promise<boolean> {
  const rows = await querySql<{ Id: number }>(
    `SELECT TOP (1) Id FROM (
      SELECT CONVERT(bigint,MemberId) AS Id FROM dbo.CommitteeMembers
        WHERE EmailHash=dbo.MemberLookupHash(@email,@key)
      UNION ALL
      SELECT ApplicationId AS Id FROM dbo.CommitteeApplications
        WHERE Status='PENDING' AND EmailHash=dbo.MemberLookupHash(@email,@key)
    ) registered`,
    { email, key: memberDataKey },
  );
  return rows.length > 0;
}
async function consumeEmailToken(token: string, purpose: EmailPurpose): Promise<string | null> {
  const hashed = tokenDigest(token);
  const result = await scalarJson<{ EmailHash: string | null }>(`
    DECLARE @taken TABLE(EmailHash char(64));
    DELETE FROM dbo.VerifiedEmailTokens
      OUTPUT deleted.EmailHash INTO @taken(EmailHash)
      WHERE TokenHash=${sqlLiteral(hashed)} AND Purpose=${sqlLiteral(purpose)} AND ExpiresAt>SYSUTCDATETIME();
    SELECT COALESCE((SELECT TOP(1) EmailHash FROM @taken FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), N'{"EmailHash":null}') AS JsonResult;
  `);
  return result?.EmailHash ?? null;
}

app.get('/api/health', async (_req, res) => {
  try {
    await querySql('SELECT 1 AS ok');
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('health database error:', error instanceof Error ? error.message : error);
    fail(res, 503, '로컬 데이터베이스에 연결할 수 없습니다. SQL Server 서비스 설정과 server/.env를 확인해 주세요.');
  }
});

app.post('/api/auth/email/start', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const purpose = req.body?.purpose as EmailPurpose;
  const ip = req.ip ?? 'unknown';
  if (!validEmail(email) || !['signup', 'find-id', 'reset-password', 'committee-signup'].includes(purpose)) { fail(res, 400, '이메일 주소와 인증 목적을 확인해 주세요.'); return; }
  if (rateLimit(`email-ip:${ip}`, 12, 10 * 60_000) || rateLimit(`email:${email}`, 1, 45_000)) { fail(res, 429, '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.'); return; }
  try {
    const existing = await lookupUserByEmail(email);
    if (purpose === 'signup' && existing) { fail(res, 409, '이미 가입된 이메일입니다. 로그인하거나 비밀번호를 재설정해 주세요.'); return; }
    if (purpose === 'committee-signup' && await committeeEmailExists(email)) { fail(res, 409, '이미 위원회에 등록된 이메일입니다.'); return; }
    const message = `이메일 인증코드를 요청했습니다. ${codeTtlMinutes}분 안에 받은 코드를 입력해 주세요.`;
    if (['find-id', 'reset-password'].includes(purpose) && !existing) { res.json({ message }); return; }
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const expires = new Date(Date.now() + codeTtlMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    const codeHash = digest(`${email}:${purpose}:${code}`);
    await executeSql(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DELETE FROM dbo.EmailChallenges WITH (HOLDLOCK) WHERE EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) AND Purpose=${sqlLiteral(purpose)};
      INSERT INTO dbo.EmailChallenges(EmailHash,Purpose,CodeHash,ExpiresAt,Attempts)
      VALUES(dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}),${sqlLiteral(purpose)},${sqlLiteral(codeHash)},CONVERT(datetime2,${sqlLiteral(expires)},120),0);
      COMMIT TRANSACTION;
    `);
    try {
      await sendVerificationEmail({ from: emailFrom, to: email, code, ttlMinutes: codeTtlMinutes, purpose });
    } catch (error) {
      await executeSql(`DELETE FROM dbo.EmailChallenges WHERE EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) AND Purpose=${sqlLiteral(purpose)} AND CodeHash=${sqlLiteral(codeHash)};`);
      throw error;
    }
    res.json({ message });
  } catch (error) {
    console.error('email start error:', error instanceof Error ? error.message : error);
    fail(res, 500, '인증코드를 발급하지 못했습니다.');
  }
});

app.post('/api/auth/email/verify', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const purpose = req.body?.purpose as EmailPurpose;
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!validEmail(email) || !['signup', 'find-id', 'reset-password', 'committee-signup'].includes(purpose) || !/^\d{6}$/.test(code)) { fail(res, 400, '이메일 주소와 6자리 인증코드를 확인해 주세요.'); return; }
  try {
    const codeHash = digest(`${email}:${purpose}:${code}`);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const changed = await scalarJson<{ Verified: boolean }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @verified bit=0;
      DELETE FROM dbo.EmailChallenges
        WHERE EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) AND Purpose=${sqlLiteral(purpose)} AND CodeHash=${sqlLiteral(codeHash)} AND Attempts<5 AND ExpiresAt>SYSUTCDATETIME();
      IF @@ROWCOUNT=1
      BEGIN
        INSERT INTO dbo.VerifiedEmailTokens(TokenHash,EmailHash,Purpose,ExpiresAt)
        VALUES(${sqlLiteral(tokenDigest(verificationToken))},dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}),${sqlLiteral(purpose)},DATEADD(minute,5,SYSUTCDATETIME()));
        SET @verified=1;
      END
      ELSE UPDATE dbo.EmailChallenges SET Attempts=Attempts+1 WHERE EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) AND Purpose=${sqlLiteral(purpose)} AND Attempts<5;
      COMMIT TRANSACTION;
      SELECT (SELECT @verified AS Verified FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
    `);
    const verified = changed?.Verified === true;
    if (!verified) { fail(res, 400, '인증코드가 틀렸거나 만료되었습니다.'); return; }
    res.json({ message: '이메일 인증이 완료되었습니다.', verificationToken });
  } catch (error) {
    console.error('email verify error:', error instanceof Error ? error.message : error);
    fail(res, 500, '인증을 완료하지 못했습니다.');
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId.trim() : '';
  const password = req.body?.password;
  const passwordConfirm = req.body?.passwordConfirm;
  const verificationToken = typeof req.body?.verificationToken === 'string' ? req.body.verificationToken : '';
  if (!validEmail(email) || !validLoginId(loginId) || !validPassword(password) || password !== passwordConfirm || verificationToken.length < 32) { fail(res, 400, '아이디, 비밀번호, 비밀번호 확인을 다시 확인해 주세요.'); return; }
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const tokenHash = tokenDigest(verificationToken);
    const user = await scalarJson<{ UserId: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @userId int;
      DELETE FROM dbo.VerifiedEmailTokens
        WHERE TokenHash=${sqlLiteral(tokenHash)} AND EmailHash=dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}) AND Purpose=N'signup' AND ExpiresAt>SYSUTCDATETIME();
      IF @@ROWCOUNT<>1 THROW 51001, 'Email verification is required.', 1;
      INSERT INTO dbo.AppUsers(LoginIdCipher,LoginIdHash,EmailCipher,EmailHash,PasswordHash) VALUES(dbo.EncryptMemberData(${sqlLiteral(loginId)},${sqlLiteral(memberDataKey)}),dbo.MemberLookupHash(${sqlLiteral(loginId)},${sqlLiteral(memberDataKey)}),dbo.EncryptMemberData(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}),dbo.MemberLookupHash(${sqlLiteral(email)},${sqlLiteral(memberDataKey)}),${sqlLiteral(passwordHash)});
      SET @userId=CONVERT(int,SCOPE_IDENTITY());
      COMMIT TRANSACTION;
      SELECT (SELECT @userId AS UserId FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
    `);
    if (!user?.UserId) throw new Error('Signup did not return a user ID');
    const token = jwt.sign({ sub: String(user.UserId), loginId, email }, jwtSecret, { expiresIn: '12h' });
    res.status(201).json({ message: '회원가입이 완료되었습니다.', token, loginId, email, profile: null });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (/duplicate|unique|2627|2601/i.test(detail)) { fail(res, 409, '이미 사용 중인 아이디 또는 이메일입니다.'); return; }
    console.error('signup error:', detail);
    fail(res, 400, '인증을 다시 진행한 뒤 회원가입을 시도해 주세요.');
  }
});

app.post('/api/auth/login', async (req, res) => {
  const loginId = typeof req.body?.loginId === 'string' ? req.body.loginId.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!validLoginId(loginId) || password.length > 72) { fail(res, 400, '아이디 또는 비밀번호를 확인해 주세요.'); return; }
  if (rateLimit(`login:${req.ip ?? 'unknown'}`, 20, 10 * 60_000)) { fail(res, 429, '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.'); return; }
  try {
    const user = await scalarJson<SqlUser>(`SELECT COALESCE((SELECT UserId, dbo.DecryptMemberData(LoginIdCipher,${sqlLiteral(memberDataKey)}) AS LoginId, dbo.DecryptMemberData(EmailCipher,${sqlLiteral(memberDataKey)}) AS Email, PasswordHash, dbo.DecryptMemberData(ProfileCipher,${sqlLiteral(memberDataKey)}) AS ProfileJson FROM dbo.AppUsers WHERE LoginIdHash=dbo.MemberLookupHash(${sqlLiteral(loginId)},${sqlLiteral(memberDataKey)}) FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), N'{}') AS JsonResult`);
    if (!user || !(await bcrypt.compare(password, user.PasswordHash))) { fail(res, 401, '아이디 또는 비밀번호가 올바르지 않습니다.'); return; }
    const token = jwt.sign({ sub: String(user.UserId), loginId: user.LoginId, email: user.Email }, jwtSecret, { expiresIn: '12h' });
    res.json({ token, loginId: user.LoginId, email: user.Email, profile: user.ProfileJson ? JSON.parse(user.ProfileJson) : null });
  } catch (error) {
    console.error('login error:', error instanceof Error ? error.message : error);
    fail(res, 500, '로그인할 수 없습니다.');
  }
});

app.post('/api/auth/demo-login', async (_req, res) => {
  if (!demoLoginEnabled || process.env.NODE_ENV === 'production') { fail(res, 404, '개발용 자동 로그인을 사용할 수 없습니다.'); return; }
  try {
    const user = await scalarJson<SqlUser>(`SELECT COALESCE((SELECT UserId,dbo.DecryptMemberData(LoginIdCipher,${sqlLiteral(memberDataKey)}) AS LoginId,dbo.DecryptMemberData(EmailCipher,${sqlLiteral(memberDataKey)}) AS Email,PasswordHash,dbo.DecryptMemberData(ProfileCipher,${sqlLiteral(memberDataKey)}) AS ProfileJson FROM dbo.AppUsers WHERE LoginIdHash=dbo.MemberLookupHash(N'mutelab-demo',${sqlLiteral(memberDataKey)}) FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),N'{}') AS JsonResult`);
    if (!user?.UserId) { fail(res, 503, '개발용 계정이 아직 준비되지 않았습니다. 서버를 다시 시작해 주세요.'); return; }
    const token = jwt.sign({ sub: String(user.UserId), loginId: user.LoginId, email: user.Email }, jwtSecret, { expiresIn: '30d' });
    res.json({ token, loginId: user.LoginId, email: user.Email, profile: user.ProfileJson ? JSON.parse(user.ProfileJson) : null });
  } catch (error) { console.error('demo login error:', error instanceof Error ? error.message : error); fail(res, 500, '개발용 자동 로그인을 처리하지 못했습니다.'); }
});

app.post('/api/auth/find-id', async (req, res) => {
  const verificationToken = typeof req.body?.verificationToken === 'string' ? req.body.verificationToken : '';
  if (verificationToken.length < 32) { fail(res, 400, '이메일 인증을 먼저 완료해 주세요.'); return; }
  try {
    const email = await consumeEmailToken(verificationToken, 'find-id');
    if (!email) { fail(res, 400, '인증이 만료되었습니다. 이메일 인증을 다시 진행해 주세요.'); return; }
    const row = await scalarJson<{ LoginId: string | null }>(`SELECT COALESCE((SELECT dbo.DecryptMemberData(LoginIdCipher,${sqlLiteral(memberDataKey)}) AS LoginId FROM dbo.AppUsers WHERE EmailHash=${sqlLiteral(email)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), N'{"LoginId":null}') AS JsonResult`);
    const id = row?.LoginId ?? null;
    if (!id) { fail(res, 404, '해당 이메일로 가입한 아이디가 없습니다.'); return; }
    res.json({ loginId: id });
  } catch (error) {
    console.error('find id error:', error instanceof Error ? error.message : error);
    fail(res, 500, '아이디를 조회하지 못했습니다.');
  }
});

app.post('/api/auth/password/reset', async (req, res) => {
  const verificationToken = typeof req.body?.verificationToken === 'string' ? req.body.verificationToken : '';
  const password = req.body?.password;
  if (verificationToken.length < 32 || !validPassword(password) || password !== req.body?.passwordConfirm) { fail(res, 400, '인증과 새 비밀번호를 확인해 주세요.'); return; }
  try {
    const email = await consumeEmailToken(verificationToken, 'reset-password');
    if (!email) { fail(res, 400, '인증이 만료되었습니다. 이메일 인증을 다시 진행해 주세요.'); return; }
    const passwordHash = await bcrypt.hash(password, 12);
    await executeSql(`UPDATE dbo.AppUsers SET PasswordHash=${sqlLiteral(passwordHash)} WHERE EmailHash=${sqlLiteral(email)};`);
    res.json({ message: '비밀번호를 변경했습니다. 새 비밀번호로 로그인해 주세요.' });
  } catch (error) {
    console.error('password reset error:', error instanceof Error ? error.message : error);
    fail(res, 500, '비밀번호를 변경하지 못했습니다.');
  }
});

app.get('/api/apartments', auth, async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (name.length < 2 || name.length > 100) {
    fail(res, 400, '단지명을 두 글자 이상 입력해 주세요.');
    return;
  }
  const escaped = name.replace(/[~%_\[]/g, value => `~${value}`);
  try {
    const apartments = await querySql(`
      SELECT TOP (30) kaptCode, kaptName,
             COALESCE(NULLIF(roadAddress,N''), NULLIF(address,N''), NULLIF(legalAddress,N''), CONCAT_WS(N' ',sido,sigungu)) AS address
      FROM dbo.AptComplexWithDetail
      WHERE kaptName LIKE @contains ESCAPE N'~'
      ORDER BY CASE WHEN kaptName=@name THEN 0 WHEN kaptName LIKE @prefix ESCAPE N'~' THEN 1 ELSE 2 END,
               kaptName, kaptCode;
    `, { name, contains: `%${escaped}%`, prefix: `${escaped}%` });
    res.json({ apartments });
  } catch (error) {
    console.error('apartment search error:', error instanceof Error ? error.message : error);
    fail(res, 500, '공동주택을 검색하지 못했습니다.');
  }
});

app.get('/api/profile', auth, async (req: RequestWithUser, res) => {
  try {
    const row = await scalarJson<{ ProfileJson: string | null }>(`SELECT COALESCE((SELECT dbo.DecryptMemberData(ProfileCipher,${sqlLiteral(memberDataKey)}) AS ProfileJson FROM dbo.AppUsers WHERE UserId=${sqlLiteral(req.user!.sub)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER), N'{"ProfileJson":null}') AS JsonResult`);
    const profileJson = row?.ProfileJson ?? null;
    res.json({ profile: profileJson ? JSON.parse(profileJson) : null });
  } catch (error) {
    console.error('get profile error:', error instanceof Error ? error.message : error);
    fail(res, 500, '내 정보를 불러오지 못했습니다.');
  }
});

app.put('/api/profile', auth, async (req: RequestWithUser, res) => {
  const profile = req.body?.profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || JSON.stringify(profile).length > 3_500) { fail(res, 400, '내 정보 내용을 확인해 주세요.'); return; }
  try {
    if (profile.profile_manager === false) {
      profile.profile_kapt_code = '';
    } else if (profile.profile_kapt_code !== undefined && profile.profile_kapt_code !== '') {
      const code = profile.profile_kapt_code;
      if (typeof code !== 'string' || !/^[A-Z0-9]{1,50}$/.test(code)) { fail(res, 400, '공동주택을 다시 선택해 주세요.'); return; }
      const [apartment] = await querySql<{ kaptName: string }>(
        'SELECT kaptName FROM dbo.AptComplexWithDetail WHERE kaptCode=@code AND kaptName IS NOT NULL',
        { code },
      );
      if (!apartment) { fail(res, 400, '공동주택을 다시 선택해 주세요.'); return; }
      profile.profile_house = apartment.kaptName;
    }
    if (JSON.stringify(profile).length > 3_500) { fail(res, 400, '내 정보 내용을 확인해 주세요.'); return; }
    await executeSql(`UPDATE dbo.AppUsers SET ProfileCipher=dbo.EncryptMemberData(${sqlLiteral(JSON.stringify(profile))},${sqlLiteral(memberDataKey)}) WHERE UserId=${sqlLiteral(req.user!.sub)};`);
    res.json({ message: '내 정보를 저장했습니다.' });
  } catch (error) {
    console.error('save profile error:', error instanceof Error ? error.message : error);
    fail(res, 500, '내 정보를 저장하지 못했습니다.');
  }
});

app.post('/api/recordings/audio', auth, express.raw({ type: 'audio/mp4', limit: '100mb' }), async (req: RequestWithUser, res) => {
  const clientRecordId = typeof req.header('x-client-record-id') === 'string' ? req.header('x-client-record-id')!.slice(0, 40) : '';
  const startedAt = Number(req.header('x-recording-started-at'));
  const endedAt = Number(req.header('x-recording-ended-at'));
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!/^[a-f0-9-]{36}$/i.test(clientRecordId) || !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(endedAt) || endedAt < startedAt || audio.length < 1) { fail(res, 400, '녹음 파일과 녹음 정보를 확인해 주세요.'); return; }
  if (startedAt > Date.now() + 5 * 60_000 || endedAt > Date.now() + 5 * 60_000) { fail(res, 400, '녹음 시간이 올바르지 않습니다.'); return; }
  const userId = Number(req.user!.sub);
  const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex').toUpperCase();
  const startedSql = new Date(startedAt).toISOString().slice(0, 19).replace('T', ' ');
  const endedSql = new Date(endedAt).toISOString().slice(0, 19).replace('T', ' ');
  const recordDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startedAt)).replaceAll('-', '');
  try {
    const existing = await querySql<{ RecordNo: string; AudioSha256: string }>(`SELECT RecordNo,AudioSha256 FROM dbo.NoiseRecordings WHERE UserId=${userId} AND ClientRecordId=${sqlLiteral(clientRecordId)}`);
    if (existing.length) {
      if (existing[0].AudioSha256.trim().toUpperCase() !== audioSha256) { fail(res, 409, '이미 등록한 음원과 내용이 다릅니다. 원본 파일이 변경되었을 수 있습니다.'); return; }
      res.json({ recordNo: existing[0].RecordNo, sha256: audioSha256, verified: true, duplicate: true }); return;
    }
    const saved = await querySql<{ JsonResult: string }>(`
      DECLARE @date char(8)=${sqlLiteral(recordDate)}, @number int, @recordNo varchar(13);
      BEGIN TRANSACTION;
      UPDATE dbo.NoiseRecordingCounters WITH(UPDLOCK,HOLDLOCK) SET LastNumber=LastNumber+1, @number=LastNumber+1 WHERE RecordDate=@date;
      IF @@ROWCOUNT=0 BEGIN SET @number=1; INSERT INTO dbo.NoiseRecordingCounters(RecordDate,LastNumber) VALUES(@date,@number); END;
      IF @number>9999 THROW 51011, 'Daily recording number limit reached.', 1;
      SET @recordNo=@date+'_'+RIGHT('0000'+CONVERT(varchar(4),@number),4);
      INSERT INTO dbo.NoiseRecordings(RecordNo,UserId,ClientRecordId,AudioSha256,AudioLength,AudioData,StartedAt,EndedAt)
      VALUES(@recordNo,${userId},${sqlLiteral(clientRecordId)},${sqlLiteral(audioSha256)},${audio.length},@audioData,CONVERT(datetime2,${sqlLiteral(startedSql)},120),CONVERT(datetime2,${sqlLiteral(endedSql)},120));
      COMMIT TRANSACTION;
      SELECT (SELECT @recordNo AS RecordNo FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS JsonResult;
    `, { audioData: audio });
    const recordNo = saved[0]?.JsonResult ? (JSON.parse(saved[0].JsonResult) as { RecordNo: string }).RecordNo : '';
    if (!recordNo) throw new Error('SQL Server did not return a recording number.');
    res.status(201).json({ recordNo, sha256: audioSha256, verified: true });
  } catch (error) {
    console.error('recording insert error:', error instanceof Error ? error.message : error);
    fail(res, 500, '음원 원본을 서버 원장에 등록하지 못했습니다.');
  }
});

app.post('/api/recordings/:recordNo/verify', auth, async (req: RequestWithUser, res) => {
  const recordNo = String(req.params.recordNo ?? '');
  const sha256 = typeof req.body?.sha256 === 'string' ? req.body.sha256.toUpperCase() : '';
  if (!/^\d{8}_\d{4}$/.test(recordNo) || !/^[A-F0-9]{64}$/.test(sha256)) { fail(res, 400, '원본 확인 정보를 확인해 주세요.'); return; }
  try {
    const rows = await querySql<{ AudioSha256: string; StoredSha256: string }>(`SELECT AudioSha256,CONVERT(char(64),HASHBYTES('SHA2_256',AudioData),2) AS StoredSha256 FROM dbo.NoiseRecordings WHERE RecordNo=${sqlLiteral(recordNo)} AND UserId=${sqlLiteral(req.user!.sub)}`);
    if (!rows.length) { fail(res, 404, '등록된 소음 측정 원본을 찾을 수 없습니다.'); return; }
    const original = rows[0].AudioSha256.trim().toUpperCase();
    const stored = rows[0].StoredSha256.trim().toUpperCase();
    const verified = original === stored && original === sha256;
    const notification = verified ? null
      : await notifyRecordingIntegrityMismatch(Number(req.user!.sub), recordNo, emailFrom);
    res.json({ recordNo, verified, originalSha256: original, notification });
  } catch (error) {
    console.error('recording verify error:', error instanceof Error ? error.message : error);
    fail(res, 500, '음원 원본을 검증하지 못했습니다.');
  }
});

app.put('/api/recordings/:recordNo/journal', auth, async (req: RequestWithUser, res) => {
  const recordNo = String(req.params.recordNo ?? '');
  const journal = req.body?.journal;
  const userId = Number(req.user!.sub);
  const json = JSON.stringify(journal);
  if (!/^\d{8}_\d{4}$/.test(recordNo) || !journal || typeof journal !== 'object' || Array.isArray(journal) || json.length > 3_500) { fail(res, 400, '발생 일지 내용을 확인해 주세요.'); return; }
  try {
    await executeSql(`
      IF NOT EXISTS (SELECT 1 FROM dbo.NoiseRecordings WHERE RecordNo=${sqlLiteral(recordNo)} AND UserId=${userId}) THROW 51012, 'Recording not found.', 1;
      IF EXISTS (SELECT 1 FROM dbo.NoiseIncidentJournals WHERE RecordNo=${sqlLiteral(recordNo)} AND UserId=${userId})
        UPDATE dbo.NoiseIncidentJournals SET JournalCipher=dbo.EncryptMemberData(${sqlLiteral(json)},${sqlLiteral(memberDataKey)}),UpdatedAt=SYSUTCDATETIME() WHERE RecordNo=${sqlLiteral(recordNo)} AND UserId=${userId};
      ELSE INSERT INTO dbo.NoiseIncidentJournals(RecordNo,UserId,JournalCipher) VALUES(${sqlLiteral(recordNo)},${userId},dbo.EncryptMemberData(${sqlLiteral(json)},${sqlLiteral(memberDataKey)}));
    `);
    res.json({ recordNo, message: '원본 녹음에 연결된 발생 일지를 저장했습니다.' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('journal save error:', errorMessage);
    if ((error as { number?: number }).number === 51012 || /Recording not found/i.test(errorMessage)) {
      fail(res, 404, '현재 로그인 계정에서 이 녹음 원본을 찾을 수 없습니다. 이 기록을 만든 계정으로 다시 로그인해 주세요.');
      return;
    }
    fail(res, 500, '발생 일지를 저장하지 못했습니다.');
  }
});

let activeCommitteeAudioUploads = 0;
let activeCommitteeSubmissions = 0;
const committeeUploadWindows = new Map<number, { startedAt: number; count: number }>();
const committeeSubmissionWindows = new Map<number, { startedAt: number; count: number }>();
const committeeAudioUploadGuard = (req: RequestWithUser, res: Response, next: NextFunction): void => {
  const userId = Number(req.user?.sub);
  const length = Number(req.header('content-length'));
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(length) || length < 1 || length > 100 * 1024 * 1024) {
    fail(res, 400, '제출 음원은 100MB 이하의 파일이어야 합니다.');
    return;
  }
  const now = Date.now();
  const current = committeeUploadWindows.get(userId);
  const window = !current || now - current.startedAt >= 10 * 60_000
    ? { startedAt: now, count: 1 } : { startedAt: current.startedAt, count: current.count + 1 };
  committeeUploadWindows.set(userId, window);
  if (activeCommitteeAudioUploads >= 2 || window.count > 10) {
    fail(res, 429, '제출 음원 업로드 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    return;
  }
  if (committeeUploadWindows.size > 10_000) {
    for (const [id, state] of committeeUploadWindows) if (now - state.startedAt > 10 * 60_000) committeeUploadWindows.delete(id);
  }
  activeCommitteeAudioUploads += 1;
  let released = false;
  const release = () => { if (!released) { released = true; activeCommitteeAudioUploads -= 1; } };
  res.once('finish', release);
  res.once('close', release);
  next();
};

const committeeSubmissionGuard = (req: RequestWithUser, res: Response, next: NextFunction): void => {
  const userId = Number(req.user?.sub);
  const now = Date.now();
  const current = committeeSubmissionWindows.get(userId);
  const window = !current || now - current.startedAt >= 10 * 60_000
    ? { startedAt: now, count: 1 } : { startedAt: current.startedAt, count: current.count + 1 };
  committeeSubmissionWindows.set(userId, window);
  if (committeeSubmissionWindows.size > 10_000) {
    for (const [id, state] of committeeSubmissionWindows) if (now - state.startedAt > 10 * 60_000) committeeSubmissionWindows.delete(id);
  }
  if (activeCommitteeSubmissions >= 2 || window.count > 10) {
    fail(res, 429, '위원회 제출 검증 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    return;
  }
  activeCommitteeSubmissions += 1;
  let released = false;
  const release = () => { if (!released) { released = true; activeCommitteeSubmissions -= 1; } };
  res.once('finish', release);
  res.once('close', release);
  next();
};

app.post('/api/recordings/:recordNo/committee-audio', auth, committeeAudioUploadGuard,
  express.raw({ type: 'audio/mp4', limit: '100mb' }),
  (req: RequestWithUser, res) => uploadCommitteeSubmissionAudio(req, res));
app.post('/api/recordings/:recordNo/committee-submission', auth, committeeSubmissionGuard,
  (req: RequestWithUser, res) => submitCommitteeIncident(req, res, emailFrom));
app.delete('/api/recordings/:recordNo/committee-submission', auth, withdrawCommitteeIncident);
app.get('/api/committee-contacts', auth, residentCommitteeContacts);
app.get('/api/notifications', auth, residentNotifications);
app.post('/api/notifications/:notificationId/read', auth, readResidentNotification);

app.get('/api/reports', auth, async (req: RequestWithUser, res) => {
  try {
    const rows = await querySql<{ JsonResult: string }>(`
      SELECT COALESCE((SELECT r.RecordNo,r.AudioSha256,r.StartedAt,dbo.DecryptMemberData(j.JournalCipher,${sqlLiteral(memberDataKey)}) AS Journal,
        CASE WHEN r.AudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2) THEN CAST(1 AS bit) ELSE CAST(0 AS bit) END AS Verified
        FROM dbo.NoiseRecordings r LEFT JOIN dbo.NoiseIncidentJournals j ON j.RecordNo=r.RecordNo AND j.UserId=r.UserId
        WHERE r.UserId=${sqlLiteral(req.user!.sub)} ORDER BY r.StartedAt DESC FOR JSON PATH),N'[]') AS JsonResult;
    `);
    const reports = rows.length ? JSON.parse(rows[0].JsonResult ?? '[]') : [];
    res.json({ reports });
  } catch (error) {
    console.error('reports error:', error instanceof Error ? error.message : error);
    fail(res, 500, '층간소음 보고서를 불러오지 못했습니다.');
  }
});

app.use('/api/committee', committeeAuth({
  jwtSecret, emailSecret, emailFrom, codeTtlMinutes, validEmail, validLoginId, rateLimit,
}));
app.use('/api/committee', committeeDataRouter(jwtSecret, emailFrom));

const committeeDirectory = path.resolve(__dirname, '../committee');
const sendCommitteeIndex: express.RequestHandler = (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(committeeDirectory, 'index.html'));
};
app.get(['/committee', '/committee/'], sendCommitteeIndex);
app.use('/committee', express.static(committeeDirectory, {
  index: 'index.html', etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

const supervisorDirectory = path.resolve(__dirname, '../supervisor');
const sendSupervisorIndex: express.RequestHandler = (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  res.sendFile(path.join(supervisorDirectory, 'index.html'));
};
app.get(['/supervisor', '/supervisor/'], sendSupervisorIndex);
app.use('/supervisor', express.static(supervisorDirectory, {
  index: false, etag: true, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders: res => res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive'),
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const httpError = error as { status?: number; type?: string };
  if (httpError?.status === 413) { fail(res, 413, '요청 파일 또는 입력 내용이 허용 크기를 초과했습니다.'); return; }
  if (httpError?.status === 400 && httpError.type === 'entity.parse.failed') { fail(res, 400, '요청 형식을 확인해 주세요.'); return; }
  console.error('unhandled API error:', error instanceof Error ? error.message : error);
  fail(res, 500, '요청을 처리하지 못했습니다.');
});

async function start(): Promise<void> {
  await initializeDatabase();
  await initializeCommittee();
  await initializeCommitteeDecisionNotifications();
  const cleanupStagedCommitteeAudio = async () => {
    try { await cleanupCommitteeSubmissionArtifacts(); }
    catch (error) { console.error('committee artifact cleanup error:', error instanceof Error ? error.message : error); }
  };
  await cleanupStagedCommitteeAudio();
  const artifactCleanupTimer = setInterval(cleanupStagedCommitteeAudio, 60 * 60_000);
  artifactCleanupTimer.unref();
  let notificationEmailWorkerRunning = false;
  const deliverPendingNotificationEmails = async () => {
    if (notificationEmailWorkerRunning) return;
    notificationEmailWorkerRunning = true;
    try {
      try {
        for (let index = 0; index < 5 && await retryPendingNotificationEmail(emailFrom); index += 1) { /* drain a bounded batch */ }
      } catch (error) {
        console.error('resident notification email worker error:', error instanceof Error ? error.message : error);
      }
      try {
        for (let index = 0; index < 5 && await retryPendingCommitteeDecisionEmail(emailFrom); index += 1) { /* drain a bounded batch */ }
      } catch (error) {
        console.error('committee decision email worker error:', error instanceof Error ? error.message : error);
      }
    } finally { notificationEmailWorkerRunning = false; }
  };
  void deliverPendingNotificationEmails();
  const notificationEmailTimer = setInterval(deliverPendingNotificationEmails, 60_000);
  notificationEmailTimer.unref();
  if (demoLoginEnabled && process.env.NODE_ENV !== 'production') await seedDemoUser();
  app.listen(port, host, () => console.log(`MuteLab API listening on http://${host}:${port}`));
}

async function seedDemoUser(): Promise<void> {
  const existing = await scalarJson<{ UserId: number }>(`SELECT COALESCE((SELECT UserId FROM dbo.AppUsers WHERE LoginIdHash=dbo.MemberLookupHash(N'mutelab-demo',${sqlLiteral(memberDataKey)}) FOR JSON PATH,WITHOUT_ARRAY_WRAPPER),N'{}') AS JsonResult`);
  if (existing?.UserId) return;
  const profile = {
    profile_name: '김뮤트', profile_email: 'demo@mutelab.local', profile_phone: '01012345678',
    profile_address: '서울특별시 강남구 테헤란로 123', profile_address2: '101동 1001호', profile_postal: '06234',
    profile_house: '뮤트랩 테스트아파트', profile_manager_name: '뮤트랩 관리사무소',
    profile_manager_representative: '홍길동', profile_manager_phone: '025550100',
    profile_manager_email: 'manager@mutelab.local', profile_manager: true, profile_terms: true, profile_privacy: true
  };
  const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  const profileJson = JSON.stringify(profile);
  await executeSql(`INSERT INTO dbo.AppUsers(LoginIdCipher,LoginIdHash,EmailCipher,EmailHash,PasswordHash,ProfileCipher)
    VALUES(dbo.EncryptMemberData(N'mutelab-demo',${sqlLiteral(memberDataKey)}),dbo.MemberLookupHash(N'mutelab-demo',${sqlLiteral(memberDataKey)}),dbo.EncryptMemberData(N'demo@mutelab.local',${sqlLiteral(memberDataKey)}),dbo.MemberLookupHash(N'demo@mutelab.local',${sqlLiteral(memberDataKey)}),${sqlLiteral(passwordHash)},dbo.EncryptMemberData(${sqlLiteral(profileJson)},${sqlLiteral(memberDataKey)}));`);
  console.log('Development demo member and management profile are ready.');
}

void start().catch((error: unknown) => {
  console.error('API startup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

