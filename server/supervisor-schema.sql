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

IF OBJECT_ID(N'dbo.CommitteeDecisionNotifications',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeDecisionNotifications(
    NotificationId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeDecisionNotifications PRIMARY KEY,
    ApplicationId bigint NOT NULL CONSTRAINT FK_CommitteeDecisionNotifications_Application
      REFERENCES dbo.CommitteeApplications(ApplicationId),
    ApprovedMemberId int NULL CONSTRAINT FK_CommitteeDecisionNotifications_Member
      REFERENCES dbo.CommitteeMembers(MemberId),
    KaptCode varchar(50) NOT NULL,
    Decision varchar(12) NOT NULL CONSTRAINT CK_CommitteeDecisionNotifications_Decision
      CHECK(Decision IN('APPROVED','REJECTED')),
    RecipientEmailCipher varbinary(max) NOT NULL,
    RecipientEmailHash char(64) NOT NULL,
    Title nvarchar(200) NOT NULL,
    MessageCipher varbinary(max) NOT NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_CommitteeDecisionNotifications_CreatedAt DEFAULT SYSUTCDATETIME(),
    ReadAt datetime2(0) NULL,
    EmailClaimedAt datetime2(0) NULL,
    EmailSentAt datetime2(0) NULL,
    EmailError nvarchar(500) NULL,
    EmailAttempts int NOT NULL CONSTRAINT DF_CommitteeDecisionNotifications_EmailAttempts DEFAULT 0,
    EmailNextAttemptAt datetime2(0) NULL,
    CONSTRAINT UQ_CommitteeDecisionNotifications_ApplicationRecipient UNIQUE(ApplicationId,RecipientEmailHash));
  CREATE INDEX IX_CommitteeDecisionNotifications_EmailQueue
    ON dbo.CommitteeDecisionNotifications(EmailSentAt,EmailNextAttemptAt,CreatedAt,NotificationId);
  CREATE INDEX IX_CommitteeDecisionNotifications_Member
    ON dbo.CommitteeDecisionNotifications(ApprovedMemberId,ReadAt,CreatedAt DESC);
END;

IF OBJECT_ID(N'dbo.SupervisorDecisionAudit',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.SupervisorDecisionAudit(
    AuditId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_SupervisorDecisionAudit PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    Decision varchar(12) NOT NULL CONSTRAINT CK_SupervisorDecisionAudit_Decision
      CHECK(Decision IN('APPROVED','REJECTED')),
    ApplicationCount int NOT NULL CONSTRAINT CK_SupervisorDecisionAudit_Count CHECK(ApplicationCount BETWEEN 1 AND 50),
    Reviewer nvarchar(128) NOT NULL,
    RemoteAddress nvarchar(100) NOT NULL,
    UserAgent nvarchar(500) NULL,
    ReasonCipher varbinary(max) NULL,
    CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_SupervisorDecisionAudit_CreatedAt DEFAULT SYSUTCDATETIME());
  CREATE INDEX IX_SupervisorDecisionAudit_Complex ON dbo.SupervisorDecisionAudit(KaptCode,CreatedAt DESC);
END;

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ListSupervisorComplexes
  @Search nvarchar(100)=N'''', @Status varchar(16)=''ALL'', @Page int=1, @PageSize int=50
AS
BEGIN
  SET NOCOUNT ON;
  SET @Search=LTRIM(RTRIM(COALESCE(@Search,N'''')));
  SET @Status=UPPER(COALESCE(@Status,''ALL''));
  IF @Status NOT IN(''ALL'',''JOINED'',''UNJOINED'',''UNREGISTERED'',''PENDING'',''APPROVED'',''REJECTED'')
    THROW 51100,''Invalid supervisor complex status.'',1;
  IF @Status=''UNREGISTERED'' SET @Status=''UNJOINED'';
  IF @Page<1 OR @PageSize<1 OR @PageSize>100 THROW 51101,''Invalid supervisor pagination.'',1;
  SELECT c.kaptCode AS KaptCode,c.kaptName AS KaptName,
    COALESCE(NULLIF(c.roadAddress,N''''),NULLIF(c.address,N''''),NULLIF(c.legalAddress,N''''),
      NULLIF(CONCAT_WS(N'' '',c.sido,c.sigungu),N'''')) AS Address,
    COALESCE(m.ApprovedMemberCount,0) AS ApprovedMemberCount,COALESCE(m.ChairCount,0) AS ChairCount,
    COALESCE(a.PendingApplicationCount,0) AS PendingApplicationCount,
    COALESCE(a.RejectedApplicationCount,0) AS RejectedApplicationCount,
    a.FirstSubmittedAt,a.LastReviewedAt,
    CAST(CASE WHEN COALESCE(a.PendingApplicationCount,0)>0 THEN ''PENDING''
      WHEN COALESCE(m.ApprovedMemberCount,0)>0 THEN ''APPROVED''
      WHEN COALESCE(a.RejectedApplicationCount,0)>0 THEN ''REJECTED'' ELSE ''UNREGISTERED'' END AS varchar(12)) AS CommitteeStatus
  INTO #ComplexStats
  FROM dbo.AptComplexWithDetail c
  LEFT JOIN (SELECT KaptCode,COUNT_BIG(*) AS ApprovedMemberCount,
      SUM(CASE WHEN Role=N''위원장'' THEN 1 ELSE 0 END) AS ChairCount
    FROM dbo.CommitteeMembers GROUP BY KaptCode) m ON m.KaptCode=c.kaptCode
  LEFT JOIN (SELECT KaptCode,
      SUM(CASE WHEN Status=''PENDING'' THEN 1 ELSE 0 END) AS PendingApplicationCount,
      SUM(CASE WHEN Status=''REJECTED'' THEN 1 ELSE 0 END) AS RejectedApplicationCount,
      MIN(SubmittedAt) AS FirstSubmittedAt,MAX(ReviewedAt) AS LastReviewedAt
    FROM dbo.CommitteeApplications GROUP BY KaptCode) a ON a.KaptCode=c.kaptCode;
  SELECT COUNT_BIG(*) AS TotalComplexes,
    SUM(CASE WHEN ApprovedMemberCount>0 OR PendingApplicationCount>0 THEN 1 ELSE 0 END) AS RegisteredComplexes,
    SUM(CASE WHEN PendingApplicationCount>0 THEN 1 ELSE 0 END) AS PendingComplexes,
    SUM(CASE WHEN ApprovedMemberCount>0 THEN 1 ELSE 0 END) AS ApprovedComplexes,
    SUM(CASE WHEN ApprovedMemberCount=0 AND PendingApplicationCount=0 THEN 1 ELSE 0 END) AS UnregisteredComplexes,
    SUM(CASE WHEN ApprovedMemberCount=0 AND PendingApplicationCount=0 AND RejectedApplicationCount>0 THEN 1 ELSE 0 END) AS RejectedComplexes
  FROM #ComplexStats;
  DECLARE @escaped nvarchar(400)=REPLACE(REPLACE(REPLACE(REPLACE(@Search,N''~'',N''~~''),N''%'',N''~%''),N''_'',N''~_''),N''['',N''~['');
  SELECT COUNT_BIG(*) OVER() AS TotalRows,KaptCode,KaptName,Address,ApprovedMemberCount,ChairCount,
    PendingApplicationCount,RejectedApplicationCount,FirstSubmittedAt,LastReviewedAt,CommitteeStatus
  FROM #ComplexStats
  WHERE (@Search=N'''' OR KaptCode LIKE N''%''+@escaped+N''%'' ESCAPE N''~''
      OR KaptName LIKE N''%''+@escaped+N''%'' ESCAPE N''~'' OR Address LIKE N''%''+@escaped+N''%'' ESCAPE N''~'')
    AND (@Status=''ALL'' OR (@Status=''JOINED'' AND (ApprovedMemberCount>0 OR PendingApplicationCount>0))
      OR (@Status=''UNJOINED'' AND ApprovedMemberCount=0 AND PendingApplicationCount=0)
      OR (@Status=''PENDING'' AND PendingApplicationCount>0) OR (@Status=''APPROVED'' AND ApprovedMemberCount>0)
      OR (@Status=''REJECTED'' AND ApprovedMemberCount=0 AND PendingApplicationCount=0 AND RejectedApplicationCount>0))
  ORDER BY CASE CommitteeStatus WHEN ''PENDING'' THEN 0 WHEN ''APPROVED'' THEN 1 WHEN ''REJECTED'' THEN 2 ELSE 3 END,KaptName,KaptCode
  OFFSET (@Page-1)*@PageSize ROWS FETCH NEXT @PageSize ROWS ONLY;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetSupervisorComplexDetails
  @KaptCode varchar(50), @MemberDataKey nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT TOP(1) kaptCode AS KaptCode,kaptName AS KaptName,
    COALESCE(NULLIF(roadAddress,N''''),NULLIF(address,N''''),NULLIF(legalAddress,N''''),
      NULLIF(CONCAT_WS(N'' '',sido,sigungu),N'''')) AS Address
  FROM dbo.AptComplexWithDetail WHERE kaptCode=@KaptCode;
  SELECT MemberId,Seat,Role,dbo.DecryptMemberData(EmailCipher,@MemberDataKey) AS Email,
    dbo.DecryptMemberData(MemberCipher,@MemberDataKey) AS MemberJson,ApprovedAt,ConsentedAt
  FROM dbo.CommitteeMembers WHERE KaptCode=@KaptCode ORDER BY Seat,MemberId;
  SELECT ApplicationId,RequestedRole,Status,dbo.DecryptMemberData(EmailCipher,@MemberDataKey) AS Email,
    dbo.DecryptMemberData(MemberCipher,@MemberDataKey) AS MemberJson,DocumentSha256,SubmittedAt,
    ReviewedAt,ReviewNote,ApprovedMemberId
  FROM dbo.CommitteeApplications WHERE KaptCode=@KaptCode
  ORDER BY CASE Status WHEN ''PENDING'' THEN 0 WHEN ''APPROVED'' THEN 1 ELSE 2 END,SubmittedAt,ApplicationId;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetSupervisorPendingApplications @KaptCode varchar(50) AS
BEGIN SET NOCOUNT ON;
  IF @@TRANCOUNT=0 THROW 51105,''Supervisor decision transaction is required.'',1;
  DECLARE @identityLock int,@complexLock int,@resource nvarchar(100)=N''MuteLab.Committee.''+@KaptCode;
  EXEC @identityLock=sp_getapplock @Resource=N''MuteLab.Committee.Identity'',@LockMode=''Exclusive'',@LockOwner=''Transaction'';
  IF @identityLock<0 THROW 51060,''Committee identity lock failed.'',1;
  EXEC @complexLock=sp_getapplock @Resource=@resource,@LockMode=''Exclusive'',@LockOwner=''Transaction'';
  IF @complexLock<0 THROW 51065,''Committee complex lock failed.'',1;
  SELECT ApplicationId,DocumentSha256 FROM dbo.CommitteeApplications WITH(UPDLOCK,HOLDLOCK)
  WHERE KaptCode=@KaptCode AND Status=''PENDING'' ORDER BY SubmittedAt,ApplicationId;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.EnqueueCommitteeDecisionNotification
  @ApplicationId bigint, @MemberDataKey nvarchar(128),
  @NotifyExistingMembers bit=0, @ApplicationCount int=1
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @status varchar(12),@memberId int,@kaptCode varchar(50),@emailCipher varbinary(max),@emailHash char(64),
    @reason nvarchar(1000),@title nvarchar(200),@message nvarchar(max),@type varchar(40),
    @groupTitle nvarchar(200),@groupMessage nvarchar(max),@createdCount int=0;
  DECLARE @createdRecipients TABLE(EmailHash char(64) NOT NULL,Title nvarchar(200) NOT NULL,MessageCipher varbinary(max) NOT NULL);
  IF @ApplicationCount<1 OR @ApplicationCount>50 THROW 51106,''Invalid committee notification recipient count.'',1;
  SELECT @status=Status,@memberId=ApprovedMemberId,@kaptCode=KaptCode,@emailCipher=EmailCipher,
    @emailHash=EmailHash,@reason=ReviewNote FROM dbo.CommitteeApplications WITH(UPDLOCK,HOLDLOCK) WHERE ApplicationId=@ApplicationId;
  IF @status NOT IN(''APPROVED'',''REJECTED'') THROW 51102,''Reviewed committee application is required.'',1;
  IF @status=''APPROVED''
  BEGIN SET @title=N''위원회 가입 신청 승인'';
    SET @message=N''층간소음관리위원회 가입 신청이 승인되었습니다. 이제 위원회 페이지에서 로그인할 수 있습니다.'';
    SET @type=''COMMITTEE_APPLICATION_APPROVED'';
    SET @groupTitle=N''위원회 구성 승인 안내'';
    SET @groupMessage=N''해당 단지의 위원회 가입 신청 ''+CONVERT(nvarchar(10),@ApplicationCount)+N''건이 승인되어 위원회 구성이 변경되었습니다.''; END
  ELSE
  BEGIN SET @title=N''위원회 가입 신청 반려'';
    SET @message=N''층간소음관리위원회 가입 신청이 반려되었습니다. 사유: ''+COALESCE(NULLIF(@reason,N''''),N''사유 없음'');
    SET @type=''COMMITTEE_APPLICATION_REJECTED'';
    SET @groupTitle=N''위원회 신청 반려 안내'';
    SET @groupMessage=N''해당 단지의 위원회 가입 신청 ''+CONVERT(nvarchar(10),@ApplicationCount)
      +N''건이 반려되었습니다. 사유: ''+COALESCE(NULLIF(@reason,N''''),N''사유 없음''); END;

  IF NOT EXISTS(SELECT 1 FROM dbo.CommitteeDecisionNotifications WITH(UPDLOCK,HOLDLOCK)
    WHERE ApplicationId=@ApplicationId AND RecipientEmailHash=@emailHash)
  BEGIN
    INSERT dbo.CommitteeDecisionNotifications(ApplicationId,ApprovedMemberId,KaptCode,Decision,
      RecipientEmailCipher,RecipientEmailHash,Title,MessageCipher)
    OUTPUT inserted.RecipientEmailHash,inserted.Title,inserted.MessageCipher
      INTO @createdRecipients(EmailHash,Title,MessageCipher)
    VALUES(@ApplicationId,@memberId,@kaptCode,@status,@emailCipher,@emailHash,@title,
      dbo.EncryptMemberData(@message,@MemberDataKey));
  END;

  IF @NotifyExistingMembers=1
  BEGIN
    INSERT dbo.CommitteeDecisionNotifications(ApplicationId,ApprovedMemberId,KaptCode,Decision,
      RecipientEmailCipher,RecipientEmailHash,Title,MessageCipher)
    OUTPUT inserted.RecipientEmailHash,inserted.Title,inserted.MessageCipher
      INTO @createdRecipients(EmailHash,Title,MessageCipher)
    SELECT @ApplicationId,m.MemberId,@kaptCode,@status,m.EmailCipher,m.EmailHash,@groupTitle,
      dbo.EncryptMemberData(@groupMessage,@MemberDataKey)
    FROM dbo.CommitteeMembers m
    WHERE m.KaptCode=@kaptCode AND m.EmailHash<>@emailHash
      AND NOT EXISTS(SELECT 1 FROM dbo.CommitteeDecisionNotifications n WITH(UPDLOCK,HOLDLOCK)
        WHERE n.ApplicationId=@ApplicationId AND n.RecipientEmailHash=m.EmailHash);
  END;

  INSERT dbo.ResidentNotifications(UserId,NotificationType,Title,MessageCipher)
  SELECT u.UserId,@type,c.Title,c.MessageCipher FROM @createdRecipients c JOIN dbo.AppUsers u ON u.EmailHash=c.EmailHash;
  SELECT @createdCount=COUNT(*) FROM @createdRecipients;
  SELECT @createdCount AS CreatedCount,@status AS Decision,@memberId AS ApprovedMemberId;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.RecordSupervisorDecisionAudit
  @KaptCode varchar(50),@Decision varchar(12),@ApplicationCount int,@RemoteAddress nvarchar(100),
  @UserAgent nvarchar(500)=NULL,@Reason nvarchar(1000)=NULL,@MemberDataKey nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @reviewer sysname=COALESCE(NULLIF(ORIGINAL_LOGIN(),N''''),NULLIF(SUSER_SNAME(),N''''));
  IF @reviewer IS NULL THROW 51063,''Authenticated reviewer login is required.'',1;
  IF @Decision NOT IN(''APPROVED'',''REJECTED'') OR @ApplicationCount<1 OR @ApplicationCount>50
    THROW 51103,''Invalid supervisor audit decision.'',1;
  INSERT dbo.SupervisorDecisionAudit(KaptCode,Decision,ApplicationCount,Reviewer,RemoteAddress,UserAgent,ReasonCipher)
  VALUES(@KaptCode,@Decision,@ApplicationCount,@reviewer,LEFT(COALESCE(@RemoteAddress,N''unknown''),100),LEFT(@UserAgent,500),
    CASE WHEN NULLIF(LTRIM(RTRIM(@Reason)),N'''') IS NULL THEN NULL ELSE dbo.EncryptMemberData(LEFT(@Reason,1000),@MemberDataKey) END);
  SELECT CONVERT(bigint,SCOPE_IDENTITY()) AS AuditId;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ClaimCommitteeDecisionEmail @MemberDataKey nvarchar(128) AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON; BEGIN TRANSACTION;
  DECLARE @id bigint,@now datetime2(0)=SYSUTCDATETIME();
  SELECT TOP(1) @id=NotificationId FROM dbo.CommitteeDecisionNotifications WITH(UPDLOCK,READPAST,ROWLOCK)
  WHERE EmailSentAt IS NULL AND EmailAttempts<8 AND (EmailClaimedAt IS NULL OR EmailClaimedAt<DATEADD(minute,-10,@now))
    AND (EmailNextAttemptAt IS NULL OR EmailNextAttemptAt<=@now) ORDER BY CreatedAt,NotificationId;
  IF @id IS NOT NULL
  BEGIN
    UPDATE dbo.CommitteeDecisionNotifications SET EmailClaimedAt=@now,EmailAttempts=EmailAttempts+1 WHERE NotificationId=@id;
    SELECT n.NotificationId,n.ApplicationId,n.Decision,n.Title,dbo.DecryptMemberData(n.MessageCipher,@MemberDataKey) AS Message,
      dbo.DecryptMemberData(n.RecipientEmailCipher,@MemberDataKey) AS Email,n.EmailAttempts,c.kaptName AS KaptName
    FROM dbo.CommitteeDecisionNotifications n LEFT JOIN dbo.AptComplexWithDetail c ON c.kaptCode=n.KaptCode WHERE n.NotificationId=@id;
  END;
  COMMIT TRANSACTION;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.CompleteCommitteeDecisionEmail
  @NotificationId bigint,@Succeeded bit,@Error nvarchar(500)=NULL,@DelayMinutes int=NULL
AS
BEGIN
  SET NOCOUNT ON;
  IF @Succeeded=1
    UPDATE dbo.CommitteeDecisionNotifications SET EmailSentAt=SYSUTCDATETIME(),EmailClaimedAt=NULL,EmailError=NULL,EmailNextAttemptAt=NULL
    WHERE NotificationId=@NotificationId AND EmailSentAt IS NULL;
  ELSE
    UPDATE dbo.CommitteeDecisionNotifications SET EmailClaimedAt=NULL,EmailError=LEFT(COALESCE(@Error,N''메일 발송 실패''),500),
      EmailNextAttemptAt=DATEADD(minute,CASE WHEN @DelayMinutes BETWEEN 1 AND 360 THEN @DelayMinutes
        WHEN EmailAttempts>=6 THEN 360 ELSE CONVERT(int,POWER(CONVERT(float,2),EmailAttempts)) END,SYSUTCDATETIME())
    WHERE NotificationId=@NotificationId AND EmailSentAt IS NULL;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetCommitteeDecisionNotifications @MemberId int,@MemberDataKey nvarchar(128) AS
BEGIN SET NOCOUNT ON;
  SELECT TOP(50) NotificationId,Decision,Title,dbo.DecryptMemberData(MessageCipher,@MemberDataKey) AS Message,CreatedAt,ReadAt
  FROM dbo.CommitteeDecisionNotifications WHERE ApprovedMemberId=@MemberId ORDER BY CreatedAt DESC,NotificationId DESC;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ReadCommitteeDecisionNotification @MemberId int,@NotificationId bigint AS
BEGIN SET NOCOUNT ON;
  UPDATE dbo.CommitteeDecisionNotifications SET ReadAt=COALESCE(ReadAt,SYSUTCDATETIME())
  WHERE NotificationId=@NotificationId AND ApprovedMemberId=@MemberId;
  DECLARE @updated int=@@ROWCOUNT;
  SELECT @updated AS Updated;
END;');

IF DATABASE_PRINCIPAL_ID(N'MuteLabCommitteeApproverRole') IS NULL CREATE ROLE MuteLabCommitteeApproverRole AUTHORIZATION dbo;
GRANT EXECUTE ON OBJECT::dbo.ListSupervisorComplexes TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.GetSupervisorComplexDetails TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.GetSupervisorPendingApplications TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.EnqueueCommitteeDecisionNotification TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.RecordSupervisorDecisionAudit TO MuteLabCommitteeApproverRole;

IF DATABASE_PRINCIPAL_ID(N'MuteLabApiRole') IS NOT NULL
BEGIN
  GRANT SELECT (KaptCode,RequestedRole,ReviewNote) ON OBJECT::dbo.CommitteeApplications TO MuteLabApiRole;
  GRANT EXECUTE ON OBJECT::dbo.ClaimCommitteeDecisionEmail TO MuteLabApiRole;
  GRANT EXECUTE ON OBJECT::dbo.CompleteCommitteeDecisionEmail TO MuteLabApiRole;
  GRANT EXECUTE ON OBJECT::dbo.GetCommitteeDecisionNotifications TO MuteLabApiRole;
  GRANT EXECUTE ON OBJECT::dbo.ReadCommitteeDecisionNotification TO MuteLabApiRole;
END;

COMMIT TRANSACTION;
