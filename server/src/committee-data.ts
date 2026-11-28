import { isIP } from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { committeeAccess, field } from './committee-auth';
import { memberDataKey, querySql } from './db';
import { normalizeRoomNumber } from './room-number';
import { createIncidentPdf, createMediationPdf, createVisitApplicationPdf } from './committee-pdf';
import { sendNotificationEmail } from './verification-email';
import { committeeDecisionNotifications, committeeUnreadNotificationCount, readCommitteeDecisionNotification } from './committee-decision-notifications';
import { decryptInquiryImage, encryptInquiryImage, formatInquiry, type InquiryRow } from './committee-inquiry-files';

type JsonObject = Record<string, unknown>;
type ResidentRequest = Request & { user?: { sub: string } };

interface SubmissionRow {
  ReportId: number | null;
  ReportCreatedAt: Date | null;
  ReportKey: string | null;
  CounterpartVersion: string | null;
  RecordNo: string;
  UserId: number;
  ArtifactId: number;
  ArtifactSource: string;
  SubmissionVersion: string;
  JournalVersion: string;
  StartedAt: Date;
  EndedAt: Date;
  Journal: string;
  Details: string;
  CounterpartOverride: string | null;
  CounterpartUpdatedAt: Date | null;
  CounterpartEditor: string | null;
  SubmittedAudioSha256: string;
  ExpectedAudioSha256: string;
  ObservedAudioSha256: string;
  CurrentAudioSha256: string;
  CurrentSubmittedAudioSha256: string;
  IntegrityStatus: string;
  IntegrityCheckedAt: Date | null;
  IntegrityResolvedAt: Date | null;
  IntegrityResolution: string | null;
}

export interface CommitteeIncident {
  reportKey: string | null;
  reportId: number | null;
  reportNo: string | null;
  counterpartVersion: string | null;
  counterpartConfirmed: boolean;
  recordNo: string;
  userId: number;
  artifactId: number;
  artifactSource: string;
  submissionVersion: string;
  journalVersion: string;
  startedAt: string;
  endedAt: string;
  applicantName: string;
  applicantPhone: string;
  applicantAddress: string;
  applicantDong: string;
  applicantHo: string;
  noiseType: string;
  durationOrCount: string;
  minDb: string;
  maxDb: string;
  latitude: string;
  longitude: string;
  ip: string;
  estimatedPlace: string;
  estimatedDong: string;
  estimatedHo: string;
  otherName: string;
  otherDong: string;
  otherHo: string;
  damage: string;
  submittedAudioSha256: string;
  expectedAudioSha256: string;
  observedAudioSha256: string;
  currentAudioSha256: string;
  currentSubmittedAudioSha256: string;
  integrityStatus: 'PENDING' | 'VERIFIED' | 'MISMATCH_BLOCKED';
  integrityCheckedAt: string | null;
  integrityResolvedAt: string | null;
  integrityResolution: string;
  counterpartUpdatedAt: string | null;
  counterpartUpdatedBy: string;
}

const recordPattern = /^\d{8}_\d{4}$/;
const numberValue = /^-?\d{1,3}(?:\.\d{1,2})?$/;
const parseJson = (value: string | null): JsonObject => {
  try {
    const parsed: unknown = JSON.parse(value ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch { return {}; }
};
const objectValue = (value: unknown): JsonObject => value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const clean = (value: unknown, max = 200): string => field(value).slice(0, max);
const normalized = (value: string): string => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const unitParts = (value: string): { dong: string; ho: string } => ({
  dong: value.match(/([\p{L}\d-]+)\s*동(?=\s|\d|$)/u)?.[1] ?? '',
  ho: value.match(/(\d+)\s*호/u)?.[1] ?? '',
});
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value && !value.startsWith('0000-');
function linkedIncidentDates(query: Request['query'], jsonColumn: 'data.Report' | 'data.Application') {
  const startedFrom = field(query.startedFrom), startedTo = field(query.startedTo);
  if ((startedFrom && !validDate(startedFrom)) || (startedTo && !validDate(startedTo))
      || (startedFrom && startedTo && startedFrom > startedTo)) return null;
  const sql = startedFrom || startedTo ? `AND EXISTS (
    SELECT 1 FROM OPENJSON(CASE WHEN ISJSON(${jsonColumn})=1 THEN ${jsonColumn} END, '$.recordNos') linked
    JOIN dbo.CommitteeSubmissions s ON s.RecordNo=linked.value AND s.KaptCode=m.KaptCode
    JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
    WHERE 1=1
      ${startedFrom ? "AND CONVERT(date,DATEADD(hour,9,r.StartedAt))>=CONVERT(date,@startedFrom,23)" : ''}
      ${startedTo ? "AND CONVERT(date,DATEADD(hour,9,r.StartedAt))<=CONVERT(date,@startedTo,23)" : ''}
  )` : '';
  return { sql, startedFrom, startedTo };
}
const householdFilterKeys = ['applicantName', 'applicantDong', 'applicantHo', 'otherName', 'otherDong', 'otherHo'] as const;

function matchesHouseholdFilters(row: Record<typeof householdFilterKeys[number], string>, filters: Request['query']): boolean {
  return householdFilterKeys.every(key => {
    const query = normalized(field(filters[key]));
    if (!query) return true;
    const actual = normalized(row[key]);
    if (key.endsWith('Dong')) return actual.replace(/동$/, '') === query.replace(/동$/, '');
    if (key.endsWith('Ho')) return actual.replace(/호$/, '') === query.replace(/호$/, '');
    return actual.includes(query);
  });
}
function estimatedUnitFields(place: string): { estimatedDong: string; estimatedHo: string } {
  const { dong, ho } = unitParts(place);
  return { estimatedDong: dong, estimatedHo: ho || (/^[0-9]+$/.test(place) ? place : '') };
}
const durationText = (startedAt: Date, endedAt: Date): string => {
  const seconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
  return `${seconds >= 60 ? `${Math.floor(seconds / 60)}분 ` : ''}${seconds % 60}초`;
};

function mapIncident(row: SubmissionRow): CommitteeIncident {
  const journal = parseJson(row.Journal);
  const details = parseJson(row.Details);
  const applicant = objectValue(details.applicant);
  const analysis = objectValue(details.analysis);
  const submittedOther = objectValue(details.other);
  const hasCounterpartOverride = Boolean(row.CounterpartOverride);
  const override = hasCounterpartOverride ? parseJson(row.CounterpartOverride) : {};
  const editor = parseJson(row.CounterpartEditor);
  const estimatedPlace = clean(hasCounterpartOverride ? override.estimatedPlace : journal.place, 200);
  const otherName = clean(hasCounterpartOverride ? override.name : submittedOther.name, 80);
  const otherHo = normalizeRoomNumber(hasCounterpartOverride ? override.ho : submittedOther.ho).slice(0, 20);
  return {
    reportKey: row.ReportKey,
    reportId: row.ReportId,
    reportNo: row.ReportId && row.ReportCreatedAt ? documentSerial(row.ReportCreatedAt, row.ReportId) : null,
    counterpartVersion: row.CounterpartVersion,
    counterpartConfirmed: hasCounterpartOverride && Boolean(otherName && otherHo),
    recordNo: row.RecordNo,
    userId: row.UserId,
    artifactId: Number(row.ArtifactId),
    artifactSource: row.ArtifactSource,
    submissionVersion: row.SubmissionVersion,
    journalVersion: row.JournalVersion,
    startedAt: row.StartedAt.toISOString(),
    endedAt: row.EndedAt.toISOString(),
    applicantName: clean(applicant.name, 80),
    applicantPhone: clean(applicant.phone, 30),
    applicantAddress: clean(applicant.address, 500),
    applicantDong: clean(applicant.dong, 20),
    applicantHo: clean(applicant.ho, 20),
    noiseType: clean(journal.kind, 100),
    durationOrCount: clean(journal.frequency, 80) || clean(details.frequency, 80) || durationText(row.StartedAt, row.EndedAt),
    minDb: clean(analysis.minDb, 20),
    maxDb: clean(analysis.maxDb, 20),
    latitude: clean(analysis.latitude, 30),
    longitude: clean(analysis.longitude, 30),
    ip: clean(analysis.ip, 64),
    estimatedPlace,
    ...estimatedUnitFields(estimatedPlace),
    otherName,
    otherDong: clean(hasCounterpartOverride ? override.dong : submittedOther.dong, 20),
    otherHo,
    damage: clean(journal.impact, 1_000),
    submittedAudioSha256: row.SubmittedAudioSha256.trim().toUpperCase(),
    expectedAudioSha256: row.ExpectedAudioSha256.trim().toUpperCase(),
    observedAudioSha256: row.ObservedAudioSha256.trim().toUpperCase(),
    currentAudioSha256: row.CurrentAudioSha256.trim().toUpperCase(),
    currentSubmittedAudioSha256: row.CurrentSubmittedAudioSha256.trim().toUpperCase(),
    integrityStatus: row.IntegrityStatus as CommitteeIncident['integrityStatus'],
    integrityCheckedAt: row.IntegrityCheckedAt?.toISOString() ?? null,
    integrityResolvedAt: row.IntegrityResolvedAt?.toISOString() ?? null,
    integrityResolution: clean(row.IntegrityResolution, 1_000),
    counterpartUpdatedAt: row.CounterpartUpdatedAt?.toISOString() ?? null,
    counterpartUpdatedBy: clean(editor.name, 80),
  };
}

function matchesApplicationHousehold(data: JsonObject, filters: Request['query']): boolean {
  const suffix = (value: unknown) => field(value).match(/(?:[\p{L}0-9-]+\s*동\s*)?[0-9]+\s*호$/u)?.[0]
    ?? field(value).match(/(?:^|\s)([0-9][\p{L}0-9-]*\s*동)$/u)?.[1] ?? '';
  const applicant = unitParts(suffix(data.applicantAddress));
  const counterpart = unitParts(suffix(data.counterpartAddress));
  return matchesHouseholdFilters({
    applicantName: field(data.applicantName), applicantDong: applicant.dong, applicantHo: applicant.ho,
    otherName: field(data.counterpartName), otherDong: counterpart.dong, otherHo: counterpart.ho,
  }, filters);
}

let reportSchemaReady = false;
const documentDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
function documentSerial(createdAt: Date, id: number): string {
  return `${documentDate.format(createdAt).replaceAll('-', '')}_${String(id).padStart(4, '0')}`;
}

const ensureVisibleDocumentIncidents = `
  DECLARE @incidentLock int, @incidentResource nvarchar(255)=CONCAT(N'CommitteeReport:',@kaptCode);
  EXEC @incidentLock=sys.sp_getapplock @Resource=@incidentResource,@LockMode='Exclusive',@LockTimeout=5000;
  IF @incidentLock<0 OR EXISTS (
    SELECT 1 FROM OPENJSON(@payload,'$.recordNos') WITH (RecordNo varchar(13) '$') linked
    WHERE NOT EXISTS (
      SELECT 1 FROM dbo.CommitteeSubmissions s WITH (UPDLOCK,HOLDLOCK)
      WHERE s.KaptCode=@kaptCode AND s.RecordNo=linked.RecordNo
        AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL
    )
  )
  BEGIN
    ROLLBACK TRANSACTION;
    RETURN;
  END;
`;

async function hasReportSchema(): Promise<boolean> {
  if (!reportSchemaReady) {
    const [state] = await querySql<{ Ready: number }>(`
      SELECT CASE WHEN HAS_PERMS_BY_NAME(N'dbo.CommitteeReportIncidents',N'OBJECT',N'SELECT')=1
        AND HAS_PERMS_BY_NAME(N'dbo.CommitteeReportIncidents',N'OBJECT',N'INSERT')=1 THEN 1 ELSE 0 END AS Ready
    `);
    reportSchemaReady = state?.Ready === 1;
  }
  return reportSchemaReady;
}

function reportPairKey(kaptCode: string, row: CommitteeIncident): string {
  const parts = [kaptCode, row.userId, normalized(row.applicantDong).replace(/동$/, ''),
    normalized(row.applicantHo).replace(/호$/, ''), normalized(row.otherDong).replace(/동$/, ''), row.otherHo];
  return crypto.createHmac('sha256', memberDataKey).update(JSON.stringify(parts)).digest('hex');
}

async function readIncidents(kaptCode: string, recordNos?: string[], reportKey?: string): Promise<CommitteeIncident[]> {
  const parameters: Record<string, unknown> = { kaptCode, key: memberDataKey };
  let restriction = '';
  const reportReady = await hasReportSchema();
  if (reportKey) {
    if (!reportReady) return [];
    parameters.reportKey = reportKey;
    restriction = ' AND report.PairKey=@reportKey';
  }
  if (recordNos) {
    restriction += ` AND s.RecordNo IN (${recordNos.map((recordNo, index) => {
      parameters[`record${index}`] = recordNo;
      return `@record${index}`;
    }).join(',')})`;
  }
  const rows = await querySql<SubmissionRow>(`
    SELECT s.RecordNo,s.UserId,a.ArtifactId,a.ArtifactSource,
      ${reportReady ? 'report.PairKey' : 'CAST(NULL AS char(64))'} AS ReportKey,
      ${reportReady ? 'document.ReportId' : 'NULL'} AS ReportId,
      ${reportReady ? 'document.CreatedAt' : 'NULL'} AS ReportCreatedAt,
      CONVERT(char(64),HASHBYTES('SHA2_256',o.DataCipher),2) AS CounterpartVersion,
      CONVERT(varchar(18),CONVERT(binary(8),s.SubmissionVersion),1) AS SubmissionVersion,
      CONVERT(char(64),HASHBYTES('SHA2_256',j.JournalCipher),2) AS JournalVersion,r.StartedAt,r.EndedAt,
      dbo.DecryptMemberData(j.JournalCipher,@key) AS Journal,
      dbo.DecryptMemberData(s.DetailsCipher,@key) AS Details,
      dbo.DecryptMemberData(o.DataCipher,@key) AS CounterpartOverride,o.UpdatedAt AS CounterpartUpdatedAt,
      dbo.DecryptMemberData(editor.MemberCipher,@key) AS CounterpartEditor,
      s.SubmittedAudioSha256,s.ExpectedAudioSha256,s.ObservedAudioSha256,
      COALESCE(lastCheck.OriginalObservedAudioSha256,s.ExpectedAudioSha256) AS CurrentAudioSha256,
      a.AudioSha256 AS CurrentSubmittedAudioSha256,
      s.IntegrityStatus,s.IntegrityCheckedAt,
      s.IntegrityResolvedAt,dbo.DecryptMemberData(s.IntegrityResolutionCipher,@key) AS IntegrityResolution
    FROM dbo.CommitteeSubmissions s
    JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
    JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
      AND a.RecordNo=s.RecordNo AND a.UserId=s.UserId
    JOIN dbo.NoiseIncidentJournals j ON j.RecordNo=s.RecordNo AND j.UserId=s.UserId
    OUTER APPLY(SELECT TOP (1) e.OriginalObservedAudioSha256
      FROM dbo.CommitteeIntegrityEvents e WHERE e.RecordNo=s.RecordNo
      ORDER BY e.EventId DESC) lastCheck
    LEFT JOIN dbo.CommitteeCounterpartOverrides o ON o.RecordNo=s.RecordNo AND o.KaptCode=s.KaptCode
    ${reportReady ? 'LEFT JOIN dbo.CommitteeReportIncidents report ON report.RecordNo=s.RecordNo AND report.KaptCode=s.KaptCode' : ''}
    ${reportReady ? 'LEFT JOIN dbo.CommitteeNoiseReports document ON document.KaptCode=report.KaptCode AND document.PairKey=report.PairKey' : ''}
    LEFT JOIN dbo.CommitteeMembers editor ON editor.MemberId=o.UpdatedBy
    WHERE s.KaptCode=@kaptCode AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL${restriction}
    ORDER BY r.StartedAt,r.RecordNo
  `, parameters);
  return rows.map(mapIncident);
}

interface IntegrityResult {
  recordNo: string;
  status: CommitteeIncident['integrityStatus'];
  submittedAudioSha256: string;
  expectedAudioSha256: string;
  observedAudioSha256: string;
  currentAudioSha256: string;
  checkedAt: string;
  notificationCreated: boolean;
  emailSent: boolean;
}

interface IntegrityUpdateRow {
  RecordNo: string;
  Status: CommitteeIncident['integrityStatus'];
  SubmittedAudioSha256: string;
  ExpectedAudioSha256: string;
  ObservedAudioSha256: string;
  OriginalObservedAudioSha256: string;
  CheckedAt: Date;
  EventId: number | null;
  NotificationId: number | null;
  NotificationCreated: boolean;
  EmailAlreadySent: boolean;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500);

async function verifyIntegrity(
  kaptCode: string,
  recordNo: string,
  checkedBy: number | null,
  _emailFrom: string,
): Promise<IntegrityResult> {
  const message = `발생일지 ${recordNo}에 제출된 음원 파일이 최초 등록 원본과 일치하지 않습니다. 동일한 원본 음원을 다시 업로드해 검증되기 전까지 위원회 출력과 다음 처리가 중단됩니다.`;
  const [result] = await querySql<IntegrityUpdateRow>(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @previous varchar(24),@previousSubmitted char(64),@previousExpected char(64),@previousObserved char(64),
      @userId int,@submitted char(64),@expected char(64),@observed char(64),
       @originalObserved char(64),@source varchar(20),@status varchar(24),@eventId bigint,@artifactId bigint,
       @notificationId bigint=NULL,@notificationCreated bit=0,@checkedAt datetime2(0)=SYSUTCDATETIME();
    SELECT @previous=s.IntegrityStatus,@previousSubmitted=s.SubmittedAudioSha256,
      @previousExpected=s.ExpectedAudioSha256,@previousObserved=s.ObservedAudioSha256,@userId=s.UserId,
       @source=a.ArtifactSource,@artifactId=a.ArtifactId,@submitted=a.AudioSha256,@expected=r.AudioSha256,
      @observed=CONVERT(char(64),HASHBYTES('SHA2_256',a.AudioData),2),
      @originalObserved=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2)
    FROM dbo.CommitteeSubmissions s WITH(UPDLOCK,HOLDLOCK)
    JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
    JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
      AND a.RecordNo=s.RecordNo AND a.UserId=s.UserId
    WHERE s.KaptCode=@kaptCode AND s.RecordNo=@recordNo AND s.WithdrawnAt IS NULL
      AND (@checkedBy=0 OR s.CommitteeHiddenAt IS NULL);
    IF @userId IS NULL THROW 51050,'Committee submission not found.',1;
    SET @status=CASE WHEN @source='UPLOAD' AND @submitted=@observed AND @submitted=@expected
      AND @expected=@originalObserved THEN 'VERIFIED' ELSE 'MISMATCH_BLOCKED' END;
    UPDATE dbo.CommitteeSubmissions SET SubmittedAudioSha256=@submitted,ExpectedAudioSha256=@expected,
      ObservedAudioSha256=@observed,IntegrityStatus=@status,IntegrityCheckedAt=@checkedAt
    WHERE RecordNo=@recordNo;
    IF ISNULL(@previous,'')<>@status OR ISNULL(@previousSubmitted,'')<>@submitted
      OR ISNULL(@previousExpected,'')<>@expected OR ISNULL(@previousObserved,'')<>@observed
      OR NOT EXISTS(SELECT 1 FROM dbo.CommitteeIntegrityEvents WHERE RecordNo=@recordNo)
    BEGIN
      INSERT dbo.CommitteeIntegrityEvents(RecordNo,KaptCode,Status,ExpectedAudioSha256,ObservedAudioSha256,
        OriginalObservedAudioSha256,SubmittedAudioSha256,CheckedBy)
      VALUES(@recordNo,@kaptCode,@status,@expected,@observed,@originalObserved,@submitted,NULLIF(@checkedBy,0));
      SET @eventId=SCOPE_IDENTITY();
    END;
    IF @status='MISMATCH_BLOCKED'
    BEGIN
      SELECT TOP (1) @notificationId=NotificationId
      FROM dbo.ResidentNotifications WITH(UPDLOCK,HOLDLOCK)
      WHERE UserId=@userId AND RelatedRecordNo=@recordNo
        AND NotificationType='AUDIO_INTEGRITY_MISMATCH'
         AND RelatedArtifactId=@artifactId
      ORDER BY CreatedAt DESC,NotificationId DESC;
      IF @notificationId IS NULL
      BEGIN
         INSERT dbo.ResidentNotifications(UserId,NotificationType,Title,MessageCipher,RelatedRecordNo,RelatedArtifactId)
        VALUES(@userId,'AUDIO_INTEGRITY_MISMATCH',N'음원 원본 불일치 확인',
           dbo.EncryptMemberData(@message,@key),@recordNo,@artifactId);
        SET @notificationId=SCOPE_IDENTITY();
        SET @notificationCreated=1;
      END;
      IF @eventId IS NOT NULL UPDATE dbo.CommitteeIntegrityEvents SET NotificationId=@notificationId WHERE EventId=@eventId;
    END;
    SELECT @recordNo AS RecordNo,@status AS Status,@submitted AS SubmittedAudioSha256,
      @expected AS ExpectedAudioSha256,@observed AS ObservedAudioSha256,
      @originalObserved AS OriginalObservedAudioSha256,@checkedAt AS CheckedAt,
      @eventId AS EventId,@notificationId AS NotificationId,@notificationCreated AS NotificationCreated,
       IIF(EXISTS(SELECT 1 FROM dbo.ResidentNotifications WHERE NotificationId=@notificationId AND EmailSentAt IS NOT NULL),1,0) AS EmailAlreadySent
    FROM dbo.AppUsers u WHERE u.UserId=@userId;
    COMMIT TRANSACTION;
  `, { kaptCode, recordNo, checkedBy: checkedBy ?? 0, key: memberDataKey, message });
  if (!result) throw new Error('Integrity check did not return a result.');

  return {
    recordNo: result.RecordNo,
    status: result.Status,
    submittedAudioSha256: result.SubmittedAudioSha256.trim().toUpperCase(),
    expectedAudioSha256: result.ExpectedAudioSha256.trim().toUpperCase(),
    observedAudioSha256: result.ObservedAudioSha256.trim().toUpperCase(),
    currentAudioSha256: result.OriginalObservedAudioSha256.trim().toUpperCase(),
    checkedAt: result.CheckedAt.toISOString(),
    notificationCreated: Boolean(result.NotificationCreated),
    emailSent: Boolean(result.EmailAlreadySent),
  };
}

export async function notifyRecordingIntegrityMismatch(
  userId: number,
  recordNo: string,
  _emailFrom: string,
): Promise<{ notificationCreated: boolean; emailSent: boolean }> {
  const message = `발생일지 ${recordNo}에 사용하려는 음원 파일이 최초 등록 원본과 일치하지 않아 제출이 차단되었습니다. 원본 녹음 파일을 확인해 주세요.`;
  const [notice] = await querySql<{
    NotificationId: number; Created: boolean; EmailAlreadySent: boolean;
  }>(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @notificationId bigint,@created bit=0,@now datetime2(0)=SYSUTCDATETIME();
    SELECT TOP (1) @notificationId=NotificationId FROM dbo.ResidentNotifications WITH(UPDLOCK,HOLDLOCK)
    WHERE UserId=@userId AND RelatedRecordNo=@recordNo AND NotificationType='AUDIO_INTEGRITY_MISMATCH'
      AND RelatedArtifactId IS NULL
      AND CreatedAt>=DATEADD(day,-1,@now)
    ORDER BY CreatedAt DESC;
    IF @notificationId IS NULL
    BEGIN
      INSERT dbo.ResidentNotifications(UserId,NotificationType,Title,MessageCipher,RelatedRecordNo)
      VALUES(@userId,'AUDIO_INTEGRITY_MISMATCH',N'음원 원본 불일치 확인',dbo.EncryptMemberData(@message,@key),@recordNo);
      SET @notificationId=SCOPE_IDENTITY(); SET @created=1;
    END;
    SELECT @notificationId AS NotificationId,@created AS Created,
      IIF(n.EmailSentAt IS NOT NULL,1,0) AS EmailAlreadySent
    FROM dbo.ResidentNotifications n WHERE n.NotificationId=@notificationId;
    COMMIT TRANSACTION;
  `, { userId, recordNo, message, key: memberDataKey });
  if (!notice) throw new Error('Resident integrity notification was not created.');
  return { notificationCreated: Boolean(notice.Created), emailSent: Boolean(notice.EmailAlreadySent) };
}

export async function uploadCommitteeSubmissionAudio(req: ResidentRequest, res: Response): Promise<void> {
  const recordNo = String(req.params.recordNo ?? '');
  const userId = Number(req.user!.sub);
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!recordPattern.test(recordNo) || !Number.isSafeInteger(userId) || userId < 1 || audio.length < 1) {
    res.status(400).json({ error: '제출할 음원 파일을 확인해 주세요.' });
    return;
  }
  const sha256 = crypto.createHash('sha256').update(audio).digest('hex').toUpperCase();
  let artifact: { ArtifactId: number; Reused: boolean } | undefined;
  try {
    [artifact] = await querySql<{ ArtifactId: number; Reused: boolean }>(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    IF NOT EXISTS(SELECT 1 FROM dbo.NoiseRecordings WITH(UPDLOCK,HOLDLOCK)
      WHERE RecordNo=@recordNo AND UserId=@userId)
      THROW 51054,'Resident recording not found.',1;
    DECLARE @artifactId bigint,@reused bit=0;
    SELECT @artifactId=ArtifactId FROM dbo.CommitteeSubmissionArtifacts WITH(UPDLOCK,HOLDLOCK)
    WHERE RecordNo=@recordNo AND UserId=@userId AND ArtifactSource='UPLOAD'
      AND AudioSha256=@sha256 AND AudioLength=@length;
    IF @artifactId IS NOT NULL SET @reused=1;
    ELSE
    BEGIN
      DECLARE @isRecovery bit=0;
      IF EXISTS(SELECT 1 FROM dbo.NoiseRecordings
        WHERE RecordNo=@recordNo AND UserId=@userId AND AudioSha256=@sha256 AND AudioLength=@length)
        SET @isRecovery=1;
      IF @isRecovery=0 AND ((SELECT COUNT_BIG(*) FROM dbo.CommitteeSubmissionArtifacts WITH(UPDLOCK,HOLDLOCK)
          WHERE RecordNo=@recordNo AND UserId=@userId AND ArtifactSource='UPLOAD'
            AND UploadedAt>=DATEADD(hour,-1,SYSUTCDATETIME()))>=5
        OR (SELECT COUNT_BIG(*) FROM dbo.CommitteeSubmissionArtifacts WITH(UPDLOCK,HOLDLOCK)
          WHERE RecordNo=@recordNo AND UserId=@userId AND ArtifactSource='UPLOAD'
            AND UploadedAt>=DATEADD(day,-30,SYSUTCDATETIME()))>=50
        OR COALESCE((SELECT SUM(AudioLength) FROM dbo.CommitteeSubmissionArtifacts WITH(UPDLOCK,HOLDLOCK)
          WHERE RecordNo=@recordNo AND UserId=@userId AND ArtifactSource='UPLOAD'
            AND UploadedAt>=DATEADD(day,-30,SYSUTCDATETIME())),0)+@length>2147483648)
        THROW 51055,'Committee audio upload quota exceeded.',1;
      IF @isRecovery=0 AND (SELECT COUNT_BIG(*) FROM dbo.CommitteeSubmissionArtifacts a WITH(UPDLOCK,HOLDLOCK)
        WHERE a.RecordNo=@recordNo AND a.UserId=@userId AND a.UploadedAt>=DATEADD(hour,-1,SYSUTCDATETIME())
          AND NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifactBindings b WHERE b.ArtifactId=a.ArtifactId))>=5
        THROW 51055,'Too many pending committee audio uploads.',1;
      IF @isRecovery=0 AND COALESCE((SELECT SUM(a.AudioLength) FROM dbo.CommitteeSubmissionArtifacts a WITH(UPDLOCK,HOLDLOCK)
        WHERE a.UserId=@userId AND a.UploadedAt>=DATEADD(hour,-24,SYSUTCDATETIME())
          AND NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifactBindings b WHERE b.ArtifactId=a.ArtifactId)),0)+@length
          > 524288000
        THROW 51057,'Committee audio pending storage quota exceeded.',1;
      INSERT dbo.CommitteeSubmissionArtifacts(RecordNo,UserId,ArtifactSource,AudioSha256,AudioLength,AudioData)
      VALUES(@recordNo,@userId,'UPLOAD',@sha256,@length,@audio);
      SET @artifactId=SCOPE_IDENTITY();
    END;
    SELECT @artifactId AS ArtifactId,@reused AS Reused;
    COMMIT TRANSACTION;
    `, { recordNo, userId, sha256, length: audio.length, audio });
  } catch (error) {
    const sqlError = error as { number?: number };
    if (sqlError.number === 51054) {
      res.status(404).json({ error: '제출할 발생일지 원본을 찾을 수 없습니다.' });
      return;
    }
    if (sqlError.number === 51055 || sqlError.number === 51057) {
      res.status(429).json({ error: '처리 중인 음원 업로드가 많습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    throw error;
  }
  if (!artifact) throw new Error('Committee audio artifact was not stored.');
  res.status(artifact.Reused ? 200 : 201).json({
    artifactId: Number(artifact.ArtifactId), sha256, audioLength: audio.length, reused: Boolean(artifact.Reused),
  });
}

export async function retryPendingNotificationEmail(emailFrom: string): Promise<boolean> {
  const [job] = await querySql<{
    NotificationId: number; Title: string; Message: string; RelatedRecordNo: string | null;
    Email: string; EmailAttempts: number;
  }>(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    DECLARE @notificationId bigint,@now datetime2(0)=SYSUTCDATETIME();
    SELECT TOP (1) @notificationId=NotificationId
    FROM dbo.ResidentNotifications WITH(UPDLOCK,READPAST,ROWLOCK)
    WHERE NotificationType IN('AUDIO_INTEGRITY_MISMATCH','AUDIO_INTEGRITY_ACTION_REQUIRED')
      AND EmailSentAt IS NULL AND EmailAttempts<8
      AND (EmailClaimedAt IS NULL OR EmailClaimedAt<DATEADD(minute,-10,@now))
      AND (EmailNextAttemptAt IS NULL OR EmailNextAttemptAt<=@now)
    ORDER BY CreatedAt,NotificationId;
    IF @notificationId IS NOT NULL
    BEGIN
      UPDATE dbo.ResidentNotifications SET EmailClaimedAt=@now,EmailAttempts=EmailAttempts+1
      WHERE NotificationId=@notificationId;
      SELECT n.NotificationId,n.Title,dbo.DecryptMemberData(n.MessageCipher,@key) AS Message,
        n.RelatedRecordNo,dbo.DecryptMemberData(u.EmailCipher,@key) AS Email,n.EmailAttempts
      FROM dbo.ResidentNotifications n JOIN dbo.AppUsers u ON u.UserId=n.UserId
      WHERE n.NotificationId=@notificationId;
    END;
    COMMIT TRANSACTION;
  `, { key: memberDataKey });
  if (!job) return false;
  try {
    await sendNotificationEmail({
      from: emailFrom,
      to: job.Email,
      subject: `[MuteLab] ${job.Title}`,
      heading: job.Title,
      message: job.Message,
      details: job.RelatedRecordNo ? [`발생일지 번호: ${job.RelatedRecordNo}`] : [],
      messageId: `mutelab-notification-${job.NotificationId}`,
    });
    await querySql(`UPDATE dbo.ResidentNotifications
      SET EmailSentAt=SYSUTCDATETIME(),EmailClaimedAt=NULL,EmailNextAttemptAt=NULL,EmailError=NULL
      WHERE NotificationId=@id;
      UPDATE dbo.CommitteeIntegrityEvents SET EmailSentAt=SYSUTCDATETIME(),EmailError=NULL
      WHERE NotificationId=@id;`, { id: job.NotificationId });
  } catch (error) {
    const delayMinutes = Math.min(360, 2 ** Math.min(Number(job.EmailAttempts), 8));
    await querySql(`UPDATE dbo.ResidentNotifications
      SET EmailClaimedAt=NULL,EmailNextAttemptAt=DATEADD(minute,@delay,SYSUTCDATETIME()),EmailError=@error
      WHERE NotificationId=@id;
      UPDATE dbo.CommitteeIntegrityEvents SET EmailError=@error WHERE NotificationId=@id;`, {
      id: job.NotificationId, delay: delayMinutes, error: errorText(error),
    });
  }
  return true;
}

export async function submitCommitteeIncident(req: ResidentRequest, res: Response, emailFrom: string): Promise<void> {
  const recordNo = String(req.params.recordNo ?? '');
  const artifactId = Number(req.body?.artifactId);
  const input = objectValue(req.body?.details);
  if (!recordPattern.test(recordNo) || !Number.isSafeInteger(artifactId) || artifactId < 1) {
    res.status(400).json({ error: '서버에 업로드한 제출 음원 정보를 확인해 주세요.' });
    return;
  }
  const minDb = clean(input.minDb, 20), maxDb = clean(input.maxDb, 20);
  const latitude = clean(input.latitude, 30), longitude = clean(input.longitude, 30), ip = clean(input.ip, 64);
  const otherName = clean(input.otherName, 80), otherDong = clean(input.otherDong, 20), otherHo = normalizeRoomNumber(input.otherHo).slice(0, 20);
  const frequency = clean(input.frequency, 80);
  const numericOrEmpty = (value: string): boolean => !value || numberValue.test(value);
  const latitudeNumber = Number(latitude), longitudeNumber = Number(longitude);
  if (!numericOrEmpty(minDb) || !numericOrEmpty(maxDb)
      || (latitude && (!Number.isFinite(latitudeNumber) || latitudeNumber < -90 || latitudeNumber > 90))
      || (longitude && (!Number.isFinite(longitudeNumber) || longitudeNumber < -180 || longitudeNumber > 180))
      || (ip && isIP(ip) === 0)) {
    res.status(400).json({ error: '녹음 분석 결과를 확인해 주세요.' });
    return;
  }
  const userId = Number(req.user!.sub);
  const [recording] = await querySql<{
    Profile: string; Journal: string; AudioSha256: string;
    ArtifactSha256: string; ArtifactSource: string;
  }>(`
    SELECT dbo.DecryptMemberData(u.ProfileCipher,@key) AS Profile,
      dbo.DecryptMemberData(j.JournalCipher,@key) AS Journal,r.AudioSha256,
      a.AudioSha256 AS ArtifactSha256,a.ArtifactSource
    FROM dbo.NoiseRecordings r
    JOIN dbo.NoiseIncidentJournals j ON j.RecordNo=r.RecordNo AND j.UserId=r.UserId
    JOIN dbo.AppUsers u ON u.UserId=r.UserId
    JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=@artifactId
      AND a.RecordNo=r.RecordNo AND a.UserId=r.UserId
    WHERE r.RecordNo=@recordNo AND r.UserId=@userId AND a.ArtifactSource='UPLOAD'
  `, { key: memberDataKey, recordNo, userId, artifactId });
  if (!recording) {
    res.status(404).json({ error: '제출할 발생일지를 찾을 수 없습니다.' });
    return;
  }
  const originalHash = recording.AudioSha256.trim().toUpperCase();
  const submittedHash = recording.ArtifactSha256.trim().toUpperCase();
  const profile = parseJson(recording.Profile);
  const journal = parseJson(recording.Journal);
  const kaptCode = clean(profile.profile_kapt_code, 50);
  const name = clean(profile.profile_name, 80);
  const phone = clean(profile.profile_phone, 30).replace(/[\s-]/g, '');
  const address1 = clean(profile.profile_address, 300);
  const address2 = clean(profile.profile_address2, 100);
  if (!/^[A-Z0-9]{1,50}$/.test(kaptCode) || !name || !phone || !address2 || journal.withinNoiseScope !== true) {
    res.status(400).json({ error: '내 정보의 단지·성명·연락처·동호수와 층간소음 판단을 확인해 주세요.' });
    return;
  }
  const unit = unitParts(address2);
  const details = JSON.stringify({
    applicant: { name, phone, address: [address1, address2].filter(Boolean).join(' '), dong: unit.dong, ho: unit.ho },
    analysis: { minDb, maxDb, latitude, longitude, ip },
    other: { name: otherName, dong: otherDong, ho: otherHo },
    frequency,
  });
  await querySql(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    IF NOT EXISTS(SELECT 1 FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode) THROW 51021,'Unknown apartment.',1;
    IF NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifacts WITH(UPDLOCK,HOLDLOCK)
      WHERE ArtifactId=@artifactId AND RecordNo=@recordNo AND UserId=@userId AND ArtifactSource='UPLOAD')
      THROW 51056,'Committee audio artifact not found.',1;
    UPDATE dbo.CommitteeSubmissions WITH(UPDLOCK,HOLDLOCK)
      SET KaptCode=@kaptCode,DetailsCipher=dbo.EncryptMemberData(@details,@key),SubmissionArtifactId=@artifactId,
        SubmittedAudioSha256=@submitted,
        ExpectedAudioSha256=@expected,ObservedAudioSha256=@observed,IntegrityStatus='PENDING',IntegrityCheckedAt=NULL,
        IntegrityResolvedAt=NULL,IntegrityResolvedBy=NULL,IntegrityResolutionCipher=NULL,WithdrawnAt=NULL,
        SubmittedAt=SYSUTCDATETIME()
      WHERE RecordNo=@recordNo AND UserId=@userId;
    IF @@ROWCOUNT=0 INSERT dbo.CommitteeSubmissions(RecordNo,UserId,KaptCode,DetailsCipher,SubmissionArtifactId,
      SubmittedAudioSha256,ExpectedAudioSha256,ObservedAudioSha256,IntegrityStatus)
      VALUES(@recordNo,@userId,@kaptCode,dbo.EncryptMemberData(@details,@key),@artifactId,
        @submitted,@expected,@observed,'PENDING');
    IF NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifactBindings WHERE ArtifactId=@artifactId)
      INSERT dbo.CommitteeSubmissionArtifactBindings(ArtifactId,RecordNo,UserId)
      VALUES(@artifactId,@recordNo,@userId);
    COMMIT TRANSACTION;
  `, { kaptCode, details, key: memberDataKey, recordNo, userId, artifactId,
    submitted: submittedHash, expected: originalHash, observed: submittedHash });
  const integrity = await verifyIntegrity(kaptCode, recordNo, null, emailFrom);
  if (integrity.status === 'MISMATCH_BLOCKED') {
    res.status(409).json({ error: '등록된 녹음 원본과 일치하지 않아 위원회 처리가 차단되었습니다. 알림과 이메일을 확인해 주세요.', integrity });
    return;
  }
  res.json({ recordNo, integrity, message: '위원회 발생일지에 제출했습니다.' });
}

export async function withdrawCommitteeIncident(req: ResidentRequest, res: Response): Promise<void> {
  const recordNo = String(req.params.recordNo ?? '');
  if (!recordPattern.test(recordNo)) {
    res.status(400).json({ error: '발생일지 번호를 확인해 주세요.' });
    return;
  }
  await querySql('UPDATE dbo.CommitteeSubmissions SET WithdrawnAt=SYSUTCDATETIME() WHERE RecordNo=@recordNo AND UserId=@userId', {
    recordNo, userId: Number(req.user!.sub),
  });
  res.json({ recordNo, message: '위원회 제출을 철회했습니다.' });
}

export async function residentCommitteeContacts(req: ResidentRequest, res: Response): Promise<void> {
  const userId = Number(req.user!.sub);
  const rows = await querySql<{ MemberJson: string }>(`
    SELECT dbo.DecryptMemberData(m.MemberCipher,@key) AS MemberJson
    FROM dbo.CommitteeMembers m
    WHERE m.ApprovedAt IS NOT NULL AND EXISTS(
      SELECT 1 FROM dbo.CommitteeSubmissions s WHERE s.UserId=@userId AND s.KaptCode=m.KaptCode
        AND s.WithdrawnAt IS NULL AND s.IntegrityStatus='VERIFIED')
    ORDER BY m.KaptCode,m.Seat
  `, { key: memberDataKey, userId });
  const members = rows.map(row => parseJson(row.MemberJson)).map(member => ({
    name: clean(member.name, 80), mobile: clean(member.mobile, 30), role: clean(member.role, 10),
  }));
  res.json({ members });
}

export async function residentNotifications(req: ResidentRequest, res: Response): Promise<void> {
  const unreadOnly = String(req.query.unreadOnly ?? 'true') !== 'false';
  const rows = await querySql<{
    NotificationId: number; NotificationType: string; Title: string; Message: string;
    RelatedRecordNo: string | null; CreatedAt: Date; ReadAt: Date | null;
  }>(`
    SELECT TOP (50) NotificationId,NotificationType,Title,
      dbo.DecryptMemberData(MessageCipher,@key) AS Message,RelatedRecordNo,CreatedAt,ReadAt
    FROM dbo.ResidentNotifications
    WHERE UserId=@userId AND (@unreadOnly=0 OR ReadAt IS NULL)
    ORDER BY CreatedAt DESC,NotificationId DESC;
  `, { key: memberDataKey, userId: Number(req.user!.sub), unreadOnly: unreadOnly ? 1 : 0 });
  res.json({ notifications: rows.map(row => ({
    notificationId: row.NotificationId,
    type: row.NotificationType,
    title: row.Title,
    message: row.Message,
    recordNo: row.RelatedRecordNo,
    createdAt: row.CreatedAt.toISOString(),
    readAt: row.ReadAt?.toISOString() ?? null,
  })) });
}

export async function readResidentNotification(req: ResidentRequest, res: Response): Promise<void> {
  const notificationId = Number(req.params.notificationId);
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
    res.status(400).json({ error: '알림 번호를 확인해 주세요.' });
    return;
  }
  await querySql(`UPDATE dbo.ResidentNotifications SET ReadAt=COALESCE(ReadAt,SYSUTCDATETIME())
    WHERE NotificationId=@notificationId AND UserId=@userId`, {
    notificationId, userId: Number(req.user!.sub),
  });
  res.json({ notificationId, read: true });
}

async function apartmentSearch(req: Request, res: Response): Promise<void> {
  const name = field(req.query.name);
  if (name.length < 2 || name.length > 100) {
    res.status(400).json({ error: '단지명을 두 글자 이상 입력해 주세요.' });
    return;
  }
  const escaped = name.replace(/[~%_\[]/g, value => `~${value}`);
  const apartments = await querySql(`
    SELECT TOP (30) kaptCode,kaptName,
      COALESCE(NULLIF(roadAddress,N''),NULLIF(address,N''),NULLIF(legalAddress,N''),CONCAT_WS(N' ',sido,sigungu)) AS address
    FROM dbo.AptComplexWithDetail WHERE kaptName LIKE @contains ESCAPE N'~'
    ORDER BY CASE WHEN kaptName=@name THEN 0 WHEN kaptName LIKE @prefix ESCAPE N'~' THEN 1 ELSE 2 END,kaptName,kaptCode
  `, { name, contains: `%${escaped}%`, prefix: `${escaped}%` });
  res.json({ apartments });
}

export function committeeDataRouter(jwtSecret: string, emailFrom: string): express.Router {
  const router = express.Router();
  const activeIntegrityChecks = new Set<string>();
  const integrityWindows = new Map<string, { startedAt: number; count: number }>();
  let activeAudioRequests = 0;
  const activeAudioByMember = new Map<number, number>();
  const audioWindows = new Map<number, { startedAt: number; count: number }>();
  router.get('/apartments', apartmentSearch);
  router.get('/notification-updates', committeeAccess(jwtSecret, 'observe'), committeeUnreadNotificationCount);
  router.use(committeeAccess(jwtSecret));

  const documents = new Set(['visit-consultation', 'measurement-request', 'incident-log', 'consent',
    'mediation-report', 'committee-guide', 'security-staff-log']);
  router.get('/documents/:documentId', (req, res) => {
    const documentId = req.params.documentId;
    if (!documents.has(documentId)) {
      res.status(404).json({ error: '제출서류를 찾을 수 없습니다.' });
      return;
    }
    res.type('application/pdf').set('Cache-Control', 'private, no-store')
      .sendFile(`${documentId}.pdf`, { root: path.resolve(__dirname, '../committee-documents') });
  });

  router.get('/me', async (_req, res) => {
    const [complex] = await querySql<{ kaptName: string; address: string }>(`
      SELECT kaptName,COALESCE(NULLIF(roadAddress,N''),NULLIF(address,N''),NULLIF(legalAddress,N'')) AS address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode: res.locals.kaptCode });
    const members = await querySql<{ MemberId: number; Role: string; Email: string; MemberJson: string }>(`
      SELECT MemberId,Role,dbo.DecryptMemberData(EmailCipher,@key) AS Email,dbo.DecryptMemberData(MemberCipher,@key) AS MemberJson
      FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND ApprovedAt IS NOT NULL ORDER BY Seat
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey });
    const mapped = members.map(member => {
      const details = parseJson(member.MemberJson);
      return { memberId: member.MemberId, name: clean(details.name, 80), mobile: clean(details.mobile, 30), role: member.Role, email: member.Email };
    });
    res.json({ complex, members: mapped, current: mapped.find(member => member.memberId === res.locals.memberId) ?? null,
      representative: mapped.find(member => member.role === '위원장') ?? null });
  });

  router.get('/notifications', committeeDecisionNotifications);
  router.post('/notifications/:notificationId/read', readCommitteeDecisionNotification);

  router.get('/inquiries', async (_req, res) => {
    const rows = await querySql<InquiryRow>(`
      SELECT TOP (100) InquiryId,CreatedAt,RepliedAt,AttachmentType,
        dbo.DecryptMemberData(QuestionCipher,@key) AS Question,dbo.DecryptMemberData(ReplyCipher,@key) AS Reply
      FROM dbo.CommitteeInquiries WHERE KaptCode=@kaptCode ORDER BY InquiryId DESC
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey });
    res.json({ inquiries: rows.map(formatInquiry) });
  });

  router.post('/inquiries', express.json({ limit: '3mb', type: 'application/vnd.mutelab.inquiry+json' }), async (req, res) => {
    const title = field(req.body?.title), content = field(req.body?.content);
    const question = JSON.stringify({ title, content });
    if (!title || title.length > 120 || !content || content.length > 2000 || question.length > 3500) {
      return res.status(400).json({ error: '제목과 내용을 확인해 주세요.' });
    }
    const image = req.body?.image == null ? null : encryptInquiryImage(req.body.image, memberDataKey);
    if (req.body?.image != null && !image) return res.status(400).json({ error: '2MB 이하의 JPEG, PNG, GIF 또는 WebP 이미지를 첨부해 주세요.' });
    const [saved] = await querySql<{ Id: number }>(`
      INSERT dbo.CommitteeInquiries(KaptCode,MemberId,QuestionCipher,AttachmentCipher,AttachmentType)
      VALUES(@kaptCode,@memberId,dbo.EncryptMemberData(@question,@key),CONVERT(varbinary(max),@image),@mime);
      SELECT CONVERT(int,SCOPE_IDENTITY()) AS Id;
    `, { kaptCode: res.locals.kaptCode, memberId: res.locals.memberId, question, key: memberDataKey,
      image: image?.cipher ?? null, mime: image?.mime ?? null });
    res.status(201).json({ id: saved.Id });
  });

  router.get('/inquiries/:id/image', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.sendStatus(404);
    const [row] = await querySql<{ AttachmentCipher: Buffer | null; AttachmentType: string | null }>(`
      SELECT AttachmentCipher,AttachmentType FROM dbo.CommitteeInquiries WHERE InquiryId=@id AND KaptCode=@kaptCode
    `, { id, kaptCode: res.locals.kaptCode });
    if (!row?.AttachmentCipher || !row.AttachmentType) return res.sendStatus(404);
    res.type(row.AttachmentType).send(decryptInquiryImage(row.AttachmentCipher, memberDataKey));
  });

  router.post('/inquiries/:id/read', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) return res.sendStatus(404);
    const [row] = await querySql<{ Updated: number }>(`
      UPDATE dbo.CommitteeInquiries SET ReplyReadAt=COALESCE(ReplyReadAt,SYSUTCDATETIME())
      WHERE InquiryId=@id AND MemberId=@memberId AND KaptCode=@kaptCode AND RepliedAt IS NOT NULL;
      SELECT @@ROWCOUNT AS Updated;
    `, { id, memberId: res.locals.memberId, kaptCode: res.locals.kaptCode });
    if (row?.Updated !== 1) return res.sendStatus(404);
    res.sendStatus(204);
  });

  const mediationFields = {
    mediatorType: 20, mediatorName: 80, mediatorPhone: 30,
    applicantName: 80, applicantUnit: 100, counterpartName: 80, counterpartUnit: 100,
    noiseType: 200, damagePeriod: 200, damage: 800, demands: 600,
    applicantLifestyle: 400, counterpartLifestyle: 400,
  } as const;
  const mediationTypes = new Set(['관리주체', '층간소음 관리위원회', '기타']);

  function checkedMediationReport(value: unknown) {
    const input = objectValue(value);
    const report = Object.fromEntries(Object.keys(mediationFields).map(key => [key, field(input[key])]));
    const mediatorOther = report.mediatorType === '기타' ? field(input.mediatorOther) : '';
    if (Object.entries(mediationFields).some(([key, max]) => !report[key] || report[key].length > max)
        || !mediationTypes.has(report.mediatorType)
        || (report.mediatorType === '기타' && (!mediatorOther || mediatorOther.length > 100))) return null;
    return { ...report, mediatorOther };
  }

  function checkedMediationEntries(value: unknown) {
    if (!Array.isArray(value)) return null;
    const entries = value.map(item => {
      const row = objectValue(item);
      return { id: row.id ?? null, date: field(row.date), content: field(row.content) };
    });
    const ids = entries.flatMap(entry => entry.id === null ? [] : [entry.id]);
    if (ids.length !== new Set(ids).size || entries.some(entry => !validDate(entry.date) || !entry.content
      || entry.content.length > 1600 || (entry.id !== null && (typeof entry.id !== 'number'
        || !Number.isInteger(entry.id) || entry.id < 1 || entry.id > 2147483647)))) return null;
    return entries;
  }

  const mediationEntryInsert = `
    INSERT dbo.CommitteeMediationEntries(MediationReportId,EntryDate,ContentCipher)
    SELECT @id,item.EntryDate,dbo.EncryptMemberData(item.Content,@key)
    FROM OPENJSON(@entries) WITH(EntryId int '$.id',EntryDate date '$.date',Content nvarchar(1600) '$.content') item
    WHERE item.EntryId IS NULL;
  `;
  const mediationEntriesSql = `(SELECT e.EntryId AS id,CONVERT(char(10),e.EntryDate,23) AS date,
    dbo.DecryptMemberData(e.ContentCipher,@key) AS content
    FROM dbo.CommitteeMediationEntries e WHERE e.MediationReportId=m.MediationReportId
    ORDER BY e.EntryDate,e.EntryId FOR JSON PATH)`;
  function readMediationEntries(data: JsonObject, serialized: string): { id: number | null; date: string; content: string }[] {
    const entries = JSON.parse(serialized || '[]');
    return !entries.length && field(data.mediationDetails)
      ? [{ id: null, date: field(data.mediationDate), content: field(data.mediationDetails) }]
      : entries;
  }

  async function mediationSource(kaptCode: string, value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 50
        || value.some(id => typeof id !== 'string' || !recordPattern.test(id))) {
      return { error: '중재상담 보고서에 넣을 발생일지 1~50건을 조회해 주세요.' };
    }
    const recordNos = [...new Set<string>(value)];
    const rows = await readIncidents(kaptCode, recordNos);
    if (rows.length !== recordNos.length) return { error: '철회되었거나 조회할 수 없는 발생일지가 있습니다. 다시 조회해 주세요.' };
    const first = rows[0];
    const sameUnit = (a: string, b: string) => [normalized(a), normalized(b)].join('|');
    const applicantUnit = sameUnit(first.applicantDong, first.applicantHo);
    const counterpartUnits = new Set(rows.filter(row => row.otherDong || row.otherHo)
      .map(row => sameUnit(row.otherDong, row.otherHo)));
    const counterpartNames = new Set(rows.map(row => normalized(row.otherName)).filter(Boolean));
    if (counterpartUnits.size > 1 || (!counterpartUnits.size && counterpartNames.size > 1)
        || rows.some(row => row.userId !== first.userId || sameUnit(row.applicantDong, row.applicantHo) !== applicantUnit)) {
      return { error: '신청세대와 상대세대 한 쌍만 한 보고서에 담을 수 있습니다. 조회 조건을 좁혀 주세요.' };
    }
    return { rows, recordNos };
  }

  router.post('/mediation-reports/prefill', async (req, res) => {
    const source = await mediationSource(res.locals.kaptCode, req.body?.recordNos);
    if (!source.rows) {
      res.status(400).json({ error: source.error });
      return;
    }
    const [first] = source.rows;
    const counterpart = source.rows.find(row => row.counterpartConfirmed)
      ?? source.rows.find(row => row.otherName || row.otherHo);
    const location = (dong: string, ho: string) => [dong && `${dong.replace(/동$/, '')}동`, ho && `${ho.replace(/호$/, '')}호`].filter(Boolean).join(' ');
    const date = (value: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date(value));
    const start = date(first.startedAt);
    const end = date(new Date(Math.max(...source.rows.map(row => Date.parse(row.endedAt)))).toISOString());
    res.json({
      applicantName: first.applicantName, applicantUnit: location(first.applicantDong, first.applicantHo),
      counterpartName: counterpart?.otherName ?? '', counterpartUnit: location(counterpart?.otherDong ?? '', counterpart?.otherHo ?? ''),
      noiseType: [...new Set(source.rows.map(row => row.noiseType).filter(Boolean))].join(', '),
      damagePeriod: start === end ? start : `${start} ~ ${end}`,
      damage: [...new Set(source.rows.map(row => row.damage).filter(Boolean))].join('\n'),
    });
  });

  async function visitApplicationSource(kaptCode: string, recordNos: unknown) {
    const [chair] = await querySql<{ Email: string; MemberJson: string }>(`
      SELECT TOP(1) dbo.DecryptMemberData(EmailCipher,@key) AS Email,dbo.DecryptMemberData(MemberCipher,@key) AS MemberJson
      FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Role=N'위원장' AND ApprovedAt IS NOT NULL
    `, { kaptCode, key: memberDataKey });
    if (!chair) return { code: 'CHAIR_REQUIRED', error: '위원장이 아직 가입을 하지 않았습니다. 위원장에게 회원가입을 요청하세요' };
    const source = await mediationSource(kaptCode, recordNos);
    if (!source.rows) return { code: 'INCIDENTS_UNAVAILABLE', error: source.error };
    const representative = parseJson(chair.MemberJson);
    const [complex] = await querySql<{ name: string; address: string }>(`
      SELECT TOP(1) kaptName AS name,COALESCE(NULLIF(TRIM(roadAddress),N''),NULLIF(TRIM(address),N''),NULLIF(TRIM(legalAddress),N'')) AS address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode });
    const first = source.rows[0];
    const counterpart = source.rows.find(row => row.counterpartConfirmed) ?? source.rows.find(row => row.otherName || row.otherHo);
    const address = (dong: string, ho: string) =>
      [complex?.address, dong && `${dong.replace(/동$/, '')}동`, ho && `${ho.replace(/호$/, '')}호`].filter(Boolean).join(' ');
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
    const start = date.format(new Date(first.startedAt));
    const end = date.format(new Date(Math.max(...source.rows.map(row => Date.parse(row.endedAt)))));
    return { recordNos: source.recordNos, data: {
      complexName: complex?.name ?? '', managerName: '층간소음위원회', representativeName: clean(representative.name, 80),
      representativePosition: '위원장', managerPhone: clean(representative.contact, 30) || clean(representative.mobile, 30),
      managerEmail: clean(chair.Email, 254), applicantName: first.applicantName, applicantPhone: first.applicantPhone,
      applicantAddress: (complex?.address ? address(first.applicantDong, first.applicantHo) : first.applicantAddress).slice(0, 300),
      counterpartName: counterpart?.otherName ?? '',
      counterpartPhone: '',
      counterpartAddress: counterpart?.otherDong || counterpart?.otherHo ? address(counterpart.otherDong, counterpart.otherHo).slice(0, 300) : '',
      noiseType: [...new Set(source.rows.map(row => row.noiseType).filter(Boolean))].join(', ').slice(0, 200),
      damage: [start === end ? start : `${start} ~ ${end}`, ...new Set(source.rows.map(row => row.damage).filter(Boolean))].join('\n').slice(0, 1000),
    } };
  }

  router.post('/visit-applications/prefill', async (req, res) => {
    const source = await visitApplicationSource(res.locals.kaptCode, req.body?.recordNos);
    if (!source.data) {
      res.status(source.code === 'CHAIR_REQUIRED' ? 409 : 400).json({ error: source.error, code: source.code });
      return;
    }
    res.json(source.data);
  });

  router.get('/visit-applications', async (req, res) => {
    const dates = linkedIncidentDates(req.query, 'data.Application');
    if (!dates) {
      res.status(400).json({ error: '발생일자의 시작일과 종료일을 확인해 주세요.' });
      return;
    }
    const rows = await querySql<{ Id: number; CreatedAt: Date; Application: string }>(`
      SELECT m.VisitApplicationId AS Id,m.CreatedAt,data.Application
      FROM dbo.CommitteeVisitApplications m
      CROSS APPLY (VALUES (dbo.DecryptMemberData(m.ApplicationCipher,@key))) data(Application)
      WHERE m.KaptCode=@kaptCode ${dates.sql} ORDER BY m.VisitApplicationId DESC
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey, startedFrom: dates.startedFrom, startedTo: dates.startedTo });
    const applications = rows.map(row => ({
      id: row.Id, serialNo: documentSerial(row.CreatedAt, row.Id), createdAt: row.CreatedAt, data: parseJson(row.Application),
    })).filter(({ data }) => matchesApplicationHousehold(data, req.query));
    res.set('Cache-Control', 'private, no-store').json({ applications });
  });

  router.post('/visit-applications/:id/pdf', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      res.status(404).json({ error: '방문상담 신청서를 찾을 수 없습니다.' });
      return;
    }
    const [row] = await querySql<{ Application: string }>(`
      SELECT dbo.DecryptMemberData(ApplicationCipher,@key) AS Application
      FROM dbo.CommitteeVisitApplications WHERE VisitApplicationId=@id AND KaptCode=@kaptCode
    `, { id, kaptCode: res.locals.kaptCode, key: memberDataKey });
    if (!row) {
      res.status(404).json({ error: '방문상담 신청서를 찾을 수 없습니다.' });
      return;
    }
    const pdf = await createVisitApplicationPdf(id, parseJson(row.Application));
    res.type('application/pdf').set('Cache-Control', 'private, no-store').send(pdf);
  });

  router.post('/visit-applications', async (req, res) => {
    const input = objectValue(req.body?.application);
    const applicationDate = field(input.applicationDate);
    const requestId = field(req.body?.requestId);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId)
        || !validDate(applicationDate)) {
      res.status(400).json({ error: '신청일을 확인해 주세요.' });
      return;
    }
    const source = await visitApplicationSource(res.locals.kaptCode, req.body?.recordNos);
    if (!source.data) {
      res.status(409).json({ error: source.error, code: source.code });
      return;
    }
    const payload = JSON.stringify({ ...source.data, applicationDate, recordNos: source.recordNos });
    if (payload.length > 3500) {
      res.status(400).json({ error: '신청서 내용이 너무 깁니다. 피해내용을 줄여 주세요.' });
      return;
    }
    const [saved] = await querySql<{ Id: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      ${ensureVisibleDocumentIncidents}
      DECLARE @id int=(SELECT VisitApplicationId FROM dbo.CommitteeVisitApplications WITH(UPDLOCK,HOLDLOCK)
        WHERE KaptCode=@kaptCode AND CreatedBy=@memberId AND RequestId=@requestId);
      IF @id IS NULL
      BEGIN
        INSERT dbo.CommitteeVisitApplications(KaptCode,CreatedBy,RequestId,ApplicationCipher)
          VALUES(@kaptCode,@memberId,@requestId,dbo.EncryptMemberData(@payload,@key));
        SET @id=CONVERT(int,SCOPE_IDENTITY());
      END;
      COMMIT TRANSACTION;
      SELECT @id AS Id;
    `, { kaptCode: res.locals.kaptCode, memberId: res.locals.memberId, requestId, payload, key: memberDataKey });
    if (!saved) return res.status(409).json({ error: '선택한 발생일지가 변경되었습니다. 다시 조회해 주세요.' });
    res.status(201).json({ id: saved.Id });
  });

  const measurementFields = {
    visitDate: 10, postVisitNoise: 1000, applicationDate: 10,
  } as const;

  async function measurementApplicant(kaptCode: string, incident: CommitteeIncident) {
    const [identity] = await querySql<{ Name: string | null; Email: string | null }>(`
      SELECT TOP(1) apt.kaptName AS Name, dbo.DecryptMemberData(u.EmailCipher,@key) AS Email
      FROM dbo.AppUsers u
      LEFT JOIN dbo.AptComplexWithDetail apt ON apt.kaptCode=@kaptCode
      WHERE u.UserId=@userId
    `, { kaptCode, userId: incident.userId, key: memberDataKey });
    return {
      applicantName: incident.applicantName, applicantPhone: incident.applicantPhone,
      applicantEmail: identity?.Email ?? '', complexName: identity?.Name ?? '',
      applicantAddress: incident.applicantAddress,
    };
  }

  function measurementCounterpart(rows: CommitteeIncident[]) {
    const counterpart = rows.find(row => row.counterpartConfirmed) ?? rows.find(row => row.otherName || row.otherHo || row.otherDong);
    const dong = counterpart?.otherDong, ho = counterpart?.otherHo;
    return {
      counterpartName: counterpart?.otherName ?? '',
      counterpartAddress: [dong && `${dong.replace(/동$/, '')}동`, ho && `${ho.replace(/호$/, '')}호`].filter(Boolean).join(' '),
    };
  }

  function measurementNoise(rows: CommitteeIncident[]) {
    const dateTime = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
    return {
      noiseType: [...new Set(rows.map(row => row.noiseType).filter(Boolean))].join(', ').slice(0, 250),
      noiseTime: [...new Set(rows.map(row => `${dateTime.format(new Date(row.startedAt))} ~ ${dateTime.format(new Date(row.endedAt))}`))]
        .join('\n').slice(0, 400),
    };
  }

  router.post('/measurement-applications/prefill', async (req, res) => {
    const kaptCode: string = res.locals.kaptCode;
    const source = await mediationSource(kaptCode, req.body?.recordNos);
    if (!source.rows) {
      res.status(400).json({ error: source.error });
      return;
    }
    res.json({
      ...await measurementApplicant(kaptCode, source.rows[0]),
      ...measurementNoise(source.rows),
      ...measurementCounterpart(source.rows),
    });
  });

  router.get('/measurement-applications', async (req, res) => {
    const dates = linkedIncidentDates(req.query, 'data.Application');
    if (!dates) {
      res.status(400).json({ error: '발생일자의 시작일과 종료일을 확인해 주세요.' });
      return;
    }
    const rows = await querySql<{ Id: number; CreatedAt: Date; Application: string }>(`
      SELECT m.MeasurementApplicationId AS Id,m.CreatedAt,data.Application
      FROM dbo.CommitteeMeasurementApplications m
      CROSS APPLY (VALUES (dbo.DecryptMemberData(m.ApplicationCipher,@key))) data(Application)
      WHERE m.KaptCode=@kaptCode ${dates.sql} ORDER BY m.MeasurementApplicationId DESC
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey, startedFrom: dates.startedFrom, startedTo: dates.startedTo });
    const applications = rows.map(row => ({ id: row.Id, serialNo: documentSerial(row.CreatedAt, row.Id),
      createdAt: row.CreatedAt, data: parseJson(row.Application) }))
      .filter(({ data }) => matchesApplicationHousehold(data, req.query));
    res.set('Cache-Control', 'private, no-store').json({ applications });
  });

  router.post('/measurement-applications', async (req, res) => {
    const input = objectValue(req.body?.application);
    const application = Object.fromEntries(Object.keys(measurementFields).map(key => [key, field(input[key])]));
    const requestId = field(req.body?.requestId);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId)
        || Object.entries(measurementFields).some(([key, max]) => !application[key] || application[key].length > max)
        || !validDate(application.applicationDate) || !validDate(application.visitDate) || application.visitDate > application.applicationDate) {
      res.status(400).json({ error: '필수 항목을 확인해 주세요. 신청일은 방문상담일과 같거나 이후여야 합니다.' });
      return;
    }
    const source = await mediationSource(res.locals.kaptCode, req.body?.recordNos);
    if (!source.rows) {
      res.status(409).json({ error: source.error });
      return;
    }
    const applicant = await measurementApplicant(res.locals.kaptCode, source.rows[0]);
    if (Object.values(applicant).some(value => !value.trim()) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicant.applicantEmail)) {
      res.status(409).json({ error: '발생일지의 신청인 정보와 신청세대의 가입 이메일을 확인해 주세요.' });
      return;
    }
    const noise = measurementNoise(source.rows);
    if (!noise.noiseType || !noise.noiseTime) {
      res.status(409).json({ error: '선택된 발생일지의 소음유형과 발생일시를 확인해 주세요.' });
      return;
    }
    const payload = JSON.stringify({ ...application, ...applicant, ...noise,
      ...measurementCounterpart(source.rows), recordNos: source.recordNos });
    if (payload.length > 3500) {
      res.status(400).json({ error: '신청서 내용이 너무 깁니다. 서술 항목을 줄여 주세요.' });
      return;
    }
    const [saved] = await querySql<{ Id: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      ${ensureVisibleDocumentIncidents}
      DECLARE @id int=(SELECT MeasurementApplicationId FROM dbo.CommitteeMeasurementApplications WITH(UPDLOCK,HOLDLOCK)
        WHERE KaptCode=@kaptCode AND CreatedBy=@memberId AND RequestId=@requestId);
      IF @id IS NULL
      BEGIN
        INSERT dbo.CommitteeMeasurementApplications(KaptCode,CreatedBy,RequestId,ApplicationCipher)
          VALUES(@kaptCode,@memberId,@requestId,dbo.EncryptMemberData(@payload,@key));
        SET @id=CONVERT(int,SCOPE_IDENTITY());
      END;
      COMMIT TRANSACTION;
      SELECT @id AS Id;
    `, { kaptCode: res.locals.kaptCode, memberId: res.locals.memberId, requestId, payload, key: memberDataKey });
    if (!saved) return res.status(409).json({ error: '선택한 발생일지가 변경되었습니다. 다시 조회해 주세요.' });
    res.status(201).json({ id: saved.Id });
  });

  router.get('/mediation-reports', async (req, res) => {
    const dates = linkedIncidentDates(req.query, 'data.Report');
    if (!dates) {
      res.status(400).json({ error: '발생일자의 시작일과 종료일을 확인해 주세요.' });
      return;
    }
    const rows = await querySql<{ MediationReportId: number; ReportNo: string; CreatedAt: Date; Report: string; Version: string; Entries: string }>(`
      SELECT m.MediationReportId,m.ReportNo,m.CreatedAt,data.Report,
        CONVERT(char(64),HASHBYTES('SHA2_256',m.ReportCipher),2) AS Version,
        ${mediationEntriesSql} AS Entries
      FROM dbo.CommitteeMediationReports m
      CROSS APPLY (VALUES (dbo.DecryptMemberData(m.ReportCipher,@key))) data(Report)
      WHERE m.KaptCode=@kaptCode ${dates.sql} ORDER BY m.MediationReportId DESC
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey, startedFrom: dates.startedFrom, startedTo: dates.startedTo });
    const reports = rows.map(row => {
      const data = parseJson(row.Report);
      const entries = readMediationEntries(data, row.Entries);
      return { id: row.MediationReportId, reportNo: row.ReportNo, createdAt: row.CreatedAt, version: row.Version, data, entries };
    })
      .filter(({ data }) => {
        const applicantUnit = estimatedUnitFields(field(data.applicantUnit));
        const counterpartUnit = estimatedUnitFields(field(data.counterpartUnit));
        return matchesHouseholdFilters({
          applicantName: field(data.applicantName), applicantDong: applicantUnit.estimatedDong, applicantHo: applicantUnit.estimatedHo,
          otherName: field(data.counterpartName), otherDong: counterpartUnit.estimatedDong, otherHo: counterpartUnit.estimatedHo,
        }, req.query);
      });
    res.json({ reports });
  });

  router.post('/mediation-reports/:id/pdf', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647) {
      res.status(404).json({ error: '중재상담 보고서를 찾을 수 없습니다.' });
      return;
    }
    const [row] = await querySql<{ ReportNo: string; Report: string; Entries: string }>(`
      SELECT m.ReportNo,dbo.DecryptMemberData(m.ReportCipher,@key) AS Report,${mediationEntriesSql} AS Entries
      FROM dbo.CommitteeMediationReports m WHERE m.MediationReportId=@id AND m.KaptCode=@kaptCode
    `, { id, kaptCode: res.locals.kaptCode, key: memberDataKey });
    if (!row) {
      res.status(404).json({ error: '중재상담 보고서를 찾을 수 없습니다.' });
      return;
    }
    const data = parseJson(row.Report);
    const pdf = await createMediationPdf(row.ReportNo, data, readMediationEntries(data, row.Entries));
    res.type('application/pdf').set('Cache-Control', 'private, no-store').send(pdf);
  });

  router.post('/mediation-reports', async (req, res) => {
    const requestId = field(req.body?.requestId);
    const report = checkedMediationReport(req.body?.report);
    const entries = checkedMediationEntries(req.body?.entries);
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(requestId)
        || !report || !entries?.length || entries.some(entry => entry.id !== null)) {
      res.status(400).json({ error: '모든 필수 항목과 중재내용의 기록일 및 내용을 확인해 주세요.' });
      return;
    }
    const source = await mediationSource(res.locals.kaptCode, req.body?.recordNos);
    if (!source.rows) {
      res.status(409).json({ error: source.error });
      return;
    }
    const payload = JSON.stringify({ ...report, recordNos: source.recordNos });
    if (payload.length > 3500) {
      res.status(400).json({ error: '보고서 내용이 너무 깁니다. 서술 항목의 분량을 줄여 주세요.' });
      return;
    }
    const [saved] = await querySql<{ Id: number; ReportNo: string }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      ${ensureVisibleDocumentIncidents}
      DECLARE @createdAt datetime2(0)=SYSUTCDATETIME();
      DECLARE @datePrefix char(8)=CONVERT(char(8),DATEADD(hour,9,@createdAt),112);
      DECLARE @resource nvarchar(255)=CONCAT(N'CommitteeMediationReportNo:',@datePrefix), @lockResult int;
      EXEC @lockResult=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockTimeout=5000;
      IF @lockResult<0 THROW 51065,'Mediation report numbering is busy.',1;

      DECLARE @id int, @reportNo varchar(13);
      SELECT @id=MediationReportId,@reportNo=ReportNo FROM dbo.CommitteeMediationReports WITH(UPDLOCK,HOLDLOCK)
      WHERE KaptCode=@kaptCode AND CreatedBy=@memberId AND RequestId=@requestId;
      IF @id IS NULL
      BEGIN
        DECLARE @dailyNumber int=(SELECT COALESCE(MAX(CONVERT(int,RIGHT(ReportNo,4))),0)+1
          FROM dbo.CommitteeMediationReports WHERE ReportNo LIKE @datePrefix+'[_]%');
        IF @dailyNumber>9999 THROW 51064,'Daily mediation report number limit exceeded.',1;
        SET @reportNo=@datePrefix+'_'+RIGHT('0000'+CONVERT(varchar(4),@dailyNumber),4);
        INSERT dbo.CommitteeMediationReports(KaptCode,CreatedBy,RequestId,ReportCipher,CreatedAt,ReportNo)
          VALUES(@kaptCode,@memberId,@requestId,dbo.EncryptMemberData(@payload,@key),@createdAt,@reportNo);
        SET @id=CONVERT(int,SCOPE_IDENTITY());
        ${mediationEntryInsert}
      END;
      COMMIT TRANSACTION;
      SELECT @id AS Id,@reportNo AS ReportNo;
    `, { kaptCode: res.locals.kaptCode, memberId: res.locals.memberId, requestId, payload,
      entries: JSON.stringify(entries), key: memberDataKey });
    if (!saved) return res.status(409).json({ error: '선택한 발생일지가 변경되었습니다. 다시 조회해 주세요.' });
    res.status(201).json({ id: saved.Id, reportNo: saved.ReportNo });
  });

  router.put('/mediation-reports/:id', async (req, res) => {
    const id = Number(req.params.id);
    const version = field(req.body?.version);
    const entries = checkedMediationEntries(req.body?.entries);
    if (!Number.isInteger(id) || id < 1 || id > 2147483647 || !/^[\dA-F]{64}$/.test(version)
        || !entries) {
      res.status(400).json({ error: '중재내용의 날짜와 내용을 확인해 주세요.' });
      return;
    }
    try {
      const [saved] = await querySql<{ ReportNo: string }>(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @old nvarchar(max), @reportNo varchar(13);
        SELECT @old=dbo.DecryptMemberData(ReportCipher,@key),@reportNo=ReportNo
        FROM dbo.CommitteeMediationReports WITH(UPDLOCK,HOLDLOCK) WHERE MediationReportId=@id AND KaptCode=@kaptCode
          AND CONVERT(char(64),HASHBYTES('SHA2_256',ReportCipher),2)=@version;
        IF @reportNo IS NULL THROW 51066,'Mediation report changed.',1;
        UPDATE dbo.CommitteeMediationReports SET ReportCipher=dbo.EncryptMemberData(@old,@key)
        WHERE MediationReportId=@id AND KaptCode=@kaptCode;
        UPDATE e SET EntryDate=item.EntryDate,ContentCipher=dbo.EncryptMemberData(item.Content,@key)
        FROM dbo.CommitteeMediationEntries e
        JOIN OPENJSON(@entries) WITH(EntryId int '$.id',EntryDate date '$.date',Content nvarchar(1600) '$.content') item
          ON item.EntryId=e.EntryId WHERE e.MediationReportId=@id;
        IF @@ROWCOUNT<>@editCount THROW 51066,'Mediation entries changed.',1;
        ${mediationEntryInsert}
        IF NOT EXISTS(SELECT 1 FROM dbo.CommitteeMediationEntries WHERE MediationReportId=@id)
          THROW 51068,'Mediation entry required.',1;
        COMMIT TRANSACTION;
        SELECT @reportNo AS ReportNo;
      `, { id, version, kaptCode: res.locals.kaptCode, key: memberDataKey,
        entries: JSON.stringify(entries), editCount: entries.filter(entry => entry.id !== null).length });
      res.json({ reportNo: saved.ReportNo });
    } catch (error) {
      const number = (error as { number?: number }).number;
      if (number === 51066) res.status(409).json({ error: '보고서가 변경되었거나 조회할 수 없습니다. 목록을 다시 조회해 주세요.' });
      else if (number === 51068) res.status(400).json({ error: '날짜가 있는 중재내용을 한 건 이상 입력해 주세요.' });
      else throw error;
    }
  });

  const linkedCommitteeDocuments = `
    SELECT linked.RecordNo FROM (
      SELECT ReportCipher AS Cipher FROM dbo.CommitteeMediationReports WHERE KaptCode=@kaptCode
      UNION ALL
      SELECT ApplicationCipher FROM dbo.CommitteeVisitApplications WHERE KaptCode=@kaptCode
      UNION ALL
      SELECT ApplicationCipher FROM dbo.CommitteeMeasurementApplications WHERE KaptCode=@kaptCode
    ) documents
    CROSS APPLY (VALUES (dbo.DecryptMemberData(documents.Cipher,@key))) data(Document)
    CROSS APPLY OPENJSON(CASE WHEN ISJSON(data.Document)=1 THEN data.Document END,'$.recordNos')
      WITH (RecordNo varchar(13) '$') linked
  `;

  router.get('/incidents', async (req, res) => {
    const kaptCode = res.locals.kaptCode;
    const rows = (await readIncidents(kaptCode)).filter(row => matchesHouseholdFilters(row, req.query)).reverse();
    const linked = rows.length
      ? await querySql<{ RecordNo: string }>(`SELECT DISTINCT RecordNo FROM (${linkedCommitteeDocuments}) links`, { kaptCode, key: memberDataKey })
      : [];
    const linkedRecords = new Set(linked.map(row => row.RecordNo));
    res.json({ reportAvailable: await hasReportSchema(), incidents: rows.map(row => ({
      recordNo: row.recordNo, userId: row.userId, startedAt: row.startedAt,
      applicantName: row.applicantName, applicantPhone: row.applicantPhone,
      applicantDong: row.applicantDong, applicantHo: row.applicantHo,
      noiseType: row.noiseType, durationOrCount: row.durationOrCount,
      otherName: row.otherName, otherDong: row.otherDong, otherHo: row.otherHo,
      estimatedDong: row.estimatedDong, estimatedHo: row.estimatedHo,
      residentSelected: true, reportKey: row.reportKey, reportId: row.reportId, reportNo: row.reportNo,
      canHide: !row.reportKey && !linkedRecords.has(row.recordNo),
      counterpartConfirmed: row.counterpartConfirmed,
      integrityStatus: row.integrityStatus, integrityCheckedAt: row.integrityCheckedAt,
    })) });
  });

  router.post('/reports', async (req, res) => {
    if (!await hasReportSchema()) {
      res.status(503).json({ error: '층간소음보고서 저장소가 준비되지 않았습니다.' });
      return;
    }
    const recordNos: unknown = req.body?.recordNos;
    if (!Array.isArray(recordNos) || !recordNos.length || recordNos.length > 500
        || recordNos.some(value => typeof value !== 'string' || !recordPattern.test(value))) {
      res.status(400).json({ error: '한 번에 발생일지 1~500건을 보고할 수 있습니다.' });
      return;
    }
    const unique = [...new Set<string>(recordNos)];
    const kaptCode: string = res.locals.kaptCode;
    const rows = await readIncidents(kaptCode, unique);
    const pending = rows.filter(row => !row.reportKey);
    const confirmed = pending.filter(row => row.counterpartConfirmed);
    const skipped = {
      unconfirmed: pending.length - confirmed.length,
      alreadyReported: rows.length - pending.length,
      unavailable: unique.length - rows.length,
    };
    if (!confirmed.length) {
      res.status(409).json({ error: '층간소음보고서로 이관할 수 있는 발생일지가 없습니다.', skippedReasons: skipped });
      return;
    }
    const params: Record<string, unknown> = { kaptCode, memberId: Number(res.locals.memberId) };
    const pairKeys = new Set<string>();
    const values = confirmed.map((row, index) => {
      const pairKey = reportPairKey(kaptCode, row);
      pairKeys.add(pairKey);
      Object.assign(params, { [`r${index}`]: row.recordNo, [`s${index}`]: row.submissionVersion,
        [`o${index}`]: row.counterpartVersion, [`p${index}`]: pairKey });
      return `(@r${index},@s${index},@o${index},@p${index})`;
    }).join(',');
    try {
      await querySql(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @lockResult int, @resource nvarchar(255)=CONCAT(N'CommitteeReport:',@kaptCode);
        EXEC @lockResult=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockTimeout=5000;
        IF @lockResult<0 THROW 51061,'Report is busy.',1;
        INSERT dbo.CommitteeReportIncidents(RecordNo,KaptCode,PairKey,AddedBy)
        SELECT s.RecordNo,s.KaptCode,selected.PairKey,@memberId
        FROM (VALUES ${values}) selected(RecordNo,SubmissionVersion,CounterpartVersion,PairKey)
        JOIN dbo.CommitteeSubmissions s WITH(UPDLOCK,HOLDLOCK) ON s.RecordNo=selected.RecordNo
        JOIN dbo.CommitteeCounterpartOverrides o WITH(UPDLOCK,HOLDLOCK) ON o.RecordNo=s.RecordNo AND o.KaptCode=s.KaptCode
        WHERE s.KaptCode=@kaptCode AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL
          AND s.SubmissionVersion=CONVERT(binary(8),selected.SubmissionVersion,1)
          AND CONVERT(char(64),HASHBYTES('SHA2_256',o.DataCipher),2)=selected.CounterpartVersion
          AND NOT EXISTS(SELECT 1 FROM dbo.CommitteeReportIncidents report WHERE report.RecordNo=s.RecordNo);
        IF @@ROWCOUNT<>${confirmed.length} THROW 51061,'Report inputs changed.',1;
        INSERT dbo.CommitteeNoiseReports(KaptCode,PairKey)
        SELECT DISTINCT @kaptCode,selected.PairKey
        FROM (VALUES ${values}) selected(RecordNo,SubmissionVersion,CounterpartVersion,PairKey)
        WHERE NOT EXISTS (SELECT 1 FROM dbo.CommitteeNoiseReports document
          WHERE document.KaptCode=@kaptCode AND document.PairKey=selected.PairKey);
        COMMIT TRANSACTION;
      `, params);
    } catch (error) {
      if ((error as { number?: number }).number !== 51061) throw error;
      res.status(409).json({ error: '발생일지나 상대세대 정보가 변경되었습니다. 목록을 새로 조회해 주세요.' });
      return;
    }
    res.status(201).json({ added: confirmed.length, reports: pairKeys.size, skipped: unique.length - confirmed.length,
      skippedReasons: skipped });
  });

  for (const [route, table, idColumn] of [
    ['visit-applications', 'CommitteeVisitApplications', 'VisitApplicationId'],
    ['measurement-applications', 'CommitteeMeasurementApplications', 'MeasurementApplicationId'],
    ['mediation-reports', 'CommitteeMediationReports', 'MediationReportId'],
    ['reports', 'CommitteeNoiseReports', 'ReportId'],
  ]) {
    router.delete(`/${route}`, async (req, res) => {
      const ids: unknown = req.body?.ids;
      if (!Array.isArray(ids) || !ids.length || ids.length > 500
          || ids.some(id => !Number.isInteger(id) || id < 1 || id > 2147483647)) {
        res.status(400).json({ error: '삭제할 항목을 1~500건 선택해 주세요.' });
        return;
      }
      const kaptCode = res.locals.kaptCode;
      const selected = 'SELECT [value] FROM OPENJSON(@ids) WITH ([value] int \'$\')';
      const [result] = await querySql<{ Deleted: number }>(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        ${route === 'mediation-reports' ? `
          DECLARE @matched TABLE (Id int PRIMARY KEY);
          INSERT @matched(Id)
          SELECT MediationReportId FROM dbo.CommitteeMediationReports WITH (XLOCK,HOLDLOCK)
          WHERE KaptCode=@kaptCode AND MediationReportId IN (${selected});
          DELETE FROM dbo.CommitteeMediationEntries WHERE MediationReportId IN (SELECT Id FROM @matched);
        ` : ''}
        ${route === 'reports' ? `
          DECLARE @lockResult int, @resource nvarchar(255)=CONCAT(N'CommitteeReport:',@kaptCode);
          EXEC @lockResult=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockTimeout=5000;
          IF @lockResult<0 THROW 51061,'Report is busy.',1;
          DELETE links FROM dbo.CommitteeReportIncidents links
          JOIN dbo.CommitteeNoiseReports report ON report.KaptCode=links.KaptCode AND report.PairKey=links.PairKey
          WHERE report.KaptCode=@kaptCode AND report.ReportId IN (${selected});
        ` : ''}
        DELETE FROM dbo.${table} WHERE KaptCode=@kaptCode
          AND ${idColumn} IN (${route === 'mediation-reports' ? 'SELECT Id FROM @matched' : selected});
        DECLARE @deleted int=@@ROWCOUNT;
        COMMIT TRANSACTION;
        SELECT @deleted AS Deleted;
      `, { kaptCode, ids: JSON.stringify([...new Set(ids)]) });
      res.json({ deleted: result.Deleted });
    });
  }

  router.delete('/incidents', async (req, res) => {
    const recordNos: unknown = req.body?.ids;
    if (!Array.isArray(recordNos) || !recordNos.length || recordNos.length > 500
        || recordNos.some(recordNo => typeof recordNo !== 'string' || !recordPattern.test(recordNo))) {
      res.status(400).json({ error: '삭제할 발생일지를 1~500건 선택해 주세요.' });
      return;
    }
    const ids = [...new Set<string>(recordNos)];
    const reportsReady = await hasReportSchema();
    try {
      const [result] = await querySql<{ Deleted: number }>(`
        SET XACT_ABORT ON;
        BEGIN TRANSACTION;
        DECLARE @lockResult int, @resource nvarchar(255)=CONCAT(N'CommitteeReport:',@kaptCode);
        EXEC @lockResult=sys.sp_getapplock @Resource=@resource,@LockMode='Exclusive',@LockTimeout=5000;
        IF @lockResult<0 THROW 51061,'Report is busy.',1;
        UPDATE submission SET CommitteeHiddenAt=SYSUTCDATETIME()
        FROM dbo.CommitteeSubmissions submission
        JOIN OPENJSON(@ids) WITH (RecordNo varchar(13) '$') selected ON selected.RecordNo=submission.RecordNo
        WHERE submission.KaptCode=@kaptCode AND submission.WithdrawnAt IS NULL AND submission.CommitteeHiddenAt IS NULL
          AND NOT EXISTS (SELECT 1 FROM (${linkedCommitteeDocuments}) links WHERE links.RecordNo=submission.RecordNo)
          ${reportsReady ? `AND NOT EXISTS (SELECT 1 FROM dbo.CommitteeReportIncidents report
            WHERE report.KaptCode=submission.KaptCode AND report.RecordNo=submission.RecordNo)` : ''};
        DECLARE @deleted int=@@ROWCOUNT;
        IF @deleted<>@expected THROW 51061,'Incident selection changed.',1;
        COMMIT TRANSACTION;
        SELECT @deleted AS Deleted;
      `, { kaptCode: res.locals.kaptCode, ids: JSON.stringify(ids), expected: ids.length, key: memberDataKey });
      res.json({ deleted: result.Deleted });
    } catch (error) {
      if ((error as { number?: number }).number !== 51061) throw error;
      res.status(409).json({ error: '선택한 일지가 변경되었거나 이미 보고서 또는 신청서에 포함되어 있습니다. 목록을 다시 조회해 주세요.' });
    }
  });

  router.get('/incidents/:recordNo', async (req, res) => {
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
      return;
    }
    const [incident] = await readIncidents(res.locals.kaptCode, [req.params.recordNo]);
    if (!incident) res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
    else res.json(incident);
  });

  router.post('/incidents/:recordNo/integrity-check', async (req, res) => {
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
      return;
    }
    const key = `${res.locals.memberId}:${req.params.recordNo}`;
    const now = Date.now();
    const currentWindow = integrityWindows.get(key);
    const window = !currentWindow || now - currentWindow.startedAt >= 60_000
      ? { startedAt: now, count: 1 } : { startedAt: currentWindow.startedAt, count: currentWindow.count + 1 };
    integrityWindows.set(key, window);
    if (activeIntegrityChecks.has(key) || activeIntegrityChecks.size >= 2 || window.count > 6) {
      res.status(429).json({ error: '음원 검증이 진행 중입니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    if (integrityWindows.size > 10_000) {
      for (const [entry, state] of integrityWindows) if (now - state.startedAt > 60_000) integrityWindows.delete(entry);
    }
    activeIntegrityChecks.add(key);
    try {
      const result = await verifyIntegrity(res.locals.kaptCode, req.params.recordNo, res.locals.memberId, emailFrom);
      res.json(result);
    } catch (error) {
      if ((error as { number?: number }).number !== 51050) throw error;
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
    } finally {
      activeIntegrityChecks.delete(key);
    }
  });

  router.put('/incidents/:recordNo/counterpart', async (req, res) => {
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
      return;
    }
    const name = clean(req.body?.name, 80);
    const dong = clean(req.body?.dong, 20).replace(/동$/, '');
    const ho = normalizeRoomNumber(req.body?.ho).slice(0, 20);
    const estimatedPlace = clean(req.body?.estimatedPlace, 200);
    if (/[<>\r\n]/.test(name + dong + ho + estimatedPlace)) {
      res.status(400).json({ error: '상대세대 정보를 확인해 주세요.' });
      return;
    }
    const data = JSON.stringify({ name, dong, ho, estimatedPlace });
    const reportsReady = await hasReportSchema();
    const [saved] = await querySql<{ UpdatedAt: Date; Editor: string }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      IF NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissions WITH(UPDLOCK,HOLDLOCK)
        WHERE RecordNo=@recordNo AND KaptCode=@kaptCode AND WithdrawnAt IS NULL AND CommitteeHiddenAt IS NULL)
        THROW 51051,'Committee submission not found.',1;
      ${reportsReady ? `IF EXISTS(SELECT 1 FROM dbo.CommitteeReportIncidents WHERE RecordNo=@recordNo AND KaptCode=@kaptCode)
      BEGIN
        COMMIT TRANSACTION;
        RETURN;
      END;` : ''}
      DECLARE @previous varbinary(max)=(SELECT DataCipher FROM dbo.CommitteeCounterpartOverrides WHERE RecordNo=@recordNo);
      INSERT dbo.CommitteeCounterpartHistory(RecordNo,KaptCode,EditorMemberId,PreviousCipher,NewCipher)
      VALUES(@recordNo,@kaptCode,@memberId,@previous,dbo.EncryptMemberData(@data,@key));
      UPDATE dbo.CommitteeCounterpartOverrides SET KaptCode=@kaptCode,DataCipher=dbo.EncryptMemberData(@data,@key),
        UpdatedBy=@memberId,UpdatedAt=SYSUTCDATETIME() WHERE RecordNo=@recordNo;
      IF @@ROWCOUNT=0 INSERT dbo.CommitteeCounterpartOverrides(RecordNo,KaptCode,DataCipher,UpdatedBy)
        VALUES(@recordNo,@kaptCode,dbo.EncryptMemberData(@data,@key),@memberId);
      SELECT o.UpdatedAt,dbo.DecryptMemberData(m.MemberCipher,@key) AS Editor
      FROM dbo.CommitteeCounterpartOverrides o JOIN dbo.CommitteeMembers m ON m.MemberId=o.UpdatedBy
      WHERE o.RecordNo=@recordNo;
      COMMIT TRANSACTION;
    `, { recordNo: req.params.recordNo, kaptCode: res.locals.kaptCode, memberId: res.locals.memberId,
      data, key: memberDataKey });
    if (!saved) {
      res.status(409).json({ error: '보고서에 포함된 발생일지의 상대세대 확인 정보는 수정할 수 없습니다.' });
      return;
    }
    const editor = parseJson(saved?.Editor ?? null);
    res.json({ recordNo: req.params.recordNo, name, dong, ho, estimatedPlace, counterpartConfirmed: Boolean(name && ho), ...estimatedUnitFields(estimatedPlace),
      updatedAt: saved?.UpdatedAt.toISOString() ?? new Date().toISOString(), updatedBy: clean(editor.name, 80) });
  });

  router.get('/incidents/:recordNo/counterpart-history', async (req, res) => {
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
      return;
    }
    const rows = await querySql<{ HistoryId: number; NewValue: string; Editor: string; ChangedAt: Date }>(`
      SELECT TOP (50) h.HistoryId,dbo.DecryptMemberData(h.NewCipher,@key) AS NewValue,
        dbo.DecryptMemberData(m.MemberCipher,@key) AS Editor,h.ChangedAt
      FROM dbo.CommitteeCounterpartHistory h JOIN dbo.CommitteeMembers m ON m.MemberId=h.EditorMemberId
      WHERE h.RecordNo=@recordNo AND h.KaptCode=@kaptCode
        AND EXISTS(SELECT 1 FROM dbo.CommitteeSubmissions s WHERE s.RecordNo=h.RecordNo
          AND s.KaptCode=h.KaptCode AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL)
      ORDER BY h.ChangedAt DESC,h.HistoryId DESC;
    `, { recordNo: req.params.recordNo, kaptCode: res.locals.kaptCode, key: memberDataKey });
    res.json({ history: rows.map(row => {
      const value = parseJson(row.NewValue), editor = parseJson(row.Editor);
      return { historyId: row.HistoryId, name: clean(value.name, 80), dong: clean(value.dong, 20),
        ho: clean(value.ho, 20), estimatedPlace: clean(value.estimatedPlace, 200),
        changedAt: row.ChangedAt.toISOString(), changedBy: clean(editor.name, 80) };
    }) });
  });

  router.post('/incidents/:recordNo/integrity-resolution', async (req, res) => {
    if (res.locals.committeeRole !== '위원장') {
      res.status(403).json({ error: '위원장만 무결성 확인 메모를 등록할 수 있습니다.' });
      return;
    }
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '발생일지를 찾을 수 없습니다.' });
      return;
    }
    const resolution = clean(req.body?.resolution, 1_000);
    if (resolution.length < 10) {
      res.status(400).json({ error: '확인 내용과 재제출 안내를 10자 이상 입력해 주세요.' });
      return;
    }
    const notice = `발생일지 ${req.params.recordNo}의 음원 무결성 확인 메모가 등록되었습니다. 최초 원본과 동일한 음원을 다시 제출해 검증을 완료해 주세요. 위원회 확인 내용: ${resolution}`;
    const [result] = await querySql<{
      EventId: number; NotificationId: number; ExpectedAudioSha256: string;
      ObservedAudioSha256: string; SubmittedAudioSha256: string; NotedAt: Date;
      NotificationCreated: boolean; EmailAlreadySent: boolean;
    }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      DECLARE @userId int,@artifactId bigint,@eventId bigint,@notificationId bigint,@notificationCreated bit=0;
      SELECT @userId=UserId,@artifactId=SubmissionArtifactId FROM dbo.CommitteeSubmissions WITH(UPDLOCK,HOLDLOCK)
      WHERE RecordNo=@recordNo AND KaptCode=@kaptCode AND WithdrawnAt IS NULL AND CommitteeHiddenAt IS NULL
        AND IntegrityStatus='MISMATCH_BLOCKED';
      IF @userId IS NULL THROW 51052,'Blocked integrity case not found.',1;
      UPDATE dbo.CommitteeSubmissions SET IntegrityResolvedAt=SYSUTCDATETIME(),
        IntegrityResolvedBy=@memberId,IntegrityResolutionCipher=dbo.EncryptMemberData(@resolution,@key)
      WHERE RecordNo=@recordNo;
      SELECT TOP (1) @notificationId=NotificationId
      FROM dbo.ResidentNotifications WITH(UPDLOCK,HOLDLOCK)
      WHERE UserId=@userId AND RelatedRecordNo=@recordNo
        AND NotificationType='AUDIO_INTEGRITY_ACTION_REQUIRED' AND ReadAt IS NULL
        AND RelatedArtifactId=@artifactId
        AND CreatedAt>=DATEADD(minute,-10,SYSUTCDATETIME())
      ORDER BY CreatedAt DESC,NotificationId DESC;
      IF @notificationId IS NULL
      BEGIN
        INSERT dbo.ResidentNotifications(UserId,NotificationType,Title,MessageCipher,RelatedRecordNo,RelatedArtifactId)
        VALUES(@userId,'AUDIO_INTEGRITY_ACTION_REQUIRED',N'음원 원본 재제출 안내',
          dbo.EncryptMemberData(@notice,@key),@recordNo,@artifactId);
        SET @notificationId=SCOPE_IDENTITY();
        SET @notificationCreated=1;
      END;
      INSERT dbo.CommitteeIntegrityEvents(RecordNo,KaptCode,Status,ExpectedAudioSha256,ObservedAudioSha256,
        OriginalObservedAudioSha256,SubmittedAudioSha256,CheckedBy,NoteCipher,NotificationId)
      SELECT s.RecordNo,s.KaptCode,'MISMATCH_BLOCKED',s.ExpectedAudioSha256,s.ObservedAudioSha256,
        CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2),s.SubmittedAudioSha256,
        @memberId,dbo.EncryptMemberData(@resolution,@key),@notificationId
      FROM dbo.CommitteeSubmissions s JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo
      WHERE s.RecordNo=@recordNo;
      SET @eventId=SCOPE_IDENTITY();
      SELECT @eventId AS EventId,@notificationId AS NotificationId,
        @notificationCreated AS NotificationCreated,
        IIF(n.EmailSentAt IS NOT NULL,1,0) AS EmailAlreadySent,
        s.ExpectedAudioSha256,s.ObservedAudioSha256,
        s.SubmittedAudioSha256,s.IntegrityResolvedAt AS NotedAt
      FROM dbo.CommitteeSubmissions s JOIN dbo.ResidentNotifications n ON n.NotificationId=@notificationId
      WHERE s.RecordNo=@recordNo;
      COMMIT TRANSACTION;
    `, { recordNo: req.params.recordNo, kaptCode: res.locals.kaptCode, memberId: res.locals.memberId,
      resolution, key: memberDataKey, notice });
    if (!result) throw new Error('Integrity resolution did not return a result.');
    res.json({ recordNo: req.params.recordNo, status: 'MISMATCH_BLOCKED', resolution,
      notedAt: result.NotedAt.toISOString(), notificationCreated: Boolean(result.NotificationCreated),
      emailSent: Boolean(result.EmailAlreadySent),
      message: '확인 메모를 저장했습니다. 동일한 원본 음원이 재제출되어야 차단이 해제됩니다.' });
  });

  router.get('/incidents/:recordNo/audio', async (req, res) => {
    if (!recordPattern.test(req.params.recordNo)) {
      res.status(404).json({ error: '녹음 파일을 찾을 수 없습니다.' });
      return;
    }
    const memberId = Number(res.locals.memberId);
    const now = Date.now();
    const currentWindow = audioWindows.get(memberId);
    const window = !currentWindow || now - currentWindow.startedAt >= 60_000
      ? { startedAt: now, count: 1 } : { startedAt: currentWindow.startedAt, count: currentWindow.count + 1 };
    audioWindows.set(memberId, window);
    if (activeAudioRequests >= 6 || (activeAudioByMember.get(memberId) ?? 0) >= 2 || window.count > 180) {
      res.status(429).json({ error: '음원 재생 요청이 많습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    if (audioWindows.size > 10_000) {
      for (const [id, state] of audioWindows) if (now - state.startedAt > 60_000) audioWindows.delete(id);
    }
    activeAudioRequests += 1;
    activeAudioByMember.set(memberId, (activeAudioByMember.get(memberId) ?? 0) + 1);
    try {
      const [recording] = await querySql<{ AudioLength: number }>(`
        SELECT a.AudioLength FROM dbo.CommitteeSubmissions s
        JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
          AND a.RecordNo=s.RecordNo AND a.UserId=s.UserId
        WHERE s.KaptCode=@kaptCode AND s.RecordNo=@recordNo AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL
      `, { kaptCode: res.locals.kaptCode, recordNo: req.params.recordNo });
      if (!recording) {
        res.status(404).json({ error: '녹음 파일을 찾을 수 없습니다.' });
        return;
      }
      const audioLength = Number(recording.AudioLength);
      if (!Number.isSafeInteger(audioLength) || audioLength < 1) {
        res.status(404).json({ error: '녹음 파일을 찾을 수 없습니다.' });
        return;
      }
      res.set({ 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mp4', 'Content-Disposition': `inline; filename="${req.params.recordNo}.m4a"` });
      const readChunk = async (start: number, count: number): Promise<Buffer | null> => {
        const [content] = await querySql<{ AudioData: Buffer }>(`
          SELECT CONVERT(varbinary(max),SUBSTRING(a.AudioData,@offset,@count)) AS AudioData
          FROM dbo.CommitteeSubmissions s
          JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
            AND a.RecordNo=s.RecordNo AND a.UserId=s.UserId
          WHERE s.KaptCode=@kaptCode AND s.RecordNo=@recordNo AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL
        `, { kaptCode: res.locals.kaptCode, recordNo: req.params.recordNo, offset: start + 1, count });
        return content?.AudioData ?? null;
      };
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.header('range') ?? '');
      if (!range) {
        res.status(200).set('Content-Length', String(audioLength));
        for (let start = 0; start < audioLength && !res.destroyed; start += 1024 * 1024) {
          const chunk = await readChunk(start, Math.min(1024 * 1024, audioLength - start));
          if (!chunk) { res.destroy(); return; }
          if (!res.write(chunk)) await new Promise<void>(resolve => {
            const complete = () => {
              res.off('drain', complete);
              res.off('close', complete);
              resolve();
            };
            res.once('drain', complete);
            res.once('close', complete);
          });
        }
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      const start = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : start + 1024 * 1024 - 1;
      const end = Math.min(requestedEnd, start + 1024 * 1024 - 1, audioLength - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= audioLength) {
        res.status(416).set('Content-Range', `bytes */${audioLength}`).end();
        return;
      }
      const content = await readChunk(start, end - start + 1);
      if (!content) { res.status(404).json({ error: '녹음 파일을 찾을 수 없습니다.' }); return; }
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${audioLength}`, 'Content-Length': String(content.length) })
        .send(content);
    } finally {
      activeAudioRequests = Math.max(0, activeAudioRequests - 1);
      const remaining = (activeAudioByMember.get(memberId) ?? 1) - 1;
      if (remaining <= 0) activeAudioByMember.delete(memberId);
      else activeAudioByMember.set(memberId, remaining);
    }
  });

  let activeExports = 0;
  const lastExportByMember = new Map<number, number>();
  router.post('/incident-log-form', async (req, res) => {
    const kaptCode: string = res.locals.kaptCode;
    const reportKey = field(req.body?.reportKey);
    const recordNos: unknown = req.body?.recordNos;
    if (reportKey ? !/^[a-f0-9]{64}$/.test(reportKey) : !Array.isArray(recordNos) || !recordNos.length
      || recordNos.length > 500 || recordNos.some(recordNo => typeof recordNo !== 'string' || !recordPattern.test(recordNo))) {
      return res.status(400).json({ error: '확인할 발생일지를 선택해 주세요.' });
    }
    const selected = reportKey ? undefined : [...new Set(recordNos as string[])];
    const rows = await readIncidents(kaptCode, selected, reportKey || undefined);
    if (!rows.length || (selected && rows.length !== selected.length)) {
      return res.status(409).json({ error: '일부 발생일지를 조회할 수 없습니다. 목록을 다시 조회해 주세요.' });
    }
    const [complex] = await querySql<{ Name: string; Address: string | null }>(`
      SELECT TOP (1) kaptName AS Name, COALESCE(NULLIF(TRIM(roadAddress),N''),NULLIF(TRIM(address),N''),NULLIF(TRIM(legalAddress),N'')) AS Address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode });
    const groups = new Map<string, { applicantName: string; applicantPhone: string; applicantAddress: string;
      entries: { startedAt: string; noiseType: string; durationOrCount: string }[] }>();
    for (const row of rows) {
      const key = reportPairKey(kaptCode, row);
      let group = groups.get(key);
      if (!group) {
        const location = [complex?.Name, complex?.Address].find(value => value?.trim())?.trim();
        group = { applicantName: row.applicantName, applicantPhone: row.applicantPhone,
          applicantAddress: location ? [location, row.applicantDong && `${row.applicantDong.replace(/동$/, '')}동`,
            row.applicantHo && `${row.applicantHo.replace(/호$/, '')}호`].filter(Boolean).join(' ') : row.applicantAddress, entries: [] };
        groups.set(key, group);
      }
      group.entries.push({ startedAt: row.startedAt, noiseType: row.noiseType, durationOrCount: row.durationOrCount });
    }
    res.set('Cache-Control', 'private, no-store').json({ groups: [...groups.values()] });
  });

  router.post('/export', async (req, res) => {
    const recordNos: unknown = req.body?.recordNos;
    const reportKey = field(req.body?.reportKey);
    const incidentLog = req.body?.document === 'incident-log';
    const groupExport = (!incidentLog || Boolean(reportKey)) && await hasReportSchema();
    const reportExport = groupExport && !incidentLog;
    const recordsValid = Array.isArray(recordNos) && recordNos.length > 0 && recordNos.length <= (incidentLog ? 500 : 50)
      && recordNos.every(value => typeof value === 'string' && recordPattern.test(value));
    if (incidentLog && reportKey && !groupExport) {
      res.status(503).json({ message: '층간소음보고서 저장소가 준비되지 않았습니다.' });
      return;
    }
    if (groupExport ? !/^[a-f0-9]{64}$/.test(reportKey) : !recordsValid) {
      res.status(400).json({ error: incidentLog ? '출력할 발생일지 1~500건을 조회해 주세요.' : '출력할 층간소음보고서를 선택해 주세요.' });
      return;
    }
    const uniqueRecordNos = !groupExport ? [...new Set<string>(recordNos as string[])] : undefined;
    const kaptCode: string = res.locals.kaptCode;
    const readExportRows = () => readIncidents(kaptCode, uniqueRecordNos, groupExport ? reportKey : undefined);
    const memberId = Number(res.locals.memberId);
    const now = Date.now();
    if (activeExports >= 2 || now - (lastExportByMember.get(memberId) ?? 0) < 10_000) {
      res.status(429).json({ error: '출력 요청이 처리 중입니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    activeExports += 1;
    lastExportByMember.set(memberId, now);
    try {
    let rows = await readExportRows();
    if (!rows.length || (uniqueRecordNos && rows.length !== uniqueRecordNos.length)) {
      res.status(409).json({ error: '일부 발생일지가 철회되었거나 조회할 수 없습니다. 목록을 다시 조회해 주세요.' });
      return;
    }
    if (!incidentLog && rows.some(row => row.userId !== rows[0].userId)) {
      res.status(400).json({ error: '같은 신청세대의 발생일시만 선택해 주세요.' });
      return;
    }
    const applicantKey = normalized(`${rows[0].applicantName}|${rows[0].applicantPhone}|${rows[0].applicantAddress}`);
    if (!reportExport && !incidentLog && rows.some(row => normalized(`${row.applicantName}|${row.applicantPhone}|${row.applicantAddress}`) !== applicantKey)) {
      res.status(400).json({ error: '신청세대 정보가 서로 다른 발생일시는 한 문서로 출력할 수 없습니다.' });
      return;
    }
    const mustRecheck = rows.filter(row => row.artifactSource !== 'UPLOAD' || row.integrityStatus !== 'VERIFIED'
      || row.submittedAudioSha256 !== row.observedAudioSha256
      || row.submittedAudioSha256 !== row.expectedAudioSha256
      || row.expectedAudioSha256 !== row.currentAudioSha256
      || row.submittedAudioSha256 !== row.currentSubmittedAudioSha256);
    for (const row of mustRecheck) {
      await verifyIntegrity(res.locals.kaptCode, row.recordNo, res.locals.memberId, emailFrom);
    }
    if (mustRecheck.length) rows = await readExportRows();
    if (!rows.length || (uniqueRecordNos && rows.length !== uniqueRecordNos.length)
        || (groupExport && rows.some(row => !row.counterpartConfirmed || reportPairKey(kaptCode, row) !== reportKey))) {
      res.status(409).json({ error: '보고서에 포함된 발생일지 또는 세대 정보가 변경되었습니다.' });
      return;
    }
    const blocked = rows.find(row => row.artifactSource !== 'UPLOAD' || row.integrityStatus !== 'VERIFIED'
      || row.submittedAudioSha256 !== row.observedAudioSha256
      || row.submittedAudioSha256 !== row.expectedAudioSha256
      || row.expectedAudioSha256 !== row.currentAudioSha256
      || row.submittedAudioSha256 !== row.currentSubmittedAudioSha256);
    if (blocked) {
      res.status(409).json({ error: `발생일지 ${blocked.recordNo}의 음원 무결성 문제가 해결되지 않아 출력할 수 없습니다.` });
      return;
    }
    const snapshotParameters = { kaptCode, snapshot: JSON.stringify(rows.map(row => [row.recordNo, row.artifactId])) };
    const [snapshot] = await querySql<{ ValidCount: number }>(`
      SET XACT_ABORT ON;
      BEGIN TRANSACTION;
      SELECT COUNT_BIG(*) AS ValidCount
      FROM OPENJSON(@snapshot) WITH(RecordNo varchar(13) '$[0]',ArtifactId bigint '$[1]') selected
      JOIN dbo.CommitteeSubmissions s WITH(UPDLOCK,HOLDLOCK)
        ON s.RecordNo=selected.RecordNo AND s.SubmissionArtifactId=selected.ArtifactId
      JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
      JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
        AND a.RecordNo=s.RecordNo AND a.UserId=s.UserId
      CROSS APPLY(SELECT TOP (1) e.Status,e.ExpectedAudioSha256,e.ObservedAudioSha256,
        e.OriginalObservedAudioSha256,e.SubmittedAudioSha256
        FROM dbo.CommitteeIntegrityEvents e WHERE e.RecordNo=s.RecordNo ORDER BY e.EventId DESC) lastCheck
      WHERE s.KaptCode=@kaptCode AND s.WithdrawnAt IS NULL AND s.CommitteeHiddenAt IS NULL AND s.IntegrityStatus='VERIFIED'
        AND a.ArtifactSource='UPLOAD'
        AND s.SubmittedAudioSha256=a.AudioSha256 AND s.ObservedAudioSha256=a.AudioSha256
        AND s.ExpectedAudioSha256=r.AudioSha256
        AND lastCheck.Status='VERIFIED'
        AND lastCheck.SubmittedAudioSha256=a.AudioSha256
        AND lastCheck.ObservedAudioSha256=a.AudioSha256
        AND lastCheck.ExpectedAudioSha256=r.AudioSha256
        AND lastCheck.OriginalObservedAudioSha256=r.AudioSha256;
      COMMIT TRANSACTION;
    `, snapshotParameters);
    if (Number(snapshot?.ValidCount ?? 0) !== rows.length) {
      res.status(409).json({ error: '선택한 발생일지가 재제출 또는 철회되어 출력이 중단되었습니다. 목록을 새로 조회해 주세요.' });
      return;
    }
    const [chair] = await querySql<{ Email: string; MemberJson: string }>(`
      SELECT dbo.DecryptMemberData(EmailCipher,@key) AS Email,dbo.DecryptMemberData(MemberCipher,@key) AS MemberJson
      FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Role=N'위원장' AND ApprovedAt IS NOT NULL
    `, { kaptCode: res.locals.kaptCode, key: memberDataKey });
    const chairData = chair ? parseJson(chair.MemberJson) : {};
    const [complex] = await querySql<{ kaptName: string; address: string | null }>(`
      SELECT TOP (1) kaptName, COALESCE(NULLIF(TRIM(roadAddress),N''),NULLIF(TRIM(address),N''),NULLIF(TRIM(legalAddress),N'')) AS address
      FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode
    `, { kaptCode });
    const pdf = await createIncidentPdf(rows, { name: clean(chairData.name, 80), email: chair?.Email ?? '' },
      reportExport ? 'report' : incidentLog ? 'incident-log' : 'legacy',
      { name: clean(complex?.kaptName, 100), address: clean(complex?.address, 300) },
      row => reportPairKey(kaptCode, row));
    const finalRows = await readExportRows();
    const finalByRecord = new Map(finalRows.map(row => [row.recordNo, row]));
    if (finalRows.length !== rows.length || rows.some(row => {
      const current = finalByRecord.get(row.recordNo);
      return !current || current.submissionVersion !== row.submissionVersion
        || current.journalVersion !== row.journalVersion || current.artifactId !== row.artifactId
        || current.counterpartVersion !== row.counterpartVersion
        || current.integrityStatus !== 'VERIFIED';
    })) {
      res.status(409).json({ error: 'PDF 생성 중 발생일지가 변경 또는 철회되어 출력이 중단되었습니다. 목록을 새로 조회해 주세요.' });
      return;
    }
    const kstDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' });
    const allSameApplicant = rows.every(row => row.userId === rows[0].userId);
    const safeName = (allSameApplicant && rows[0].applicantName || '신청세대').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
    const filename = `${safeName}_${kstDate.format(new Date(rows[0].startedAt))}_${kstDate.format(new Date(rows.at(-1)!.endedAt))}_${reportExport ? '층간소음보고서' : '층간소음발생일지'}.pdf`;
    const disposition = req.body?.download === true ? 'attachment' : 'inline';
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16)}`);
    res.type('application/pdf').set('Content-Disposition', `${disposition}; filename*=UTF-8''${encoded}`).send(pdf);
    } finally {
      activeExports -= 1;
    }
  });
  return router;
}
