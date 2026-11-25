import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { memberDataKey as key, querySql } from './db';
import { sendVerificationEmail } from './verification-email';

export const field = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const lookup = (name: string) => `dbo.MemberLookupHash(@${name},@key)`;

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
    const name = field(b.name), mobile = field(b.mobile).replace(/[\s-]/g,'');
    const contact = field(b.contact).replace(/[\s-]/g,''), address = field(b.address), role = field(b.role);
    const password = b.password, token = field(b.verificationToken), doc = field(b.document), docName = field(b.documentName);
    if (!options.validLoginId(loginId) || !options.validEmail(email) || !/^[A-Z0-9]{1,50}$/.test(kaptCode)
        || !name || name.length > 80 || !/^010\d{8}$/.test(mobile) || !/^\d{7,15}$/.test(contact)
        || !address || address.length > 400
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
    const mime = bytes.subarray(0,5).toString() === '%PDF-' ? 'application/pdf'
      : bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) ? 'image/png'
      : bytes.subarray(0,3).equals(Buffer.from('ffd8ff','hex')) ? 'image/jpeg' : '';
    if (!mime || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) return res.status(400).json({error:'10MB 이하 PDF, PNG 또는 JPEG를 첨부해 주세요.'});
    const iv = crypto.randomBytes(12);
    const documentKey = crypto.createHash('sha256').update(key).update(':committee-document').digest();
    const cipher = crypto.createCipheriv('aes-256-gcm',documentKey,iv);
    const document = Buffer.concat([iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);
    const documentSha256 = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
    const member = JSON.stringify({
      loginId,name,mobile,contact,address,role,docName,mime,documentSha256,terms:true,privacy:true,disclosure:true,
      consentVersion:1,consentedAt:new Date().toISOString(),
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
        IF @role=N'위원장' AND EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Role=N'위원장')
          THROW 51024,'Chair already exists.',1;
        IF (SELECT COUNT_BIG(*) FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode)>=3
          THROW 51022,'Committee full.',1;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE LoginHash=${lookup('loginId')}
          OR EmailHash=${lookup('email')} OR MobileHash=${lookup('mobile')})
          THROW 51025,'Committee identity already registered.',1;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE Status='PENDING'
          AND (LoginHash=${lookup('loginId')} OR EmailHash=${lookup('email')} OR MobileHash=${lookup('mobile')}))
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
        COMMIT TRANSACTION;
        SELECT @applicationId AS ApplicationId;
      `,{kaptCode,role,loginId,email,mobile,key,member,document,documentSha256,
        token:hash(token),passwordHash:await bcrypt.hash(password,12)});
      if (!application) throw new Error('Committee application was not stored.');
      res.status(202).json({status:'PENDING_REVIEW',applicationId:Number(application.ApplicationId),
        message:'가입 신청이 접수되었습니다. 사업자등록증과 단지 소속 확인 후 승인되면 로그인할 수 있습니다.'});
    } catch (cause) {
      const message = String(cause);
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
      const [application] = await querySql<{PasswordHash:string;Status:string}>(`
        SELECT TOP (1) PasswordHash,Status FROM dbo.CommitteeApplications
        WHERE LoginHash=${lookup('loginId')} ORDER BY ApplicationId DESC`,{loginId,key});
      if (!application || !await bcrypt.compare(password,application.PasswordHash))
        return res.status(401).json({error:'아이디 또는 비밀번호가 올바르지 않습니다.'});
      if (application.Status === 'PENDING')
        return res.status(403).json({error:'사업자등록증과 단지 소속 확인이 진행 중입니다. 승인 후 로그인할 수 있습니다.'});
      if (application.Status === 'REJECTED')
        return res.status(403).json({error:'위원회 가입 신청이 승인되지 않았습니다. 운영자에게 확인해 주세요.'});
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
    res.json({token:jwt.sign({},options.jwtSecret,{issuer:'mutelab-committee',audience:'committee',subject:String(member.MemberId),expiresIn:'8h'})});
  });
  return router;
}

export function committeeAccess(secret:string):express.RequestHandler {
  return async (req,res,next) => {
    let id: number;
    try {
      const token = /^Bearer (.+)$/.exec(req.header('authorization') ?? '')?.[1] ?? '';
      const claims = jwt.verify(token,secret,{issuer:'mutelab-committee',audience:'committee',algorithms:['HS256']});
      id = typeof claims === 'object' ? Number(claims.sub) : NaN;
    } catch { id = NaN; }
    if (!Number.isSafeInteger(id) || id < 1) { res.status(401).json({error:'위원회 로그인이 필요합니다.'}); return; }
    const [member] = await querySql<{MemberId:number;KaptCode:string;Role:string}>(
      'SELECT MemberId,KaptCode,Role FROM dbo.CommitteeMembers WHERE MemberId=@id AND ApprovedAt IS NOT NULL',{id});
    if (!member) { res.status(403).json({error:'위원회 접근 권한이 없습니다.'}); return; }
    res.set('Cache-Control','no-store');
    res.locals.memberId = member.MemberId;
    res.locals.kaptCode = member.KaptCode;
    res.locals.committeeRole = member.Role;
    next();
  };
}
