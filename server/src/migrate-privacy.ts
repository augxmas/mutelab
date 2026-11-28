import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { memberDataKey, querySql } from './db';

function moduleDefinition(schema: string, kind: 'PROCEDURE' | 'TRIGGER', name: string): string {
  const start = schema.indexOf(`EXEC(N'CREATE OR ALTER ${kind} dbo.${name}\n`);
  const last = schema.indexOf("\nEND;');", start);
  if (start < 0 || last < 0) throw new Error(`Missing SQL definition for ${name}.`);
  return schema.slice(start, last + "\nEND;');".length);
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
  if (memberDataKey.length < 32 || memberDataKey.length > 128) throw new Error('MEMBER_DATA_KEY is invalid.');
  const [committee, supervisor] = await Promise.all(['committee-schema.sql', 'supervisor-schema.sql']
    .map(file => readFile(path.resolve(__dirname, '..', file), 'utf8').then(value => value.replaceAll('\r\n', '\n'))));
  const definitions = [
    moduleDefinition(committee, 'PROCEDURE', 'ApproveCommitteeApplication'),
    moduleDefinition(committee, 'PROCEDURE', 'RejectCommitteeApplication'),
    moduleDefinition(supervisor, 'PROCEDURE', 'GetSupervisorComplexDetails'),
    moduleDefinition(supervisor, 'PROCEDURE', 'EnqueueCommitteeDecisionNotification'),
    moduleDefinition(supervisor, 'PROCEDURE', 'RecordSupervisorDecisionAudit'),
    moduleDefinition(committee, 'TRIGGER', 'TR_CommitteeSubmissionArtifacts_InsertOnly'),
  ].join('\n');

  await querySql(`
    SET XACT_ABORT ON;
    BEGIN TRANSACTION;
    IF COL_LENGTH(N'dbo.CommitteeApplications',N'ReviewNoteCipher') IS NULL
      ALTER TABLE dbo.CommitteeApplications ADD ReviewNoteCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.SupervisorDecisionAudit',N'RemoteAddressCipher') IS NULL
      ALTER TABLE dbo.SupervisorDecisionAudit ADD RemoteAddressCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.SupervisorDecisionAudit',N'UserAgentCipher') IS NULL
      ALTER TABLE dbo.SupervisorDecisionAudit ADD UserAgentCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.SupervisorAccounts',N'EmailCipher') IS NULL
      ALTER TABLE dbo.SupervisorAccounts ADD EmailCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.SupervisorAccounts',N'EmailHash') IS NULL
      ALTER TABLE dbo.SupervisorAccounts ADD EmailHash char(64) NULL;

    IF COL_LENGTH(N'dbo.CommitteeApplications',N'ReviewNote') IS NOT NULL
      EXEC sys.sp_executesql N'
        UPDATE dbo.CommitteeApplications SET ReviewNoteCipher=dbo.EncryptMemberData(ReviewNote,@key) WHERE ReviewNote IS NOT NULL;
        IF EXISTS(SELECT 1 FROM dbo.CommitteeApplications WHERE ReviewNote IS NOT NULL
          AND ISNULL(dbo.DecryptMemberData(ReviewNoteCipher,@key),NCHAR(0))<>ReviewNote)
          THROW 51110, ''Review note encryption verification failed.'',1;
        ALTER TABLE dbo.CommitteeApplications DROP COLUMN ReviewNote;', N'@key nvarchar(128)', @key;

    IF COL_LENGTH(N'dbo.SupervisorDecisionAudit',N'RemoteAddress') IS NOT NULL
      EXEC sys.sp_executesql N'
        UPDATE dbo.SupervisorDecisionAudit SET RemoteAddressCipher=dbo.EncryptMemberData(RemoteAddress,@key),
          UserAgentCipher=dbo.EncryptMemberData(UserAgent,@key);
        IF EXISTS(SELECT 1 FROM dbo.SupervisorDecisionAudit
          WHERE (RemoteAddress IS NOT NULL AND ISNULL(dbo.DecryptMemberData(RemoteAddressCipher,@key),NCHAR(0))<>RemoteAddress)
            OR (UserAgent IS NOT NULL AND ISNULL(dbo.DecryptMemberData(UserAgentCipher,@key),NCHAR(0))<>UserAgent))
          THROW 51111, ''Supervisor audit encryption verification failed.'',1;
        ALTER TABLE dbo.SupervisorDecisionAudit DROP COLUMN RemoteAddress,UserAgent;', N'@key nvarchar(128)', @key;

    IF COL_LENGTH(N'dbo.SupervisorAccounts',N'Email') IS NOT NULL
      EXEC sys.sp_executesql N'
        UPDATE dbo.SupervisorAccounts SET EmailCipher=dbo.EncryptMemberData(Email,@key), EmailHash=dbo.MemberLookupHash(Email,@key);
        IF EXISTS(SELECT 1 FROM dbo.SupervisorAccounts WHERE EmailHash IS NULL
          OR ISNULL(dbo.DecryptMemberData(EmailCipher,@key),NCHAR(0))<>Email)
          THROW 51112, ''Supervisor email encryption verification failed.'',1;
        ALTER TABLE dbo.SupervisorAccounts DROP CONSTRAINT PK_SupervisorAccounts;
        ALTER TABLE dbo.SupervisorAccounts ALTER COLUMN EmailHash char(64) NOT NULL;
        ALTER TABLE dbo.SupervisorAccounts ALTER COLUMN EmailCipher varbinary(max) NOT NULL;
        ALTER TABLE dbo.SupervisorAccounts ADD CONSTRAINT PK_SupervisorAccounts PRIMARY KEY(EmailHash);
        ALTER TABLE dbo.SupervisorAccounts DROP COLUMN Email;', N'@key nvarchar(128)', @key;

    ${definitions}
    EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_InsertOnly ON dbo.NoiseRecordings
      INSTEAD OF UPDATE, DELETE AS
      BEGIN SET NOCOUNT ON; THROW 51010, ''Noise recording ledger is insert-only.'',1; END;');
    EXEC(N'CREATE OR ALTER TRIGGER dbo.TR_CommitteeSubmissionArtifactBindings_InsertOnly ON dbo.CommitteeSubmissionArtifactBindings
      INSTEAD OF UPDATE, DELETE AS
      BEGIN SET NOCOUNT ON; THROW 51053, ''Committee evidence bindings are insert-only.'',1; END;');
    EXEC(N'GRANT SELECT (ReviewNoteCipher) ON OBJECT::dbo.CommitteeApplications TO MuteLabApiRole;
      GRANT EXECUTE ON OBJECT::dbo.MemberLookupHash TO MuteLabCommitteeApproverRole;
      GRANT EXECUTE ON OBJECT::dbo.EncryptMemberData TO MuteLabCommitteeApproverRole;
      DENY UPDATE,DELETE ON OBJECT::dbo.NoiseRecordings TO MuteLabApiRole;
      DENY UPDATE,DELETE ON OBJECT::dbo.CommitteeSubmissionArtifacts TO MuteLabApiRole;
      DENY UPDATE,DELETE ON OBJECT::dbo.CommitteeSubmissionArtifactBindings TO MuteLabApiRole;');
    ${verifyOnly ? 'ROLLBACK' : 'COMMIT'} TRANSACTION;
  `, { key: memberDataKey });
  console.log(verifyOnly ? 'Privacy migration verified and rolled back.' : 'Privacy encryption and append-only audio migration applied.');
}

void main().then(() => process.exit(0)).catch(error => {
  console.error('Privacy migration failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
