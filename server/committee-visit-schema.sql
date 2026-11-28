SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeVisitApplications',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeVisitApplications (
    VisitApplicationId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeVisitApplications PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    CreatedBy int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    RequestId uniqueidentifier NOT NULL,
    ApplicationCipher varbinary(max) NOT NULL,
    CreatedAt datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CommitteeVisitApplications_Request UNIQUE(KaptCode,CreatedBy,RequestId)
  );
  CREATE INDEX IX_CommitteeVisitApplications_Complex ON dbo.CommitteeVisitApplications(KaptCode,VisitApplicationId DESC);
END;
GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeVisitApplications TO MuteLabApiRole;
COMMIT TRANSACTION;
