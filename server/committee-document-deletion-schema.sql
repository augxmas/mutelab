SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.CommitteeNoiseReports',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeNoiseReports (
    ReportId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeNoiseReports PRIMARY KEY,
    KaptCode varchar(50) NOT NULL,
    PairKey char(64) NOT NULL,
    CreatedAt datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_CommitteeNoiseReports_Pair UNIQUE(KaptCode,PairKey)
  );
END;

INSERT dbo.CommitteeNoiseReports(KaptCode,PairKey,CreatedAt)
SELECT i.KaptCode,i.PairKey,MIN(i.AddedAt)
FROM dbo.CommitteeReportIncidents i WITH (TABLOCKX,HOLDLOCK)
WHERE NOT EXISTS (
  SELECT 1 FROM dbo.CommitteeNoiseReports r WHERE r.KaptCode=i.KaptCode AND r.PairKey=i.PairKey
)
GROUP BY i.KaptCode,i.PairKey;

GRANT SELECT,INSERT,DELETE ON OBJECT::dbo.CommitteeNoiseReports TO MuteLabApiRole;
GRANT DELETE ON OBJECT::dbo.CommitteeReportIncidents TO MuteLabApiRole;
GRANT DELETE ON OBJECT::dbo.CommitteeVisitApplications TO MuteLabApiRole;
GRANT DELETE ON OBJECT::dbo.CommitteeMeasurementApplications TO MuteLabApiRole;
GRANT DELETE ON OBJECT::dbo.CommitteeMediationEntries TO MuteLabApiRole;
GRANT DELETE ON OBJECT::dbo.CommitteeMediationReports TO MuteLabApiRole;
COMMIT TRANSACTION;
