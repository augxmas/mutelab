SET XACT_ABORT ON;
SET QUOTED_IDENTIFIER ON;
BEGIN TRANSACTION;
IF OBJECT_ID(N'dbo.CommitteeSignatureAssets',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.CommitteeSignatureAssets (
    AssetId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_CommitteeSignatureAssets PRIMARY KEY,
    ApplicationId bigint NULL REFERENCES dbo.CommitteeApplications(ApplicationId),
    MemberId int NULL REFERENCES dbo.CommitteeMembers(MemberId),
    ImageCipher varbinary(max) NULL,
    CONSTRAINT CK_CommitteeSignatureAssets_Owner CHECK(
      (ApplicationId IS NOT NULL AND MemberId IS NULL AND ImageCipher IS NOT NULL)
      OR (ApplicationId IS NULL AND MemberId IS NOT NULL))
  );
  CREATE UNIQUE INDEX UX_CommitteeSignatureAssets_Application ON dbo.CommitteeSignatureAssets(ApplicationId) WHERE ApplicationId IS NOT NULL;
  CREATE UNIQUE INDEX UX_CommitteeSignatureAssets_Member ON dbo.CommitteeSignatureAssets(MemberId) WHERE MemberId IS NOT NULL;
END;
GRANT SELECT,INSERT ON OBJECT::dbo.CommitteeSignatureAssets TO MuteLabApiRole;
GRANT UPDATE (ImageCipher) ON OBJECT::dbo.CommitteeSignatureAssets TO MuteLabApiRole;
GRANT SELECT (ApprovedMemberId) ON OBJECT::dbo.CommitteeApplications TO MuteLabApiRole;
COMMIT TRANSACTION;
