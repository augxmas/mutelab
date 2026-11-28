SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeMediationReports',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeMediationReports (
    MediationReportId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeMediationReports PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    CreatedBy int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    RequestId uniqueidentifier NOT NULL,
    ReportCipher varbinary(max) NOT NULL,
    CreatedAt datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CommitteeMediationReports_Request UNIQUE(KaptCode,CreatedBy,RequestId)
  );
  CREATE INDEX IX_CommitteeMediationReports_Complex ON dbo.CommitteeMediationReports(KaptCode,MediationReportId DESC);
END;

IF COL_LENGTH(N'dbo.CommitteeMediationReports',N'ReportNo') IS NULL
  ALTER TABLE dbo.CommitteeMediationReports ADD ReportNo varchar(13) NULL;

IF NOT EXISTS(SELECT 1 FROM sys.indexes
  WHERE object_id=OBJECT_ID(N'dbo.CommitteeMediationReports') AND name=N'UX_CommitteeMediationReports_ReportNo')
BEGIN
  EXEC sys.sp_executesql N'
    IF EXISTS (
      SELECT 1 FROM dbo.CommitteeMediationReports
      GROUP BY CONVERT(date,DATEADD(hour,9,CreatedAt)) HAVING COUNT_BIG(*)>9999
    ) THROW 51064,''Daily mediation report number limit exceeded.'',1;

    WITH numbered AS (
      SELECT ReportNo,CONVERT(char(8),DATEADD(hour,9,CreatedAt),112) AS DatePrefix,
        ROW_NUMBER() OVER(PARTITION BY CONVERT(date,DATEADD(hour,9,CreatedAt))
          ORDER BY CreatedAt,MediationReportId) AS DailyNumber
      FROM dbo.CommitteeMediationReports
    )
    UPDATE numbered SET ReportNo=DatePrefix+''_''+RIGHT(''0000''+CONVERT(varchar(4),DailyNumber),4)
    WHERE ReportNo IS NULL;

    ALTER TABLE dbo.CommitteeMediationReports ALTER COLUMN ReportNo varchar(13) NOT NULL;
    CREATE UNIQUE INDEX UX_CommitteeMediationReports_ReportNo ON dbo.CommitteeMediationReports(ReportNo);
  ';
END;

IF OBJECT_ID(N'dbo.CommitteeMediationEntries',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeMediationEntries (
    EntryId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeMediationEntries PRIMARY KEY,
    MediationReportId int NOT NULL REFERENCES dbo.CommitteeMediationReports(MediationReportId),
    EntryDate date NOT NULL,
    ContentCipher varbinary(max) NOT NULL
  );
  CREATE INDEX IX_CommitteeMediationEntries_Report ON dbo.CommitteeMediationEntries(MediationReportId,EntryDate,EntryId);
END;
GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeMediationReports TO MuteLabApiRole;
GRANT UPDATE (ReportCipher) ON OBJECT::dbo.CommitteeMediationReports TO MuteLabApiRole;
GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeMediationEntries TO MuteLabApiRole;
GRANT UPDATE (EntryDate,ContentCipher) ON OBJECT::dbo.CommitteeMediationEntries TO MuteLabApiRole;
COMMIT TRANSACTION;
