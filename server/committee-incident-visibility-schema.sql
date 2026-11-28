SET XACT_ABORT ON;

IF COL_LENGTH(N'dbo.CommitteeSubmissions', N'CommitteeHiddenAt') IS NULL
  ALTER TABLE dbo.CommitteeSubmissions ADD CommitteeHiddenAt datetime2(0) NULL;
