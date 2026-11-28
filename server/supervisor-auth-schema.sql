SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.SupervisorAccounts',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.SupervisorAccounts (
    EmailHash char(64) NOT NULL CONSTRAINT PK_SupervisorAccounts PRIMARY KEY,
    EmailCipher varbinary(max) NOT NULL,
    PasswordHash varchar(60) NOT NULL,
    OtpSecretCipher varbinary(64) NULL,
    LastOtpStep bigint NOT NULL CONSTRAINT DF_SupervisorAccounts_LastOtpStep DEFAULT (-1)
  );
END;
GRANT SELECT, INSERT ON OBJECT::dbo.SupervisorAccounts TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.MemberLookupHash TO MuteLabCommitteeApproverRole;
GRANT EXECUTE ON OBJECT::dbo.EncryptMemberData TO MuteLabCommitteeApproverRole;
GRANT UPDATE (PasswordHash,OtpSecretCipher,LastOtpStep) ON OBJECT::dbo.SupervisorAccounts TO MuteLabCommitteeApproverRole;
COMMIT TRANSACTION;
