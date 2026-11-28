CREATE OR ALTER PROCEDURE dbo.ListSupervisorNotifications
  @MemberDataKey nvarchar(128),
  @Page int,
  @CountOnly bit=0
AS
BEGIN
  SET NOCOUNT ON;

  IF @CountOnly=1
  BEGIN
    SELECT (SELECT COUNT(*) FROM dbo.CommitteeApplications WHERE Status='PENDING')
         + (SELECT COUNT(*) FROM dbo.CommitteeInquiries WHERE RepliedAt IS NULL) AS Total;
    RETURN;
  END;

  SELECT CAST('application' AS varchar(11)) AS Kind, ApplicationId AS Id,
    KaptCode, RequestedRole, SubmittedAt AS CreatedAt
  INTO #Notifications
  FROM dbo.CommitteeApplications WHERE Status='PENDING'
  UNION ALL
  SELECT 'inquiry', InquiryId, KaptCode, NULL, CreatedAt
  FROM dbo.CommitteeInquiries WHERE RepliedAt IS NULL;

  SELECT COUNT(*) AS Total FROM #Notifications;

  SELECT n.Kind, n.Id, n.KaptCode, n.RequestedRole, n.CreatedAt, c.kaptName AS ComplexName,
    JSON_VALUE(dbo.DecryptMemberData(i.QuestionCipher,@MemberDataKey),'$.title') AS InquiryTitle
  FROM (
    SELECT Kind, Id, KaptCode, RequestedRole, CreatedAt FROM #Notifications
    ORDER BY CreatedAt DESC, Kind, Id DESC
    OFFSET (CONVERT(bigint,@Page)-1)*50 ROWS FETCH NEXT 50 ROWS ONLY
  ) n
  LEFT JOIN dbo.AptComplexWithDetail c ON c.kaptCode=n.KaptCode
  LEFT JOIN dbo.CommitteeInquiries i ON n.Kind='inquiry' AND i.InquiryId=n.Id
  ORDER BY n.CreatedAt DESC, n.Kind, n.Id DESC;
END;
GO
GRANT EXECUTE ON OBJECT::dbo.ListSupervisorNotifications TO MuteLabCommitteeApproverRole;
GO
CREATE OR ALTER PROCEDURE dbo.ListSupervisorInquiries
  @MemberDataKey nvarchar(128),
  @InquiryId int=NULL
AS
BEGIN
  SET NOCOUNT ON;
  SELECT TOP (100) i.InquiryId,i.KaptCode,a.kaptName AS ComplexName,i.CreatedAt,i.RepliedAt,i.AttachmentType,
    dbo.DecryptMemberData(i.QuestionCipher,@MemberDataKey) AS Question,
    dbo.DecryptMemberData(i.ReplyCipher,@MemberDataKey) AS Reply
  FROM dbo.CommitteeInquiries i LEFT JOIN dbo.AptComplexWithDetail a ON a.kaptCode=i.KaptCode
  WHERE @InquiryId IS NULL OR i.InquiryId=@InquiryId
  ORDER BY CASE WHEN i.RepliedAt IS NULL THEN 0 ELSE 1 END,i.InquiryId DESC;
END;
GO
