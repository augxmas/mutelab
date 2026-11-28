import crypto from 'node:crypto';
import { isIP } from 'node:net';
import express from 'express';
import bcrypt from 'bcryptjs';
import { committeeDocumentType } from './committee-document-type';
import jwt from 'jsonwebtoken';
import { memberDataKey as key, querySql } from './db';
import { sendVerificationEmail } from './verification-email';

export const field = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const committeeSessionSeconds = 300;
const lookup = (name: string) => `dbo.MemberLookupHash(@${name},@key)`;
const signatureKey = () => crypto.createHash('sha256').update(key).update(':committee-signature:v1').digest();
function encryptSignature(value: unknown): Buffer | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 349_528 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const png = Buffer.from(value, 'base64');
  if (png.length < 33 || png.length > 256 * 1024 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(8) !== 13
      || png.readUInt32BE(16) < 1 || png.readUInt32BE(16) > 640 || png.readUInt32BE(20) < 1 || png.readUInt32BE(20) > 320) return undefined;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', signatureKey(), iv);
  return Buffer.concat([iv, cipher.update(png), cipher.final(), cipher.getAuthTag()]);
}

function decryptSignature(encrypted: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', signatureKey(), encrypted.subarray(0, 12));
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(12, -16)), decipher.final()]).toString('base64');
}

export async function initializeCommittee() {
  const [state] = await querySql<{ Ready: number }>(`
    SELECT CASE WHEN OBJECT_ID(N'dbo.CommitteeMembers',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeApplications',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeLoginCodes',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeSubmissions',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeSubmissionArtifactBindings',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeCounterpartOverrides',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeCounterpartHistory',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.ResidentNotifications',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.CommitteeIntegrityEvents',N'U') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmissionArtifactId') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityStatus') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeSubmissions',N'WithdrawnAt') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmissionVersion') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeSubmissionArtifacts',N'ArtifactSource') IS NOT NULL
      AND COL_LENGTH(N'dbo.ResidentNotifications',N'EmailClaimedAt') IS NOT NULL
      AND COL_LENGTH(N'dbo.ResidentNotifications',N'EmailAttempts') IS NOT NULL
      AND COL_LENGTH(N'dbo.ResidentNotifications',N'EmailNextAttemptAt') IS NOT NULL
      AND COL_LENGTH(N'dbo.ResidentNotifications',N'RelatedArtifactId') IS NOT NULL
      AND COL_LENGTH(N'dbo.CommitteeIntegrityEvents',N'OriginalObservedAudioSha256') IS NOT NULL
      /* Back-office review procedures intentionally deny API execution and metadata visibility. */
      AND DATABASE_PRINCIPAL_ID(N'MuteLabCommitteeApproverRole') IS NOT NULL
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_NoiseRecordings_InsertOnly') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_NoiseRecordings_ValidateInsert') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_CommitteeSubmissionArtifacts_InsertOnly') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_CommitteeSubmissionArtifacts_ValidateInsert') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_CommitteeSubmissions_IntegrityGuard') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.triggers WHERE object_id=OBJECT_ID(N'dbo.TR_CommitteeSubmissions_ArtifactTransition') AND is_disabled=0)
      AND EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeMembers') AND name=N'UX_CommitteeMembers_Chair')
      THEN 1 ELSE 0 END AS Ready
  `);
  if (state?.Ready === 1) return;
  throw new Error('Committee schema is incomplete. Apply server/committee-schema.sql once with a database administrator account.');
}

export function committeeAuth(options: {
  jwtSecret:string; emailSecret:string; emailFrom:string; codeTtlMinutes:number;
  validEmail:(value:unknown)=>boolean; validLoginId:(value:unknown)=>boolean;
  rateLimit:(key:string,max:number,ms:number)=>boolean;
}) {
  const router = express.Router();
  router.use((_req,res,next) => {res.set('Cache-Control','no-store');next();});
  router.post('/signup',express.json({limit:'15mb',type:'application/vnd.mutelab.committee+json'}),async (req,res) => {
    if (options.rateLimit('committee-signup:' + req.ip,15,600_000)) return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
    const b = req.body ?? {};
    const loginId = field(b.loginId), email = field(b.email).toLowerCase(), kaptCode = field(b.kaptCode);
    const name = field(b.name), mobileInput = field(b.mobile), contactInput = field(b.contact);
    const mobile = mobileInput.replace(/[ -]/g,''), contact = contactInput.replace(/[ -]/g,'');
    const requestedAddressDetail = field(b.addressDetail) || field(b.detailAddress) || field(b.address);
    const role = field(b.role);
    const password = b.password, token = field(b.verificationToken), doc = field(b.document), docName = field(b.documentName);
    const signature = encryptSignature(b.signature ?? null);
    if (signature === undefined) return res.status(400).json({ error: '도장 또는 서명 이미지 형식이나 크기를 확인해 주세요.' });
    if (!options.validLoginId(loginId) || !options.validEmail(email) || !/^[A-Z0-9]{1,50}$/.test(kaptCode)
        || !name || name.length > 80 || !/^[0-9 -]+$/.test(mobileInput) || !/^010\d{8}$/.test(mobile)
        || !/^[0-9 -]+$/.test(contactInput) || !/^\d{8,11}$/.test(contact)
        || !requestedAddressDetail || requestedAddressDetail.length > 400
        || /[\u0000-\u001f\u007f]/.test(requestedAddressDetail)
        || !['위원장','위원'].includes(role) || !/^[a-f0-9]{64}$/.test(token)
        || typeof password !== 'string' || !/^[!-~]{8,72}$/.test(password) || !/[a-z]/.test(password)
        || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password) || password !== b.passwordConfirm
        || b.terms !== true || b.privacy !== true || b.disclosure !== true) {
      return res.status(400).json({error:'입력 정보, 비밀번호 조건 및 필수 동의 항목을 확인해 주세요.'});
    }
    if (!docName || docName.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(doc)) {
      return res.status(400).json({error:'관리사무소 사업자등록증을 첨부해 주세요.'});
    }
    const bytes = Buffer.from(doc,'base64');
    const type = committeeDocumentType(bytes);
    if (!type || bytes.length > 10 * 1024 * 1024) return res.status(400).json({error:'10MB 이하 PDF, PNG, JPEG, GIF 또는 WebP 파일을 첨부해 주세요.'});
    const iv = crypto.randomBytes(12);
    const documentKey = crypto.createHash('sha256').update(key).update(':committee-document').digest();
    const cipher = crypto.createCipheriv('aes-256-gcm',documentKey,iv);
    const document = Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
    const documentSha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
    const [complex] = await querySql<{ BaseAddress: string | null }>(`
      SELECT COALESCE(NULLIF(roadAddress,N''),NULLIF(address,N''),NULLIF(legalAddress,N''),
        NULLIF(CONCAT_WS(N' ',sido,sigungu),N'')) AS BaseAddress
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode;
    `,{kaptCode});
    const baseAddress = field(complex?.BaseAddress);
    // addressDetail is the canonical request field. The aliases keep already-open signup pages working;
    // any matching base-address prefix is discarded because the database value is authoritative.
    const addressDetail = !field(b.addressDetail) && !field(b.detailAddress)
      && (requestedAddressDetail === baseAddress || requestedAddressDetail.startsWith(baseAddress + ' '))
      ? field(requestedAddressDetail.slice(baseAddress.length)) : requestedAddressDetail;
    const address = [baseAddress,addressDetail].filter(Boolean).join(' ');
    if (!baseAddress) return res.status(400).json({error:'선택한 단지의 주소를 확인할 수 없습니다. 단지를 다시 선택해 주세요.'});
    if (!addressDetail || addressDetail.length > 120 || address.length > 400) {
      return res.status(400).json({error:'상세주소는 120자 이내로 입력해 주세요.'});
    }
    const member = JSON.stringify({
      loginId,name,mobile,contact,address,baseAddress,addressDetail,role,docName,mime:type.mime,documentSha256,
      terms:true,privacy:true,disclosure:true,
      consentVersion:2,consentedAt:new Date().toISOString(),
    });
    try {
      const [application] = await querySql<{ApplicationId:number}>(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @identityLock int,@complexLock int,@resource nvarchar(100)=N'MuteLab.Committee.'+@kaptCode,
          @applicationId bigint;
        EXEC @identityLock=sp_getapplock @Resource=N'MuteLab.Committee.Identity',@LockMode='Exclusive',@LockOwner='Transaction';
        IF @identityLock<0 THROW 51020,'Committee identity lock failed.',1;
        EXEC @complexLock=sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction';
        IF @complexLock<0 THROW 51020,'Committee lock failed.',1;
        IF NOT EXISTS(SELECT 1 FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode) THROW 51021,'Unknown apartment.',1;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE EmailHash=${lookup('email')})
          OR EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE EmailHash=${lookup('email')} AND Status='PENDING')
          THROW 51114,'Committee email already reserved.',1;
        IF @role=N'위원장' AND (EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Role=N'위원장')
          OR EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE KaptCode=@kaptCode AND RequestedRole=N'위원장' AND Status='PENDING'))
          THROW 51024,'Chair already exists.',1;
        IF ((SELECT COUNT_BIG(*) FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode)
          +(SELECT COUNT_BIG(*) FROM dbo.CommitteeApplications WHERE KaptCode=@kaptCode AND Status='PENDING'))>=3
          THROW 51022,'Committee full.',1;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE LoginHash=${lookup('loginId')}
          OR MobileHash=${lookup('mobile')})
          THROW 51025,'Committee identity already registered.',1;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE Status='PENDING'
          AND (LoginHash=${lookup('loginId')} OR MobileHash=${lookup('mobile')}))
          THROW 51026,'Committee application already pending.',1;
        DELETE FROM dbo.VerifiedEmailTokens WHERE TokenHash=@token AND EmailHash=${lookup('email')}
          AND Purpose='committee-signup' AND ExpiresAt>SYSUTCDATETIME();
        IF @@ROWCOUNT<>1 THROW 51023,'Email verification required.',1;
        INSERT dbo.CommitteeApplications(KaptCode,RequestedRole,LoginHash,EmailHash,MobileHash,EmailCipher,
          MemberCipher,DocumentCipher,DocumentSha256,PasswordHash,ConsentedAt)
        VALUES(@kaptCode,@role,${lookup('loginId')},${lookup('email')},${lookup('mobile')},
          dbo.EncryptMemberData(@email,@key),dbo.EncryptMemberData(@member,@key),@document,@documentSha256,
          @passwordHash,SYSUTCDATETIME());
        SET @applicationId=SCOPE_IDENTITY();
        ${signature ? `INSERT dbo.CommitteeSignatureAssets(ApplicationId,ImageCipher) VALUES(@applicationId,@signature);` : ''}
        COMMIT TRANSACTION;
        SELECT @applicationId AS ApplicationId;
      `,{kaptCode,role,loginId,email,mobile,key,member,document,documentSha256, ...(signature ? { signature } : {}),
        token:hash(token),passwordHash:await bcrypt.hash(password,12)});
      if (!application) throw new Error('Committee application was not stored.');
      res.status(202).json({status:'PENDING_REVIEW',applicationId:Number(application.ApplicationId),
        message:'가입 신청이 접수되었습니다. 사업자등록증과 단지 소속 확인 후 승인되면 로그인할 수 있습니다.'});
    } catch (cause) {
      const message = String(cause);
      if ((cause as { number?: number }).number === 51114)
        return res.status(409).json({error:'이미 위원으로 등록했거나 승인 대기 중인 이메일입니다. 같은 이메일로 다시 신청할 수 없습니다.'});
      if (message.includes('Committee full')) return res.status(409).json({error:'이 단지는 위원장과 위원 3명이 모두 등록되었습니다.'});
      if (message.includes('Chair already exists')) return res.status(409).json({error:'이 단지에는 위원장이 이미 등록되어 있습니다.'});
      if (message.includes('Unknown apartment')) return res.status(400).json({error:'단지를 다시 선택해 주세요.'});
      if (message.includes('Email verification required')) return res.status(400).json({error:'이메일 인증을 다시 진행해 주세요.'});
      if (message.includes('identity already registered')) return res.status(409).json({error:'이미 등록된 아이디, 이메일 또는 모바일폰 번호입니다.'});
      if (message.includes('application already pending')) return res.status(409).json({error:'이미 승인 대기 중인 아이디, 이메일 또는 모바일폰 번호입니다.'});
      if (/duplicate|unique/i.test(message)) return res.status(409).json({error:'이미 등록된 아이디, 이메일 또는 모바일폰 번호입니다.'});
      throw cause;
    }
  });

  const digest = (challenge:string,code:string) => crypto.createHmac('sha256',options.emailSecret).update(challenge+':'+code).digest('hex');
  router.post('/login',async (req,res) => {
    const loginId = field(req.body?.loginId), password = req.body?.password;
    if (options.rateLimit('committee-login:' + req.ip,20,600_000)) return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
    if (!options.validLoginId(loginId) || typeof password !== 'string' || Buffer.byteLength(password)>72) {
      return res.status(400).json({error:'아이디와 비밀번호를 확인해 주세요.'});
    }
    const [member] = await querySql<{MemberId:number; Email:string; PasswordHash:string; ApprovedAt:Date|null}>(`
      SELECT MemberId,dbo.DecryptMemberData(EmailCipher,@key) AS Email,PasswordHash,ApprovedAt
      FROM dbo.CommitteeMembers WHERE LoginHash=${lookup('loginId')}`,{loginId,key});
    if (!member) {
      const [application] = await querySql<{PasswordHash:string;Status:string;ReviewNote:string|null}>(`
        SELECT TOP (1) PasswordHash,Status,dbo.DecryptMemberData(ReviewNoteCipher,@key) AS ReviewNote FROM dbo.CommitteeApplications
        WHERE LoginHash=${lookup('loginId')} ORDER BY ApplicationId DESC`,{loginId,key});
      if (!application || !await bcrypt.compare(password,application.PasswordHash))
        return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
      if (application.Status === 'PENDING')
        return res.status(403).json({error:'사업자등록증과 단지 소속 확인이 진행 중입니다. 승인 후 로그인할 수 있습니다.'});
      if (application.Status === 'REJECTED')
        return res.status(403).json({error: application.ReviewNote?.trim()
          ? `위원회 가입 신청이 반려되었습니다. 사유: ${application.ReviewNote.trim()}`
          : '위원회 가입 신청이 반려되었습니다. 자세한 내용은 안내 이메일을 확인해 주세요.'});
      return res.status(403).json({error:'위원회 계정 상태를 확인해 주세요.'});
    }
    if (!await bcrypt.compare(password,member.PasswordHash)) return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
    if (!member.ApprovedAt) return res.status(403).json({error:'위원회 소속 확인이 진행 중입니다.'});
    if (options.rateLimit('committee-otp:' + member.MemberId,1,45_000)) return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
    const challengeId = crypto.randomBytes(32).toString('hex');
    const code = String(crypto.randomInt(1_000_000)).padStart(6,'0');
    const challenge = hash(challengeId);
    await querySql(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      UPDATE dbo.CommitteeLoginCodes WITH(UPDLOCK,HOLDLOCK)
      SET ChallengeId=@challenge,CodeHash=@code,ExpiresAt=DATEADD(minute,@ttl,SYSUTCDATETIME()),Attempts=0 WHERE MemberId=@id;
      IF @@ROWCOUNT=0 INSERT dbo.CommitteeLoginCodes(MemberId,ChallengeId,CodeHash,ExpiresAt)
        VALUES(@id,@challenge,@code,DATEADD(minute,@ttl,SYSUTCDATETIME()));
      COMMIT TRANSACTION;`,{id:member.MemberId,challenge,code:digest(challengeId,code),ttl:options.codeTtlMinutes});
    try {
      await sendVerificationEmail({from:options.emailFrom,to:member.Email,code,ttlMinutes:options.codeTtlMinutes,purpose:'committee-login'});
    } catch (cause) {
      await querySql('DELETE dbo.CommitteeLoginCodes WHERE ChallengeId=@challenge',{challenge});
      throw cause;
    }
    res.json({challengeId,message:'가입한 이메일로 인증코드를 보냈습니다.'});
  });
  router.post('/login/verify',async (req,res) => {
    const challengeId = field(req.body?.challengeId), code = field(req.body?.code);
    if (options.rateLimit('committee-verify:' + req.ip,40,600_000)) return res.status(429).json({error:'잠시 후 다시 시도해 주세요.'});
    if (!/^[a-f0-9]{64}$/.test(challengeId) || !/^\d{6}$/.test(code)) return res.status(400).json({error:'6자리 인증코드를 입력해 주세요.'});
    const [member] = await querySql<{MemberId:number}>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @verified TABLE(MemberId int);
      DELETE dbo.CommitteeLoginCodes OUTPUT deleted.MemberId INTO @verified
        WHERE ChallengeId=@challenge AND CodeHash=@code AND Attempts<5 AND ExpiresAt>SYSUTCDATETIME();
      IF @@ROWCOUNT=0 UPDATE dbo.CommitteeLoginCodes SET Attempts=Attempts+1
        WHERE ChallengeId=@challenge AND Attempts<5 AND ExpiresAt>SYSUTCDATETIME();
      SELECT m.MemberId FROM @verified v JOIN dbo.CommitteeMembers m ON m.MemberId=v.MemberId WHERE m.ApprovedAt IS NOT NULL;
      COMMIT TRANSACTION;`,{challenge:hash(challengeId),code:digest(challengeId,code)});
    if (!member) return res.status(401).json({error:'인증코드가 틀렸거나 만료되었습니다.'});
    const sessionId = crypto.randomBytes(32).toString('hex');
    const loginIp = req.ip ?? req.socket.remoteAddress ?? '';
    const ip = isIP(loginIp) ? loginIp : '확인되지 않음';
    const [history] = await querySql<{ LoggedInAt: Date; ExpiresAt: Date; PreviousLoginAt: Date | null;
      PreviousIp: string | null; PreviousLogoutAt: Date | null }>(`
      SET XACT_ABORT ON;
      SET NOCOUNT ON;
      BEGIN TRANSACTION;
      DECLARE @now datetime2(3)=SYSUTCDATETIME(), @expiry datetime2(3), @previousAt datetime2(3),
        @previousLogout datetime2(3), @previousIp nvarchar(64), @lock int,
        @resource nvarchar(100)=CONCAT(N'MuteLab.CommitteeSession:',@memberId);
      EXEC @lock=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
      IF @lock<0 THROW 51121,'Committee session could not be started.',1;
      SET @now=SYSUTCDATETIME();
      SET @expiry=DATEADD(second,@idle,@now);
      UPDATE dbo.CommitteeSessions SET LoggedOutAt=ExpiresAt
      WHERE MemberId=@memberId AND LoggedOutAt IS NULL AND ExpiresAt<=@now;
      SELECT TOP (1) @previousAt=LoggedInAt,
        @previousLogout=LoggedOutAt,
        @previousIp=dbo.DecryptMemberData(LoginIpCipher,@key)
      FROM dbo.CommitteeSessions WITH(UPDLOCK,HOLDLOCK) WHERE MemberId=@memberId
      ORDER BY LoggedInAt DESC, SessionHash DESC;
      INSERT dbo.CommitteeSessions(SessionHash,MemberId,LoginIpCipher,LoggedInAt,ExpiresAt)
        VALUES(@sessionHash,@memberId,dbo.EncryptMemberData(@ip,@key),@now,@expiry);
      COMMIT TRANSACTION;
      SELECT @now AS LoggedInAt,@expiry AS ExpiresAt,@previousAt AS PreviousLoginAt,
        @previousIp AS PreviousIp,@previousLogout AS PreviousLogoutAt;
    `, { sessionHash: hash(sessionId), memberId: member.MemberId, ip, key, idle: committeeSessionSeconds });
    setCommitteeSessionHeaders(res, history.ExpiresAt);
    res.json({
      token: jwt.sign({}, options.jwtSecret, { issuer:'mutelab-committee', audience:'committee',
        subject:String(member.MemberId), jwtid:sessionId }),
      login: { loggedInAt: history.LoggedInAt, ip },
      idleSeconds: committeeSessionSeconds,
      previousLogin: history.PreviousLoginAt ? { loggedInAt: history.PreviousLoginAt,
        ip: history.PreviousIp, loggedOutAt: history.PreviousLogoutAt } : null,
    });
  });

  const settingsAccess = committeeAccess(options.jwtSecret);
  router.post('/session/extend', settingsAccess, (_req, res) => { res.sendStatus(204); });
  router.post('/session/logout', committeeAccess(options.jwtSecret, 'logout'), (_req, res) => { res.sendStatus(204); });
  const readSettingsMember = (id: number) => querySql<{ MemberJson: string; Email: string; PasswordHash: string; Version: string }>(`
    SELECT dbo.DecryptMemberData(m.MemberCipher,@key) AS MemberJson,
      dbo.DecryptMemberData(m.EmailCipher,@key) AS Email,m.PasswordHash,
      CONVERT(char(64),HASHBYTES('SHA2_256',m.MemberCipher),2) AS Version
    FROM dbo.CommitteeMembers m WHERE m.MemberId=@id AND m.ApprovedAt IS NOT NULL
  `, { id, key });
  router.get('/member-settings', settingsAccess, async (_req, res) => {
    const [row] = await readSettingsMember(res.locals.memberId);
    if (!row) return res.status(404).json({ error: '위원회 계정을 찾을 수 없습니다.' });
    const member = JSON.parse(row.MemberJson);
    const [complex] = await querySql<{ Name: string; Address: string }>(`
      SELECT TOP(1) kaptName AS Name,COALESCE(NULLIF(roadAddress,N''),NULLIF(address,N''),NULLIF(legalAddress,N'')) AS Address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode: res.locals.kaptCode });
    const baseAddress = field(complex?.Address) || field(member.baseAddress);
    const oldAddress = field(member.address);
    const [signature] = await querySql<{ ImageCipher: Buffer | null }>(`
      SELECT TOP(1) ImageCipher FROM (
        SELECT 0 AS Priority,AssetId,ImageCipher FROM dbo.CommitteeSignatureAssets WHERE MemberId=@id
        UNION ALL
        SELECT 1 AS Priority,s.AssetId,s.ImageCipher FROM dbo.CommitteeSignatureAssets s
        JOIN dbo.CommitteeApplications a ON a.ApplicationId=s.ApplicationId
        WHERE a.ApprovedMemberId=@id AND a.Status='APPROVED'
      ) images ORDER BY Priority,AssetId DESC
    `, { id: res.locals.memberId });
    res.json({
      loginId: field(member.loginId), email: row.Email, role: res.locals.committeeRole, complexName: complex?.Name ?? '',
      name: field(member.name), mobile: field(member.mobile), contact: field(member.contact), baseAddress,
      addressDetail: field(member.addressDetail) || (oldAddress.startsWith(baseAddress) ? oldAddress.slice(baseAddress.length).trim() : ''),
      version: row.Version, signature: signature?.ImageCipher ? decryptSignature(signature.ImageCipher) : null,
    });
  });

  router.put('/member-settings', settingsAccess,
    express.json({ limit: '512kb', type: 'application/vnd.mutelab.committee+json' }), async (req, res) => {
    const id: number = res.locals.memberId;
    if (options.rateLimit('committee-settings:' + id, 8, 600_000)) {
      return res.status(429).json({ error: '확인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
    }
    const body = req.body ?? {};
    const changeSignature = Object.hasOwn(body, 'signature');
    const signature = changeSignature ? encryptSignature(body.signature) : null;
    if (signature === undefined) return res.status(400).json({ error: '도장 또는 서명 이미지 형식이나 크기를 확인해 주세요.' });
    const name = field(body.name), mobile = field(body.mobile).replace(/[\s-]/g, '');
    const contact = field(body.contact).replace(/[\s-]/g, ''), addressDetail = field(body.addressDetail);
    const version = field(body.version), password = body.password;
    if (!name || name.length > 80 || !/^01\d{8,9}$/.test(mobile) || !/^0\d{7,10}$/.test(contact)
        || !addressDetail || addressDetail.length > 120 || !/^[\dA-F]{64}$/.test(version)
        || typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: '이름, 전화번호, 상세주소와 현재 비밀번호를 확인해 주세요.' });
    }
    const [row] = await readSettingsMember(id);
    if (!row || !await bcrypt.compare(password, row.PasswordHash)) {
      return res.status(403).json({ error: '현재 비밀번호가 올바르지 않습니다.' });
    }
    if (row.Version !== version) return res.status(409).json({ error: '정보가 변경되었습니다. 설정 화면을 다시 열어 주세요.' });
    const member = JSON.parse(row.MemberJson);
    const [complex] = await querySql<{ Address: string }>(`
      SELECT TOP(1) COALESCE(NULLIF(roadAddress,N''),NULLIF(address,N''),NULLIF(legalAddress,N'')) AS Address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode: res.locals.kaptCode });
    const baseAddress = field(complex?.Address) || field(member.baseAddress);
    const updated = JSON.stringify({ ...member, name, mobile, contact, baseAddress, addressDetail,
      address: [baseAddress, addressDetail].filter(Boolean).join(' ') });
    if (updated.length > 3500) return res.status(400).json({ error: '위원 정보가 너무 깁니다. 입력 내용을 확인해 주세요.' });
    try {
      await querySql(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @lock int;
        EXEC @lock=sp_getapplock @Resource=N'MuteLab.Committee.Identity',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
        IF @lock<0 THROW 51072,'Committee identity is busy.',1;
        DECLARE @mobileHash char(64)=dbo.MemberLookupHash(@mobile,@key);
        IF EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE MobileHash=@mobileHash AND MemberId<>@id)
          OR EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE MobileHash=@mobileHash AND Status='PENDING')
          THROW 51071,'Committee mobile is in use.',1;
        UPDATE dbo.CommitteeMembers SET MobileHash=@mobileHash,MemberCipher=dbo.EncryptMemberData(@updated,@key)
        WHERE MemberId=@id AND KaptCode=@kaptCode AND ApprovedAt IS NOT NULL AND PasswordHash=@passwordHash
          AND CONVERT(char(64),HASHBYTES('SHA2_256',MemberCipher),2)=@version;
        IF @@ROWCOUNT<>1 THROW 51072,'Committee member changed.',1;
        ${changeSignature ? `
          UPDATE dbo.CommitteeSignatureAssets SET ImageCipher=CONVERT(varbinary(max),@signature) WHERE MemberId=@id;
          IF @@ROWCOUNT=0 INSERT dbo.CommitteeSignatureAssets(MemberId,ImageCipher) VALUES(@id,CONVERT(varbinary(max),@signature));
        ` : ''}
        COMMIT TRANSACTION;
      `, { id, kaptCode: res.locals.kaptCode, key, mobile, updated, version, passwordHash: row.PasswordHash,
        ...(changeSignature ? { signature } : {}) });
    } catch (error) {
      const number = (error as { number?: number }).number;
      if (number === 51071 || number === 2601 || number === 2627) return res.status(409).json({ error: '이미 등록되었거나 승인 대기 중인 휴대전화 번호입니다.' });
      if (number === 51072) return res.status(409).json({ error: '정보가 변경되었거나 처리 중입니다. 설정 화면을 다시 열어 주세요.' });
      throw error;
    }
    res.json({ message: '위원 정보를 저장했습니다.' });
  });
  return router;
}

function setCommitteeSessionHeaders(res: express.Response, expiresAt: Date): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Committee-Session-Expires', String(expiresAt.getTime()));
  res.set('X-Committee-Session-Now', String(Date.now()));
}

export function committeeAccess(secret:string, action: 'refresh' | 'logout' | 'observe' = 'refresh'):express.RequestHandler {
  return async (req,res,next) => {
    let id: number;
    let sessionId = '';
    try {
      const token = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1] ?? '';
      const claims = jwt.verify(token,secret,{issuer:'mutelab-committee',audience:'committee',algorithms:['HS256']});
      id = typeof claims === 'object' ? Number(claims.sub) : NaN;
      sessionId = typeof claims === 'object' && typeof claims.jti === 'string' ? claims.jti : '';
    } catch { id = NaN; }
    if (!Number.isSafeInteger(id) || id < 1 || !/^[a-f0-9]{64}$/.test(sessionId)) {
      res.status(401).json({error:'위원회 로그인이 필요합니다.'}); return;
    }
    const [member] = await querySql<{MemberId:number;KaptCode:string;Role:string;ExpiresAt:Date}>(`
      SET NOCOUNT ON;
      DECLARE @now datetime2(3)=SYSUTCDATETIME(), @expiry datetime2(3);
      SET @expiry=DATEADD(second,@idle,@now);
      ${action === 'observe' ? 'SELECT m.MemberId,m.KaptCode,m.Role,s.ExpiresAt' : `
        UPDATE s SET ${action === 'logout' ? 'LoggedOutAt=@now' : 'ExpiresAt=CASE WHEN s.ExpiresAt>@expiry THEN s.ExpiresAt ELSE @expiry END'}
        OUTPUT m.MemberId,m.KaptCode,m.Role,inserted.ExpiresAt`}
      FROM dbo.CommitteeSessions s
      JOIN dbo.CommitteeMembers m ON m.MemberId=s.MemberId AND m.ApprovedAt IS NOT NULL
      WHERE s.SessionHash=@sessionHash AND s.MemberId=@id
        AND s.LoggedOutAt IS NULL AND s.ExpiresAt>@now;
    `, { id, sessionHash: hash(sessionId), idle: committeeSessionSeconds });
    if (!member) { res.status(401).json({error:'세션이 종료되었습니다. 다시 로그인해 주세요.',code:'SESSION_EXPIRED'}); return; }
    if (action === 'refresh') setCommitteeSessionHeaders(res, member.ExpiresAt);
    else res.set('Cache-Control', 'no-store');
    res.locals.memberId = member.MemberId;
    res.locals.kaptCode = member.KaptCode;
    res.locals.committeeRole = member.Role;
    next();
  };
}
