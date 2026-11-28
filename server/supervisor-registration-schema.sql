SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.SupervisorComplexBusinessRegistrations', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.SupervisorComplexBusinessRegistrations (
    KaptCode varchar(50) NOT NULL CONSTRAINT PK_SupervisorComplexBusinessRegistrations PRIMARY KEY,
    NumberCipher varbinary(max) NOT NULL,
    UpdatedAt datetime2(0) NOT NULL CONSTRAINT DF_SupervisorComplexBusinessRegistrations_UpdatedAt DEFAULT SYSUTCDATETIME()
  );
END;

EXEC(N'CREATE OR ALTER PROCEDURE dbo.GetSupervisorComplexBusinessRegistrations
  @KaptCodes nvarchar(max), @MemberDataKey nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SELECT codes.KaptCode,
    dbo.DecryptMemberData(registration.NumberCipher,@MemberDataKey) AS BusinessRegistrationNumber,
    document.ApplicationId AS DocumentApplicationId
  FROM OPENJSON(@KaptCodes) WITH (KaptCode varchar(50) ''$'') codes
  LEFT JOIN dbo.SupervisorComplexBusinessRegistrations registration ON registration.KaptCode=codes.KaptCode
  OUTER APPLY (
    SELECT TOP (1) a.ApplicationId FROM dbo.CommitteeApplications a
    WHERE a.KaptCode=codes.KaptCode AND a.Status IN(''APPROVED'',''PENDING'') AND DATALENGTH(a.DocumentCipher)>28
    ORDER BY CASE WHEN a.Status=''APPROVED'' THEN 0 ELSE 1 END,
      CASE WHEN a.RequestedRole=N''위원장'' THEN 0 ELSE 1 END,
      a.SubmittedAt DESC,a.ApplicationId DESC
  ) document;
END;');

EXEC(N'CREATE OR ALTER PROCEDURE dbo.SaveSupervisorComplexBusinessRegistration
  @KaptCode varchar(50), @BusinessRegistrationNumber varchar(32), @MemberDataKey nvarchar(128)
AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;
  IF @BusinessRegistrationNumber IS NULL OR DATALENGTH(@BusinessRegistrationNumber)<>10
    OR @BusinessRegistrationNumber COLLATE Latin1_General_100_BIN2 LIKE ''%[^0-9]%''
    THROW 51120,''Invalid business registration number.'',1;
  IF NOT EXISTS (SELECT 1 FROM dbo.AptComplexWithDetail WHERE kaptCode=@KaptCode)
  BEGIN SELECT 0 AS Saved; RETURN; END;
  DECLARE @cipher varbinary(max)=dbo.EncryptMemberData(@BusinessRegistrationNumber,@MemberDataKey);
  BEGIN TRANSACTION;
  UPDATE dbo.SupervisorComplexBusinessRegistrations WITH (UPDLOCK,HOLDLOCK)
    SET NumberCipher=@cipher,UpdatedAt=SYSUTCDATETIME() WHERE KaptCode=@KaptCode;
  IF @@ROWCOUNT=0 INSERT dbo.SupervisorComplexBusinessRegistrations(KaptCode,NumberCipher)
    VALUES (@KaptCode,@cipher);
  COMMIT TRANSACTION;
  SELECT 1 AS Saved;
END;');

GRANT EXECUTE ON OBJECT::dbo.GetSupervisorComplexBusinessRegistrations TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.SaveSupervisorComplexBusinessRegistration TO MuteLabCommitteeApproverRole;
COMMIT TRANSACTION;
