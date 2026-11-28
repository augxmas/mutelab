SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeSessions', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeSessions (
    SessionHash char(64) NOT NULL CONSTRAINT PK_CommitteeSessions PRIMARY KEY,
    MemberId int NOT NULL REFERENCES dbo.CommitteeMembers(MemberId),
    LoginIpCipher varbinary(max) NOT NULL,
    LoggedInAt datetime2(3) NOT NULL,
    ExpiresAt datetime2(3) NOT NULL,
    LoggedOutAt datetime2(3) NULL
  );
  CREATE INDEX IX_CommitteeSessions_MemberLogin ON dbo.CommitteeSessions(MemberId, LoggedInAt DESC, SessionHash DESC);
END;
GRANT SELECT, INSERT ON OBJECT::dbo.CommitteeSessions TO MuteLabApiRole;
GRANT UPDATE (ExpiresAt, LoggedOutAt) ON OBJECT::dbo.CommitteeSessions TO MuteLabApiRole;
COMMIT TRANSACTION;
