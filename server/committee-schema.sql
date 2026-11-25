SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.CommitteeMembers',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeMembers(
    MemberId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeMembers PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    Seat tinyint NOT NULL CONSTRAINT CK_CommitteeMembers_Seat CHECK(Seat BETWEEN 1 AND 3),
    Role nvarchar(10) NOT NULL CONSTRAINT CK_CommitteeMembers_Role CHECK(Role IN(N'위원장',N'위원')),
    LoginHash char(64) NOT NULL CONSTRAINT UQ_CommitteeMembers_LoginHash UNIQUE,
    EmailHash char(64) NOT NULL CONSTRAINT UQ_CommitteeMembers_EmailHash UNIQUE,
    MobileHash char(64) NOT NULL CONSTRAINT UQ_CommitteeMembers_MobileHash UNIQUE,
    EmailCipher varbinary(max) NOT NULL,
    MemberCipher varbinary(max) NOT NULL,
    DocumentCipher varbinary(max) NOT NULL,
    PasswordHash varchar(100) NOT NULL,
    ApprovedAt datetime2(0) NOT NULL,
    ConsentedAt datetime2(0) NOT NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeMembers_CreatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CommitteeMembers_KaptSeat UNIQUE(KaptCode,Seat));
END;

IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeMembers') AND name=N'UX_CommitteeMembers_Chair')
  CREATE UNIQUE INDEX UX_CommitteeMembers_Chair ON dbo.CommitteeMembers(KaptCode) WHERE Role=N'위원장';

IF OBJECT_ID(N'dbo.CommitteeApplications',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeApplications(
    ApplicationId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeApplications PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    RequestedRole nvarchar(10) NOT NULL CONSTRAINT CK_CommitteeApplications_Role CHECK(RequestedRole IN(N'위원장',N'위원')),
    LoginHash char(64) NOT NULL,
    EmailHash char(64) NOT NULL,
    MobileHash char(64) NOT NULL,
    EmailCipher varbinary(max) NOT NULL,
    MemberCipher varbinary(max) NOT NULL,
    DocumentCipher varbinary(max) NOT NULL,
    DocumentSha256 char(64) NOT NULL,
    PasswordHash varchar(100) NOT NULL,
    ConsentedAt datetime2(0) NOT NULL,
    Status varchar(12) NOT NULL CONSTRAINT DF_CommitteeApplications_Status DEFAULT 'PENDING'
      CONSTRAINT CK_CommitteeApplications_Status CHECK(Status IN('PENDING','APPROVED','REJECTED')),
    ApprovedMemberId int NULL CONSTRAINT FK_CommitteeApplications_Member REFERENCES dbo.CommitteeMembers(MemberId),
    Reviewer nvarchar(128) NULL,
    ReviewedDocumentSha256 char(64) NULL,
    ReviewNote nvarchar(1000) NULL,
    ReviewedAt datetime2(0) NULL,
    SubmittedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeApplications_SubmittedAt DEFAULT SYSUTCDATETIME());
END;

IF COL_LENGTH(N'dbo.CommitteeApplications',N'Reviewer')<256
  ALTER TABLE dbo.CommitteeApplications ALTER COLUMN Reviewer nvarchar(128) NULL;

IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeApplications') AND name=N'UX_CommitteeApplications_PendingLogin')
  CREATE UNIQUE INDEX UX_CommitteeApplications_PendingLogin ON dbo.CommitteeApplications(LoginHash) WHERE Status='PENDING';
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeApplications') AND name=N'UX_CommitteeApplications_PendingEmail')
  CREATE UNIQUE INDEX UX_CommitteeApplications_PendingEmail ON dbo.CommitteeApplications(EmailHash) WHERE Status='PENDING';
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeApplications') AND name=N'UX_CommitteeApplications_PendingMobile')
  CREATE UNIQUE INDEX UX_CommitteeApplications_PendingMobile ON dbo.CommitteeApplications(MobileHash) WHERE Status='PENDING';
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeApplications') AND name=N'IX_CommitteeApplications_ReviewQueue')
  CREATE INDEX IX_CommitteeApplications_ReviewQueue ON dbo.CommitteeApplications(Status,SubmittedAt,ApplicationId);

IF OBJECT_ID(N'dbo.CommitteeLoginCodes',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeLoginCodes(
    MemberId int NOT NULL CONSTRAINT PK_CommitteeLoginCodes PRIMARY KEY
      CONSTRAINT FK_CommitteeLoginCodes_Member REFERENCES dbo.CommitteeMembers(MemberId),
    ChallengeId char(64) NOT NULL CONSTRAINT UQ_CommitteeLoginCodes_Challenge UNIQUE,
    CodeHash char(64) NOT NULL,
    ExpiresAt datetime2(0) NOT NULL,
    Attempts tinyint NOT NULL CONSTRAINT DF_CommitteeLoginCodes_Attempts DEFAULT 0);
END;

IF OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeSubmissionArtifacts(
    ArtifactId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeSubmissionArtifacts PRIMARY KEY,
    RecordNo varchar(13) NOT NULL CONSTRAINT FK_CommitteeSubmissionArtifacts_Recording
      REFERENCES dbo.NoiseRecordings(RecordNo),
    UserId int NOT NULL CONSTRAINT FK_CommitteeSubmissionArtifacts_User REFERENCES dbo.AppUsers(UserId),
    ArtifactSource varchar(20) NOT NULL CONSTRAINT DF_CommitteeSubmissionArtifacts_Source DEFAULT 'UPLOAD'
      CONSTRAINT CK_CommitteeSubmissionArtifacts_Source CHECK(ArtifactSource IN('UPLOAD','LEGACY_BACKFILL')),
    AudioSha256 char(64) NOT NULL,
    AudioLength bigint NOT NULL CONSTRAINT CK_CommitteeSubmissionArtifacts_Length CHECK(AudioLength>0),
    AudioData varbinary(max) NOT NULL,
    UploadedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeSubmissionArtifacts_UploadedAt DEFAULT SYSUTCDATETIME());
  CREATE INDEX IX_CommitteeSubmissionArtifacts_RecordUser
    ON dbo.CommitteeSubmissionArtifacts(RecordNo,UserId,UploadedAt DESC,ArtifactId DESC);
END;

IF OBJECT_ID(N'dbo.TR_CommitteeSubmissionArtifacts_InsertOnly',N'TR') IS NOT NULL
  DROP TRIGGER dbo.TR_CommitteeSubmissionArtifacts_InsertOnly;
IF COL_LENGTH(N'dbo.CommitteeSubmissionArtifacts',N'ArtifactSource') IS NULL
  ALTER TABLE dbo.CommitteeSubmissionArtifacts ADD ArtifactSource varchar(20) NULL;
IF EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifacts WHERE ArtifactSource IS NULL)
  UPDATE dbo.CommitteeSubmissionArtifacts SET ArtifactSource='LEGACY_BACKFILL' WHERE ArtifactSource IS NULL;
ALTER TABLE dbo.CommitteeSubmissionArtifacts ALTER COLUMN ArtifactSource varchar(20) NOT NULL;
IF NOT EXISTS(SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts') AND name=N'DF_CommitteeSubmissionArtifacts_Source')
  ALTER TABLE dbo.CommitteeSubmissionArtifacts ADD CONSTRAINT DF_CommitteeSubmissionArtifacts_Source DEFAULT 'UPLOAD' FOR ArtifactSource;
IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts') AND name=N'CK_CommitteeSubmissionArtifacts_Source')
  ALTER TABLE dbo.CommitteeSubmissionArtifacts ADD CONSTRAINT CK_CommitteeSubmissionArtifacts_Source
    CHECK(ArtifactSource IN('UPLOAD','LEGACY_BACKFILL'));
IF EXISTS(SELECT 1 FROM sys.indexes i WHERE i.object_id=OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts')
    AND i.name=N'UX_CommitteeSubmissionArtifacts_Content')
  AND NOT EXISTS(SELECT 1 FROM sys.index_columns ic
    WHERE ic.object_id=OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts')
      AND ic.index_id=INDEXPROPERTY(OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts'),N'UX_CommitteeSubmissionArtifacts_Content','IndexId')
      AND COL_NAME(ic.object_id,ic.column_id)=N'ArtifactSource')
  DROP INDEX UX_CommitteeSubmissionArtifacts_Content ON dbo.CommitteeSubmissionArtifacts;
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeSubmissionArtifacts') AND name=N'UX_CommitteeSubmissionArtifacts_Content')
  CREATE UNIQUE INDEX UX_CommitteeSubmissionArtifacts_Content
    ON dbo.CommitteeSubmissionArtifacts(RecordNo,UserId,ArtifactSource,AudioSha256,AudioLength);

IF OBJECT_ID(N'dbo.CommitteeSubmissions',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeSubmissions(
    RecordNo varchar(13) NOT NULL CONSTRAINT PK_CommitteeSubmissions PRIMARY KEY
      CONSTRAINT FK_CommitteeSubmissions_Recording REFERENCES dbo.NoiseRecordings(RecordNo),
    UserId int NOT NULL CONSTRAINT FK_CommitteeSubmissions_User REFERENCES dbo.AppUsers(UserId),
    KaptCode varchar(50) NOT NULL,
    DetailsCipher varbinary(max) NOT NULL,
    SubmissionArtifactId bigint NOT NULL CONSTRAINT FK_CommitteeSubmissions_Artifact
      REFERENCES dbo.CommitteeSubmissionArtifacts(ArtifactId),
    SubmittedAudioSha256 char(64) NOT NULL,
    ExpectedAudioSha256 char(64) NOT NULL,
    ObservedAudioSha256 char(64) NOT NULL,
    IntegrityStatus varchar(24) NOT NULL CONSTRAINT DF_CommitteeSubmissions_IntegrityStatus DEFAULT 'PENDING',
    IntegrityCheckedAt datetime2(0) NULL,
    IntegrityResolvedAt datetime2(0) NULL,
    IntegrityResolvedBy int NULL,
    IntegrityResolutionCipher varbinary(max) NULL,
    WithdrawnAt datetime2(0) NULL,
    SubmittedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeSubmissions_SubmittedAt DEFAULT SYSUTCDATETIME(),
    SubmissionVersion rowversion NOT NULL,
    CONSTRAINT CK_CommitteeSubmissions_IntegrityStatus CHECK(IntegrityStatus IN('PENDING','VERIFIED','MISMATCH_BLOCKED')),
    CONSTRAINT FK_CommitteeSubmissions_ResolvedBy FOREIGN KEY(IntegrityResolvedBy) REFERENCES dbo.CommitteeMembers(MemberId));
END;

DECLARE @needsSubmissionArtifactMigration bit=0;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmissionArtifactId') IS NULL
  SET @needsSubmissionArtifactMigration=1;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmittedAudioSha256') IS NULL
  OR COL_LENGTH(N'dbo.CommitteeSubmissions',N'ExpectedAudioSha256') IS NULL
  OR COL_LENGTH(N'dbo.CommitteeSubmissions',N'ObservedAudioSha256') IS NULL
  OR COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityStatus') IS NULL
  SET @needsSubmissionArtifactMigration=1;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmissionArtifactId') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD SubmissionArtifactId bigint NULL;
IF EXISTS(SELECT 1 FROM dbo.CommitteeSubmissions WHERE SubmissionArtifactId IS NULL)
  SET @needsSubmissionArtifactMigration=1;

IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmittedAudioSha256') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD SubmittedAudioSha256 char(64) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'ExpectedAudioSha256') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD ExpectedAudioSha256 char(64) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'ObservedAudioSha256') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD ObservedAudioSha256 char(64) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityStatus') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD IntegrityStatus varchar(24) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityCheckedAt') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD IntegrityCheckedAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityResolvedAt') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD IntegrityResolvedAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityResolvedBy') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD IntegrityResolvedBy int NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'IntegrityResolutionCipher') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD IntegrityResolutionCipher varbinary(max) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'WithdrawnAt') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD WithdrawnAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.CommitteeSubmissions',N'SubmissionVersion') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD SubmissionVersion rowversion;

INSERT dbo.CommitteeSubmissionArtifacts(RecordNo,UserId,ArtifactSource,AudioSha256,AudioLength,AudioData,UploadedAt)
SELECT s.RecordNo,s.UserId,'LEGACY_BACKFILL',CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2),
  DATALENGTH(r.AudioData),r.AudioData,COALESCE(s.SubmittedAt,r.CreatedAt)
FROM dbo.CommitteeSubmissions s
JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
WHERE s.SubmissionArtifactId IS NULL
  AND NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifacts a
    WHERE a.RecordNo=s.RecordNo AND a.UserId=s.UserId
      AND a.AudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2)
      AND a.AudioLength=DATALENGTH(r.AudioData));

UPDATE s SET SubmissionArtifactId=(SELECT TOP (1) a.ArtifactId
  FROM dbo.CommitteeSubmissionArtifacts a
  WHERE a.RecordNo=s.RecordNo AND a.UserId=s.UserId
  ORDER BY CASE WHEN a.AudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2)
      AND a.AudioLength=DATALENGTH(r.AudioData) THEN 0 ELSE 1 END,
    a.UploadedAt DESC,a.ArtifactId DESC)
FROM dbo.CommitteeSubmissions s
JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
WHERE s.SubmissionArtifactId IS NULL;

IF EXISTS(SELECT 1 FROM dbo.CommitteeSubmissions s
  JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
  WHERE a.ArtifactSource='LEGACY_BACKFILL' AND s.IntegrityStatus<>'MISMATCH_BLOCKED')
  SET @needsSubmissionArtifactMigration=1;
IF @needsSubmissionArtifactMigration=1
BEGIN
  UPDATE s SET SubmittedAudioSha256=a.AudioSha256,
    ExpectedAudioSha256=r.AudioSha256,
    ObservedAudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',a.AudioData),2),
    IntegrityStatus=CASE WHEN a.ArtifactSource='LEGACY_BACKFILL' THEN 'MISMATCH_BLOCKED'
      ELSE CASE WHEN a.AudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',a.AudioData),2)
      AND a.AudioSha256=r.AudioSha256
      AND r.AudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2)
      THEN 'VERIFIED' ELSE 'MISMATCH_BLOCKED' END END,
    IntegrityCheckedAt=COALESCE(s.IntegrityCheckedAt,s.SubmittedAt)
  FROM dbo.CommitteeSubmissions s
  JOIN dbo.NoiseRecordings r ON r.RecordNo=s.RecordNo AND r.UserId=s.UserId
  JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId;
END;

UPDATE dbo.CommitteeSubmissions SET IntegrityStatus='MISMATCH_BLOCKED',IntegrityCheckedAt=NULL,
  IntegrityResolvedAt=NULL,IntegrityResolvedBy=NULL,IntegrityResolutionCipher=NULL
WHERE IntegrityStatus='RESOLVED';
UPDATE s SET IntegrityStatus='MISMATCH_BLOCKED'
FROM dbo.CommitteeSubmissions s
JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=s.SubmissionArtifactId
WHERE a.ArtifactSource='LEGACY_BACKFILL' AND s.IntegrityStatus<>'MISMATCH_BLOCKED';

ALTER TABLE dbo.CommitteeSubmissions ALTER COLUMN SubmissionArtifactId bigint NOT NULL;
ALTER TABLE dbo.CommitteeSubmissions ALTER COLUMN SubmittedAudioSha256 char(64) NOT NULL;
ALTER TABLE dbo.CommitteeSubmissions ALTER COLUMN ExpectedAudioSha256 char(64) NOT NULL;
ALTER TABLE dbo.CommitteeSubmissions ALTER COLUMN ObservedAudioSha256 char(64) NOT NULL;
ALTER TABLE dbo.CommitteeSubmissions ALTER COLUMN IntegrityStatus varchar(24) NOT NULL;

IF NOT EXISTS(SELECT 1 FROM sys.default_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'DF_CommitteeSubmissions_IntegrityStatus')
  ALTER TABLE dbo.CommitteeSubmissions ADD CONSTRAINT DF_CommitteeSubmissions_IntegrityStatus DEFAULT 'PENDING' FOR IntegrityStatus;
IF EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'CK_CommitteeSubmissions_IntegrityStatus')
  ALTER TABLE dbo.CommitteeSubmissions DROP CONSTRAINT CK_CommitteeSubmissions_IntegrityStatus;
ALTER TABLE dbo.CommitteeSubmissions ADD CONSTRAINT CK_CommitteeSubmissions_IntegrityStatus
  CHECK(IntegrityStatus IN('PENDING','VERIFIED','MISMATCH_BLOCKED'));
IF NOT EXISTS(SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'FK_CommitteeSubmissions_ResolvedBy')
  ALTER TABLE dbo.CommitteeSubmissions ADD CONSTRAINT FK_CommitteeSubmissions_ResolvedBy
    FOREIGN KEY(IntegrityResolvedBy) REFERENCES dbo.CommitteeMembers(MemberId);
IF NOT EXISTS(SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'FK_CommitteeSubmissions_Artifact')
  ALTER TABLE dbo.CommitteeSubmissions ADD CONSTRAINT FK_CommitteeSubmissions_Artifact
    FOREIGN KEY(SubmissionArtifactId) REFERENCES dbo.CommitteeSubmissionArtifacts(ArtifactId);

IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'IX_CommitteeSubmissions_Complex')
  CREATE INDEX IX_CommitteeSubmissions_Complex ON dbo.CommitteeSubmissions(KaptCode,SubmittedAt DESC);
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.CommitteeSubmissions') AND name=N'IX_CommitteeSubmissions_Integrity')
  CREATE INDEX IX_CommitteeSubmissions_Integrity ON dbo.CommitteeSubmissions(KaptCode,IntegrityStatus,SubmittedAt DESC);

IF OBJECT_ID(N'dbo.CommitteeSubmissionArtifactBindings',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeSubmissionArtifactBindings(
    BindingId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeSubmissionArtifactBindings PRIMARY KEY,
    ArtifactId bigint NOT NULL CONSTRAINT UQ_CommitteeSubmissionArtifactBindings_Artifact UNIQUE
      CONSTRAINT FK_CommitteeSubmissionArtifactBindings_Artifact REFERENCES dbo.CommitteeSubmissionArtifacts(ArtifactId),
    RecordNo varchar(13) NOT NULL,
    UserId int NOT NULL,
    BoundAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeSubmissionArtifactBindings_BoundAt DEFAULT SYSUTCDATETIME());
END;
INSERT dbo.CommitteeSubmissionArtifactBindings(ArtifactId,RecordNo,UserId,BoundAt)
SELECT s.SubmissionArtifactId,s.RecordNo,s.UserId,COALESCE(s.SubmittedAt,SYSUTCDATETIME())
FROM dbo.CommitteeSubmissions s
WHERE NOT EXISTS(SELECT 1 FROM dbo.CommitteeSubmissionArtifactBindings b
  WHERE b.ArtifactId=s.SubmissionArtifactId);

IF OBJECT_ID(N'dbo.CommitteeCounterpartOverrides',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeCounterpartOverrides(
    RecordNo varchar(13) NOT NULL CONSTRAINT PK_CommitteeCounterpartOverrides PRIMARY KEY
      CONSTRAINT FK_CommitteeCounterpartOverrides_Submission REFERENCES dbo.CommitteeSubmissions(RecordNo),
    KaptCode varchar(50) NOT NULL,
    DataCipher varbinary(max) NOT NULL,
    UpdatedBy int NOT NULL CONSTRAINT FK_CommitteeCounterpartOverrides_Member REFERENCES dbo.CommitteeMembers(MemberId),
    UpdatedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeCounterpartOverrides_UpdatedAt DEFAULT SYSUTCDATETIME());
END;

IF OBJECT_ID(N'dbo.CommitteeCounterpartHistory',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeCounterpartHistory(
    HistoryId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeCounterpartHistory PRIMARY KEY,
    RecordNo varchar(13) NOT NULL CONSTRAINT FK_CommitteeCounterpartHistory_Submission REFERENCES dbo.CommitteeSubmissions(RecordNo),
    KaptCode varchar(50) NOT NULL,
    EditorMemberId int NOT NULL CONSTRAINT FK_CommitteeCounterpartHistory_Member REFERENCES dbo.CommitteeMembers(MemberId),
    PreviousCipher varbinary(max) NULL,
    NewCipher varbinary(max) NOT NULL,
    ChangedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeCounterpartHistory_ChangedAt DEFAULT SYSUTCDATETIME());
  CREATE INDEX IX_CommitteeCounterpartHistory_Record ON dbo.CommitteeCounterpartHistory(RecordNo,ChangedAt DESC);
END;

IF OBJECT_ID(N'dbo.ResidentNotifications',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ResidentNotifications(
    NotificationId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_ResidentNotifications PRIMARY KEY,
    UserId int NOT NULL CONSTRAINT FK_ResidentNotifications_User REFERENCES dbo.AppUsers(UserId),
    NotificationType varchar(40) NOT NULL,
    Title nvarchar(200) NOT NULL,
    MessageCipher varbinary(max) NOT NULL,
    RelatedRecordNo varchar(13) NULL,
    RelatedArtifactId bigint NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_ResidentNotifications_CreatedAt DEFAULT SYSUTCDATETIME(),
    ReadAt datetime2(0) NULL,
    EmailClaimedAt datetime2(0) NULL,
    EmailSentAt datetime2(0) NULL,
    EmailError nvarchar(500) NULL,
    EmailAttempts int NOT NULL CONSTRAINT DF_ResidentNotifications_EmailAttempts DEFAULT 0,
    EmailNextAttemptAt datetime2(0) NULL);
  CREATE INDEX IX_ResidentNotifications_Unread ON dbo.ResidentNotifications(UserId,ReadAt,CreatedAt DESC);
END;

IF COL_LENGTH(N'dbo.ResidentNotifications',N'EmailClaimedAt') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD EmailClaimedAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.ResidentNotifications',N'EmailSentAt') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD EmailSentAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.ResidentNotifications',N'EmailError') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD EmailError nvarchar(500) NULL;
IF COL_LENGTH(N'dbo.ResidentNotifications',N'EmailAttempts') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD EmailAttempts int NOT NULL
    CONSTRAINT DF_ResidentNotifications_EmailAttempts DEFAULT 0;
IF COL_LENGTH(N'dbo.ResidentNotifications',N'EmailNextAttemptAt') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD EmailNextAttemptAt datetime2(0) NULL;
IF COL_LENGTH(N'dbo.ResidentNotifications',N'RelatedArtifactId') IS NULL
  ALTER TABLE dbo.ResidentNotifications ADD RelatedArtifactId bigint NULL;
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.ResidentNotifications')
  AND name=N'IX_ResidentNotifications_ArtifactDedupe')
  CREATE INDEX IX_ResidentNotifications_ArtifactDedupe
    ON dbo.ResidentNotifications(UserId,RelatedRecordNo,RelatedArtifactId,NotificationType,CreatedAt DESC);

IF OBJECT_ID(N'dbo.CommitteeIntegrityEvents',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeIntegrityEvents(
    EventId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeIntegrityEvents PRIMARY KEY,
    RecordNo varchar(13) NOT NULL CONSTRAINT FK_CommitteeIntegrityEvents_Submission REFERENCES dbo.CommitteeSubmissions(RecordNo),
    KaptCode varchar(50) NOT NULL,
    Status varchar(24) NOT NULL CONSTRAINT CK_CommitteeIntegrityEvents_Status
      CHECK(Status IN('VERIFIED','MISMATCH_BLOCKED','RESOLVED')),
    ExpectedAudioSha256 char(64) NOT NULL,
    ObservedAudioSha256 char(64) NOT NULL,
    OriginalObservedAudioSha256 char(64) NOT NULL,
    SubmittedAudioSha256 char(64) NOT NULL,
    CheckedBy int NULL CONSTRAINT FK_CommitteeIntegrityEvents_Member REFERENCES dbo.CommitteeMembers(MemberId),
    NoteCipher varbinary(max) NULL,
    NotificationId bigint NULL CONSTRAINT FK_CommitteeIntegrityEvents_Notification REFERENCES dbo.ResidentNotifications(NotificationId),
    EmailSentAt datetime2(0) NULL,
    EmailError nvarchar(500) NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeIntegrityEvents_CreatedAt DEFAULT SYSUTCDATETIME());
  CREATE INDEX IX_CommitteeIntegrityEvents_Record ON dbo.CommitteeIntegrityEvents(RecordNo,CreatedAt DESC);
END;

IF COL_LENGTH(N'dbo.CommitteeIntegrityEvents',N'OriginalObservedAudioSha256') IS NULL
  ALTER TABLE dbo.CommitteeIntegrityEvents ADD OriginalObservedAudioSha256 char(64) NULL;
UPDATE e SET OriginalObservedAudioSha256=CONVERT(char(64),HASHBYTES('SHA2_256',r.AudioData),2)
FROM dbo.CommitteeIntegrityEvents e JOIN dbo.NoiseRecordings r ON r.RecordNo=e.RecordNo
WHERE e.OriginalObservedAudioSha256 IS NULL;
ALTER TABLE dbo.CommitteeIntegrityEvents ALTER COLUMN OriginalObservedAudioSha256 char(64) NOT NULL;

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetCommitteeApplicationForReview
  @ApplicationId bigint,
  @MemberDataKey nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT ApplicationId,KaptCode,RequestedRole,
    dbo.DecryptMemberData(EmailCipher,@MemberDataKey) AS Email,
    dbo.DecryptMemberData(MemberCipher,@MemberDataKey) AS MemberJson,DocumentCipher,
    DocumentSha256,ConsentedAt,SubmittedAt
  FROM dbo.CommitteeApplications
  WHERE ApplicationId=@ApplicationId AND Status=''PENDING'';
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ApproveCommitteeApplication
  @ApplicationId bigint,
  @ReviewedDocumentSha256 char(64),
  @ReviewNote nvarchar(1000)=NULL
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  BEGIN TRANSACTION;
  DECLARE @reviewerLogin sysname=COALESCE(NULLIF(ORIGINAL_LOGIN(),N''''),NULLIF(SUSER_SNAME(),N''''));
  IF @reviewerLogin IS NULL THROW 51063,''Authenticated reviewer login is required.'',1;
  DECLARE @lock int,@complexLock int,@kaptCode varchar(50),@role nvarchar(10),@status varchar(12),
    @loginHash char(64),@emailHash char(64),@mobileHash char(64),@emailCipher varbinary(max),
    @memberCipher varbinary(max),@documentCipher varbinary(max),@documentSha256 char(64),
    @passwordHash varchar(100),@consentedAt datetime2(0),@seat tinyint,@memberId int;
  EXEC @lock=sp_getapplock @Resource=N''MuteLab.Committee.Identity'',@LockMode=''Exclusive'',@LockOwner=''Transaction'';
  IF @lock<0 THROW 51060,''Committee identity lock failed.'',1;
  SELECT @kaptCode=KaptCode,@role=RequestedRole,@status=Status,@loginHash=LoginHash,@emailHash=EmailHash,
    @mobileHash=MobileHash,@emailCipher=EmailCipher,@memberCipher=MemberCipher,@documentCipher=DocumentCipher,
    @documentSha256=DocumentSha256,@passwordHash=PasswordHash,@consentedAt=ConsentedAt
  FROM dbo.CommitteeApplications WITH(UPDLOCK,HOLDLOCK) WHERE ApplicationId=@ApplicationId;
  IF @status IS NULL THROW 51061,''Committee application not found.'',1;
  IF @status<>''PENDING'' THROW 51062,''Committee application already reviewed.'',1;
  IF @ReviewedDocumentSha256 IS NULL OR @ReviewedDocumentSha256<>@documentSha256
    THROW 51064,''Reviewed document hash does not match.'',1;
  DECLARE @resource nvarchar(100)=N''MuteLab.Committee.''+@kaptCode;
  EXEC @complexLock=sp_getapplock @Resource=@resource,@LockMode=''Exclusive'',@LockOwner=''Transaction'';
  IF @complexLock<0 THROW 51065,''Committee complex lock failed.'',1;
  IF NOT EXISTS(SELECT 1 FROM dbo.AptComplexWithDetail WHERE kaptCode=@kaptCode)
    THROW 51066,''Unknown apartment.'',1;
  IF EXISTS(SELECT 1 FROM dbo.CommitteeMembers
    WHERE LoginHash=@loginHash OR EmailHash=@emailHash OR MobileHash=@mobileHash)
    THROW 51067,''Committee identity already registered.'',1;
  IF @role=N''위원장'' AND EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Role=N''위원장'')
    THROW 51068,''Committee chair already exists.'',1;
  SELECT TOP(1) @seat=v.seat FROM (VALUES(1),(2),(3)) v(seat)
  WHERE NOT EXISTS(SELECT 1 FROM dbo.CommitteeMembers WHERE KaptCode=@kaptCode AND Seat=v.seat)
  ORDER BY v.seat;
  IF @seat IS NULL THROW 51069,''Committee is full.'',1;
  INSERT dbo.CommitteeMembers(KaptCode,Seat,Role,LoginHash,EmailHash,MobileHash,EmailCipher,
    MemberCipher,DocumentCipher,PasswordHash,ApprovedAt,ConsentedAt)
  VALUES(@kaptCode,@seat,@role,@loginHash,@emailHash,@mobileHash,@emailCipher,
    @memberCipher,@documentCipher,@passwordHash,SYSUTCDATETIME(),@consentedAt);
  SET @memberId=CONVERT(int,SCOPE_IDENTITY());
  UPDATE dbo.CommitteeApplications SET Status=''APPROVED'',ApprovedMemberId=@memberId,
    Reviewer=@reviewerLogin,ReviewedDocumentSha256=@ReviewedDocumentSha256,
    ReviewNote=NULLIF(LTRIM(RTRIM(@ReviewNote)),N''''),ReviewedAt=SYSUTCDATETIME()
  WHERE ApplicationId=@ApplicationId;
  COMMIT TRANSACTION;
  SELECT @ApplicationId AS ApplicationId,@memberId AS MemberId,@kaptCode AS KaptCode,@seat AS Seat,
    @role AS Role,@reviewerLogin AS Reviewer;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.RejectCommitteeApplication
  @ApplicationId bigint,
  @ReviewNote nvarchar(1000)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  DECLARE @reviewerLogin sysname=COALESCE(NULLIF(ORIGINAL_LOGIN(),N''''),NULLIF(SUSER_SNAME(),N''''));
  IF @reviewerLogin IS NULL THROW 51063,''Authenticated reviewer login is required.'',1;
  IF NULLIF(LTRIM(RTRIM(@ReviewNote)),N'''') IS NULL OR LEN(@ReviewNote)>1000
    THROW 51070,''Rejection reason is required.'',1;
  BEGIN TRANSACTION;
  DECLARE @lock int;
  EXEC @lock=sp_getapplock @Resource=N''MuteLab.Committee.Identity'',@LockMode=''Exclusive'',@LockOwner=''Transaction'';
  IF @lock<0 THROW 51060,''Committee identity lock failed.'',1;
  UPDATE dbo.CommitteeApplications WITH(UPDLOCK,HOLDLOCK)
  SET Status=''REJECTED'',Reviewer=@reviewerLogin,ReviewNote=LTRIM(RTRIM(@ReviewNote)),
    ReviewedAt=SYSUTCDATETIME(),ReviewedDocumentSha256=NULL
  WHERE ApplicationId=@ApplicationId AND Status=''PENDING'';
  IF @@ROWCOUNT<>1 THROW 51061,''Pending committee application not found.'',1;
  COMMIT TRANSACTION;
  SELECT @ApplicationId AS ApplicationId,CAST(''REJECTED'' AS varchar(12)) AS Status,
    @reviewerLogin AS Reviewer;
END;');

EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_CommitteeSubmissionArtifacts_InsertOnly
ON dbo.CommitteeSubmissionArtifacts INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM inserted)
    THROW 51053, ''Committee submission audio artifacts are insert-only.'', 1;
  IF EXISTS(SELECT 1 FROM deleted d JOIN dbo.CommitteeSubmissionArtifactBindings b ON b.ArtifactId=d.ArtifactId)
    THROW 51053, ''Bound committee submission audio artifacts are immutable.'', 1;
  DELETE a FROM dbo.CommitteeSubmissionArtifacts a JOIN deleted d ON d.ArtifactId=a.ArtifactId;
END;');

EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_CommitteeSubmissionArtifacts_ValidateInsert
ON dbo.CommitteeSubmissionArtifacts AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM inserted
    WHERE AudioLength<>DATALENGTH(AudioData)
      OR AudioSha256<>CONVERT(char(64),HASHBYTES(''SHA2_256'',AudioData),2))
    THROW 51058,''Committee submission audio hash or length is invalid.'',1;
END;');

EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_ValidateInsert
ON dbo.NoiseRecordings AFTER INSERT AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM inserted
    WHERE AudioLength<>DATALENGTH(AudioData)
      OR AudioSha256<>CONVERT(char(64),HASHBYTES(''SHA2_256'',AudioData),2))
    THROW 51011,''Noise recording hash or length is invalid.'',1;
END;');

EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_CommitteeSubmissions_IntegrityGuard
ON dbo.CommitteeSubmissions AFTER INSERT, UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM inserted i
    JOIN dbo.CommitteeSubmissionArtifacts a ON a.ArtifactId=i.SubmissionArtifactId
    JOIN dbo.NoiseRecordings r ON r.RecordNo=i.RecordNo AND r.UserId=i.UserId
    WHERE i.IntegrityStatus=''VERIFIED'' AND (a.ArtifactSource<>''UPLOAD''
      OR a.RecordNo<>i.RecordNo OR a.UserId<>i.UserId
      OR i.SubmittedAudioSha256<>a.AudioSha256 OR i.ObservedAudioSha256<>a.AudioSha256
      OR i.ExpectedAudioSha256<>r.AudioSha256 OR a.AudioSha256<>r.AudioSha256))
    THROW 51057, ''Invalid verified committee submission state.'', 1;
  IF UPDATE(SubmissionArtifactId)
    UPDATE s SET IntegrityStatus=''PENDING'',IntegrityCheckedAt=NULL,
      IntegrityResolvedAt=NULL,IntegrityResolvedBy=NULL,IntegrityResolutionCipher=NULL
    FROM dbo.CommitteeSubmissions s
    JOIN inserted i ON i.RecordNo=s.RecordNo
    LEFT JOIN deleted d ON d.RecordNo=i.RecordNo
    WHERE d.RecordNo IS NOT NULL AND i.SubmissionArtifactId<>d.SubmissionArtifactId;
END;');

EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_CommitteeSubmissions_ArtifactTransition
ON dbo.CommitteeSubmissions AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF UPDATE(SubmissionArtifactId) AND EXISTS(
    SELECT 1 FROM inserted i JOIN deleted d ON d.RecordNo=i.RecordNo
    WHERE i.SubmissionArtifactId<>d.SubmissionArtifactId
      AND (i.IntegrityStatus<>''PENDING'' OR i.IntegrityCheckedAt IS NOT NULL
        OR i.IntegrityResolvedAt IS NOT NULL OR i.IntegrityResolvedBy IS NOT NULL
        OR i.IntegrityResolutionCipher IS NOT NULL))
    THROW 51057,''Changing a committee audio artifact must reset integrity state.'',1;
END;');

IF DATABASE_PRINCIPAL_ID(N'MuteLabCommitteeApproverRole') IS NULL
  CREATE ROLE MuteLabCommitteeApproverRole AUTHORIZATION dbo;

IF DATABASE_PRINCIPAL_ID(N'MuteLabApiRole') IS NOT NULL
BEGIN
  REVOKE SELECT,INSERT,UPDATE,DELETE ON OBJECT::dbo.CommitteeMembers FROM MuteLabApiRole;
  GRANT SELECT (MemberId,KaptCode,Seat,Role,LoginHash,EmailHash,MobileHash,EmailCipher,
    MemberCipher,PasswordHash,ApprovedAt,ConsentedAt,CreatedAt) ON OBJECT::dbo.CommitteeMembers TO MuteLabApiRole;
  REVOKE UPDATE,DELETE ON OBJECT::dbo.CommitteeApplications FROM MuteLabApiRole;
  GRANT INSERT ON OBJECT::dbo.CommitteeApplications TO MuteLabApiRole;
  GRANT SELECT (ApplicationId,KaptCode,RequestedRole,LoginHash,EmailHash,MobileHash,PasswordHash,Status,ReviewNote)
    ON OBJECT::dbo.CommitteeApplications TO MuteLabApiRole;
  DENY EXECUTE ON OBJECT::dbo.GetCommitteeApplicationForReview TO MuteLabApiRole;
  DENY EXECUTE ON OBJECT::dbo.ApproveCommitteeApplication TO MuteLabApiRole;
  DENY EXECUTE ON OBJECT::dbo.RejectCommitteeApplication TO MuteLabApiRole;
  GRANT SELECT,INSERT,UPDATE,DELETE ON OBJECT::dbo.CommitteeLoginCodes TO MuteLabApiRole;
  REVOKE DELETE ON OBJECT::dbo.CommitteeSubmissions FROM MuteLabApiRole;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.CommitteeSubmissions TO MuteLabApiRole;
  REVOKE UPDATE ON OBJECT::dbo.CommitteeSubmissionArtifacts FROM MuteLabApiRole;
  GRANT SELECT,INSERT,DELETE ON OBJECT::dbo.CommitteeSubmissionArtifacts TO MuteLabApiRole;
  GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeSubmissionArtifactBindings TO MuteLabApiRole;
  GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.CommitteeCounterpartOverrides TO MuteLabApiRole;
  GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeCounterpartHistory TO MuteLabApiRole;
  REVOKE UPDATE,DELETE ON OBJECT::dbo.ResidentNotifications FROM MuteLabApiRole;
  GRANT SELECT,INSERT ON OBJECT::dbo.ResidentNotifications TO MuteLabApiRole;
  GRANT UPDATE (ReadAt,EmailClaimedAt,EmailSentAt,EmailError,EmailAttempts,EmailNextAttemptAt)
    ON OBJECT::dbo.ResidentNotifications TO MuteLabApiRole;
  REVOKE UPDATE,DELETE ON OBJECT::dbo.CommitteeIntegrityEvents FROM MuteLabApiRole;
  GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeIntegrityEvents TO MuteLabApiRole;
  GRANT UPDATE (EmailSentAt,EmailError) ON OBJECT::dbo.CommitteeIntegrityEvents TO MuteLabApiRole;
END;

GRANT EXECUTE ON OBJECT::dbo.GetCommitteeApplicationForReview TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.ApproveCommitteeApplication TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.RejectCommitteeApplication TO MuteLabCommitteeApproverRole;

COMMIT TRANSACTION;
