SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeMeasurementApplications',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeMeasurementApplications (
    MeasurementApplicationId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeMeasurementApplications PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    CreatedBy int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    RequestId uniqueidentifier NOT NULL,
    ApplicationCipher varbinary(max) NOT NULL,
    CreatedAt datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CommitteeMeasurementApplications_Request UNIQUE(KaptCode,CreatedBy,RequestId)
  );
  CREATE INDEX IX_CommitteeMeasurementApplications_Complex
    ON dbo.CommitteeMeasurementApplications(KaptCode,MeasurementApplicationId DESC);
END;
GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeMeasurementApplications TO MuteLabApiRole;
COMMIT TRANSACTION;
