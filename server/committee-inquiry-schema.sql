SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeInquiries',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeInquiries (
    InquiryId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeInquiries PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    MemberId int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    QuestionCipher varbinary(max) NOT NULL,
    AttachmentCipher varbinary(max) NULL,
    AttachmentType varchar(24) NULL,
    CreatedAt datetime2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
    ReplyCipher varbinary(max) NULL,
    RepliedAt datetime2(3) NULL,
    ReplyReadAt datetime2(3) NULL
  );
  CREATE INDEX IX_CommitteeInquiries_Complex ON dbo.CommitteeInquiries(KaptCode, InquiryId DESC);
  CREATE INDEX IX_CommitteeInquiries_Member ON dbo.CommitteeInquiries(MemberId, RepliedAt DESC);
END;

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ListSupervisorInquiries @MemberDataKey nvarchar(128), @InquiryId int=NULL AS
BEGIN
  SET NOCOUNT ON;
  SELECT TOP (100) i.InquiryId,i.KaptCode,a.kaptName AS ComplexName,i.CreatedAt,i.RepliedAt,i.AttachmentType,
    dbo.DecryptMemberData(i.QuestionCipher,@MemberDataKey) AS Question,
    dbo.DecryptMemberData(i.ReplyCipher,@MemberDataKey) AS Reply
  FROM dbo.CommitteeInquiries i LEFT JOIN dbo.AptComplexWithDetail a ON a.kaptCode=i.KaptCode
  WHERE @InquiryId IS NULL OR i.InquiryId=@InquiryId
  ORDER BY CASE WHEN i.RepliedAt IS NULL THEN 0 ELSE 1 END,i.InquiryId DESC;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.ReplySupervisorInquiry
  @InquiryId int, @Reply nvarchar(2000), @MemberDataKey nvarchar(128) AS
BEGIN
  SET NOCOUNT ON;
  UPDATE dbo.CommitteeInquiries SET ReplyCipher=dbo.EncryptMemberData(@Reply,@MemberDataKey),RepliedAt=SYSUTCDATETIME()
  WHERE InquiryId=@InquiryId AND RepliedAt IS NULL;
  SELECT @@ROWCOUNT AS Updated;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetSupervisorInquiryAttachment @InquiryId int AS
BEGIN
  SET NOCOUNT ON;
  SELECT AttachmentCipher,AttachmentType FROM dbo.CommitteeInquiries WHERE InquiryId=@InquiryId;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetCommitteeDecisionNotifications @MemberId int,@MemberDataKey nvarchar(128),@CountOnly bit=0 AS
BEGIN SET NOCOUNT ON;
  IF @CountOnly=1
  BEGIN
    SELECT COUNT(*) AS UnreadCount FROM dbo.CommitteeDecisionNotifications WHERE ApprovedMemberId=@MemberId AND ReadAt IS NULL;
    RETURN;
  END;
  SELECT TOP(50) NotificationId,Decision,Title,dbo.DecryptMemberData(MessageCipher,@MemberDataKey) AS Message,CreatedAt,ReadAt,
    COUNT(CASE WHEN ReadAt IS NULL THEN 1 END) OVER () AS UnreadCount
  FROM dbo.CommitteeDecisionNotifications WHERE ApprovedMemberId=@MemberId
  ORDER BY CASE WHEN ReadAt IS NULL THEN 0 ELSE 1 END,CreatedAt DESC,NotificationId DESC;
END;');

GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeInquiries TO MuteLabApiRole;
GRANT UPDATE (ReplyReadAt) ON OBJECT::dbo.CommitteeInquiries TO MuteLabApiRole;
GRANT EXECUTE ON OBJECT::dbo.ListSupervisorInquiries TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.ReplySupervisorInquiry TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.GetSupervisorInquiryAttachment TO MuteLabCommitteeApproverRole;
COMMIT TRANSACTION;
