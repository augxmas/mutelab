SET XACT_ABORT ON;
BEGIN TRANSACTION;

IF OBJECT_ID(N'dbo.CommitteeReportIncidents',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeReportIncidents (
    RecordNo varchar(13) NOT NULL CONSTRAINT PK_CommitteeReportIncidents PRIMARY KEY
      REFERENCES dbo.CommitteeSubmissions(RecordNo),
    KaptCode varchar(50) NOT NULL,
    PairKey char(64) NOT NULL,
    AddedBy int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    AddedAt datetime2(0) NOT NULL DEFAULT SYSUTCDATETIME()
  );
  CREATE INDEX IX_CommitteeReportIncidents_Pair
    ON dbo.CommitteeReportIncidents(KaptCode,PairKey,RecordNo);
END;

GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeReportIncidents TO MuteLabApiRole;
COMMIT TRANSACTION;
