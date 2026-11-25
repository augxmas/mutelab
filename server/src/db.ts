import sql, { ConnectionPool } from 'mssql';

const dbUser = process.env.DB_USER ?? '';
const dbPassword = process.env.DB_PASSWORD ?? '';
const dbName = process.env.SQL_DATABASE ?? 'mutelab';
export const memberDataKey = process.env.MEMBER_DATA_KEY ?? '';
let poolPromise: Promise<ConnectionPool> | undefined;

function getPool(): Promise<ConnectionPool> {
  if (!dbUser || !dbPassword) throw new Error('DB_USER and DB_PASSWORD must be set in server/.env.');
  if (!poolPromise) {
    const pool = new sql.ConnectionPool({
      user: dbUser,
      password: dbPassword,
      server: process.env.SQL_SERVER ?? '127.0.0.1',
      port: Number(process.env.SQL_PORT ?? 1433),
      database: dbName,
      connectionTimeout: 8000,
      requestTimeout: 15000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true }
    });
    pool.on('error', (error: Error) => console.error('SQL pool error:', error.message));
    poolPromise = pool.connect().catch((error: Error) => { poolPromise = undefined; throw error; });
  }
  return poolPromise!;
}

export function sqlString(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

export async function querySql<T = Record<string, unknown>>(query: string, parameters?: Record<string, unknown>): Promise<T[]> {
  const pool = await getPool();
  const request = pool.request();
  if (parameters) for (const [name, value] of Object.entries(parameters)) request.input(name, value);
  const result = await request.query(query);
  return result.recordset as T[];
}

export async function executeSql(query: string): Promise<void> {
  const pool = await getPool();
  await pool.request().query(query);
}

export async function initializeDatabase(): Promise<void> {
  if (memberDataKey.length < 32) throw new Error('MEMBER_DATA_KEY must contain at least 32 characters.');
  const [state] = await querySql<{ CoreReady: number; RecordingTriggerReady: number; RecordingInsertTriggerReady: number }>(`
    SELECT CASE WHEN OBJECT_ID(N'dbo.AppUsers',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.EmailChallenges',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.VerifiedEmailTokens',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.NoiseRecordings',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.NoiseIncidentJournals',N'U') IS NOT NULL
      AND OBJECT_ID(N'dbo.EncryptMemberData',N'FN') IS NOT NULL
      AND OBJECT_ID(N'dbo.DecryptMemberData',N'FN') IS NOT NULL
      AND OBJECT_ID(N'dbo.MemberLookupHash',N'FN') IS NOT NULL THEN 1 ELSE 0 END AS CoreReady,
      CASE WHEN EXISTS(SELECT 1 FROM sys.triggers
        WHERE object_id=OBJECT_ID(N'dbo.TR_NoiseRecordings_InsertOnly',N'TR') AND is_disabled=0)
        THEN 1 ELSE 0 END AS RecordingTriggerReady,
      CASE WHEN EXISTS(SELECT 1 FROM sys.triggers
        WHERE object_id=OBJECT_ID(N'dbo.TR_NoiseRecordings_ValidateInsert',N'TR') AND is_disabled=0)
        THEN 1 ELSE 0 END AS RecordingInsertTriggerReady
  `);
  if (state?.CoreReady === 1 && state.RecordingTriggerReady === 1 && state.RecordingInsertTriggerReady === 1) return;
  if (state?.CoreReady === 1) {
    try {
      await executeSql(`CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_InsertOnly ON dbo.NoiseRecordings INSTEAD OF UPDATE, DELETE AS BEGIN SET NOCOUNT ON; THROW 51010, 'Noise recording ledger is insert-only.', 1; END;`);
      await executeSql(`CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_ValidateInsert ON dbo.NoiseRecordings AFTER INSERT AS BEGIN SET NOCOUNT ON; IF EXISTS(SELECT 1 FROM inserted WHERE AudioLength<>DATALENGTH(AudioData) OR AudioSha256<>CONVERT(char(64),HASHBYTES('SHA2_256',AudioData),2)) THROW 51011, 'Noise recording hash or length is invalid.', 1; END;`);
      return;
    } catch {
      throw new Error('The recording integrity triggers are missing. Restore dbo.TR_NoiseRecordings_InsertOnly and dbo.TR_NoiseRecordings_ValidateInsert with a database administrator account.');
    }
  }
  await executeSql(`CREATE OR ALTER FUNCTION dbo.EncryptMemberData(@clearText nvarchar(max), @secret nvarchar(128)) RETURNS varbinary(max) AS BEGIN RETURN EncryptByPassPhrase(@secret, @clearText, 1, HASHBYTES('SHA2_256', N'MuteLab.MemberData.v1')); END;`);
  await executeSql(`CREATE OR ALTER FUNCTION dbo.DecryptMemberData(@cipherText varbinary(max), @secret nvarchar(128)) RETURNS nvarchar(max) AS BEGIN RETURN CONVERT(nvarchar(max), DecryptByPassPhrase(@secret, @cipherText, 1, HASHBYTES('SHA2_256', N'MuteLab.MemberData.v1'))); END;`);
  await executeSql(`CREATE OR ALTER FUNCTION dbo.MemberLookupHash(@value nvarchar(254), @secret nvarchar(128)) RETURNS char(64) AS BEGIN RETURN CONVERT(char(64), HASHBYTES('SHA2_256', @secret + LOWER(@value)), 2); END;`);
  await executeSql(`IF OBJECT_ID(N'dbo.AppUsers',N'U') IS NULL CREATE TABLE dbo.AppUsers(UserId int IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUsers PRIMARY KEY,LoginId nvarchar(40) COLLATE Latin1_General_100_CI_AS NOT NULL,Email nvarchar(254) NULL,PasswordHash varchar(100) NOT NULL,ProfileJson nvarchar(max) NULL,LoginIdCipher varbinary(max) NULL,LoginIdHash char(64) NULL,EmailCipher varbinary(max) NULL,EmailHash char(64) NULL,ProfileCipher varbinary(max) NULL,CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_AppUsers_CreatedAt DEFAULT SYSUTCDATETIME(),CONSTRAINT UQ_AppUsers_LoginId UNIQUE(LoginId));
    IF OBJECT_ID(N'dbo.EmailChallenges',N'U') IS NULL CREATE TABLE dbo.EmailChallenges(Email nvarchar(254) NULL,EmailHash char(64) NOT NULL,Purpose varchar(20) NOT NULL,CodeHash char(64) NOT NULL,ExpiresAt datetime2(0) NOT NULL,Attempts tinyint NOT NULL CONSTRAINT DF_EmailChallenges_Attempts DEFAULT 0,CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_EmailChallenges_CreatedAt DEFAULT SYSUTCDATETIME(),CONSTRAINT PK_EmailChallenges PRIMARY KEY(EmailHash,Purpose));
    IF OBJECT_ID(N'dbo.VerifiedEmailTokens',N'U') IS NULL CREATE TABLE dbo.VerifiedEmailTokens(TokenHash char(64) NOT NULL CONSTRAINT PK_VerifiedEmailTokens PRIMARY KEY,Email nvarchar(254) NULL,EmailHash char(64) NOT NULL,Purpose varchar(20) NOT NULL,ExpiresAt datetime2(0) NOT NULL);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.VerifiedEmailTokens') AND name=N'IX_VerifiedEmailTokens_ExpiresAt') CREATE INDEX IX_VerifiedEmailTokens_ExpiresAt ON dbo.VerifiedEmailTokens(ExpiresAt);`);
  await executeSql(`IF COL_LENGTH(N'dbo.AppUsers',N'LoginIdCipher') IS NULL ALTER TABLE dbo.AppUsers ADD LoginIdCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'LoginIdHash') IS NULL ALTER TABLE dbo.AppUsers ADD LoginIdHash char(64) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'EmailCipher') IS NULL ALTER TABLE dbo.AppUsers ADD EmailCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'EmailHash') IS NULL ALTER TABLE dbo.AppUsers ADD EmailHash char(64) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'ProfileCipher') IS NULL ALTER TABLE dbo.AppUsers ADD ProfileCipher varbinary(max) NULL;
    IF COL_LENGTH(N'dbo.EmailChallenges',N'EmailHash') IS NULL ALTER TABLE dbo.EmailChallenges ADD EmailHash char(64) NULL;
    IF COL_LENGTH(N'dbo.VerifiedEmailTokens',N'EmailHash') IS NULL ALTER TABLE dbo.VerifiedEmailTokens ADD EmailHash char(64) NULL;`);
  await executeSql(`UPDATE dbo.AppUsers SET LoginIdCipher=dbo.EncryptMemberData(LoginId,${sqlString(memberDataKey)}),LoginIdHash=dbo.MemberLookupHash(LoginId,${sqlString(memberDataKey)}) WHERE LoginId IS NOT NULL AND LoginIdCipher IS NULL;
    UPDATE dbo.AppUsers SET EmailCipher=dbo.EncryptMemberData(Email,${sqlString(memberDataKey)}),EmailHash=dbo.MemberLookupHash(Email,${sqlString(memberDataKey)}) WHERE Email IS NOT NULL AND EmailCipher IS NULL;
    UPDATE dbo.AppUsers SET ProfileCipher=dbo.EncryptMemberData(ProfileJson,${sqlString(memberDataKey)}) WHERE ProfileJson IS NOT NULL AND ProfileCipher IS NULL;
    UPDATE dbo.EmailChallenges SET EmailHash=dbo.MemberLookupHash(Email,${sqlString(memberDataKey)}) WHERE EmailHash IS NULL AND Email IS NOT NULL;
    UPDATE dbo.VerifiedEmailTokens SET EmailHash=dbo.MemberLookupHash(Email,${sqlString(memberDataKey)}) WHERE EmailHash IS NULL AND Email IS NOT NULL;`);
  await executeSql(`IF OBJECT_ID(N'dbo.UQ_AppUsers_Email',N'UQ') IS NOT NULL ALTER TABLE dbo.AppUsers DROP CONSTRAINT UQ_AppUsers_Email;
    IF OBJECT_ID(N'dbo.UQ_AppUsers_LoginId',N'UQ') IS NOT NULL ALTER TABLE dbo.AppUsers DROP CONSTRAINT UQ_AppUsers_LoginId;
    IF EXISTS (SELECT 1 FROM sys.key_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.EmailChallenges') AND name=N'PK_EmailChallenges' AND COL_NAME(parent_object_id,1)<>N'EmailHash') ALTER TABLE dbo.EmailChallenges DROP CONSTRAINT PK_EmailChallenges;
    IF COL_LENGTH(N'dbo.AppUsers',N'Email') IS NOT NULL ALTER TABLE dbo.AppUsers ALTER COLUMN Email nvarchar(254) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'LoginId') IS NOT NULL ALTER TABLE dbo.AppUsers ALTER COLUMN LoginId nvarchar(40) NULL;
    IF COL_LENGTH(N'dbo.EmailChallenges',N'Email') IS NOT NULL ALTER TABLE dbo.EmailChallenges ALTER COLUMN Email nvarchar(254) NULL;
    IF COL_LENGTH(N'dbo.VerifiedEmailTokens',N'Email') IS NOT NULL ALTER TABLE dbo.VerifiedEmailTokens ALTER COLUMN Email nvarchar(254) NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'EmailHash') IS NOT NULL ALTER TABLE dbo.AppUsers ALTER COLUMN EmailHash char(64) NOT NULL;
    IF COL_LENGTH(N'dbo.AppUsers',N'LoginIdHash') IS NOT NULL ALTER TABLE dbo.AppUsers ALTER COLUMN LoginIdHash char(64) NOT NULL;
    IF COL_LENGTH(N'dbo.EmailChallenges',N'EmailHash') IS NOT NULL ALTER TABLE dbo.EmailChallenges ALTER COLUMN EmailHash char(64) NOT NULL;
    IF COL_LENGTH(N'dbo.VerifiedEmailTokens',N'EmailHash') IS NOT NULL ALTER TABLE dbo.VerifiedEmailTokens ALTER COLUMN EmailHash char(64) NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.EmailChallenges') AND name=N'PK_EmailChallenges') ALTER TABLE dbo.EmailChallenges ADD CONSTRAINT PK_EmailChallenges PRIMARY KEY(EmailHash,Purpose);
    UPDATE dbo.AppUsers SET LoginId=NULL,Email=NULL,ProfileJson=NULL WHERE LoginId IS NOT NULL OR Email IS NOT NULL OR ProfileJson IS NOT NULL;
    UPDATE dbo.EmailChallenges SET Email=NULL WHERE Email IS NOT NULL;
    UPDATE dbo.VerifiedEmailTokens SET Email=NULL WHERE Email IS NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AppUsers') AND name=N'UX_AppUsers_EmailHash') CREATE UNIQUE INDEX UX_AppUsers_EmailHash ON dbo.AppUsers(EmailHash);
    IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AppUsers') AND name=N'UX_AppUsers_LoginIdHash') CREATE UNIQUE INDEX UX_AppUsers_LoginIdHash ON dbo.AppUsers(LoginIdHash);
    IF OBJECT_ID(N'dbo.NoiseRecordingCounters',N'U') IS NULL CREATE TABLE dbo.NoiseRecordingCounters(RecordDate char(8) NOT NULL CONSTRAINT PK_NoiseRecordingCounters PRIMARY KEY,LastNumber int NOT NULL);
    IF OBJECT_ID(N'dbo.NoiseRecordings',N'U') IS NULL CREATE TABLE dbo.NoiseRecordings(RecordNo varchar(13) NOT NULL CONSTRAINT PK_NoiseRecordings PRIMARY KEY,UserId int NOT NULL,ClientRecordId nvarchar(40) NOT NULL,AudioSha256 char(64) NOT NULL,AudioLength bigint NOT NULL,AudioData varbinary(max) NOT NULL,StartedAt datetime2(0) NOT NULL,EndedAt datetime2(0) NOT NULL,CreatedAt datetime2(0) NOT NULL CONSTRAINT DF_NoiseRecordings_CreatedAt DEFAULT SYSUTCDATETIME(),CONSTRAINT FK_NoiseRecordings_AppUsers FOREIGN KEY(UserId) REFERENCES dbo.AppUsers(UserId),CONSTRAINT UQ_NoiseRecordings_UserClient UNIQUE(UserId,ClientRecordId));
    IF OBJECT_ID(N'dbo.NoiseIncidentJournals',N'U') IS NULL CREATE TABLE dbo.NoiseIncidentJournals(RecordNo varchar(13) NOT NULL CONSTRAINT PK_NoiseIncidentJournals PRIMARY KEY,UserId int NOT NULL,JournalCipher varbinary(max) NOT NULL,UpdatedAt datetime2(0) NOT NULL CONSTRAINT DF_NoiseIncidentJournals_UpdatedAt DEFAULT SYSUTCDATETIME(),CONSTRAINT FK_NoiseIncidentJournals_Recording FOREIGN KEY(RecordNo) REFERENCES dbo.NoiseRecordings(RecordNo),CONSTRAINT FK_NoiseIncidentJournals_AppUsers FOREIGN KEY(UserId) REFERENCES dbo.AppUsers(UserId));
    DELETE FROM dbo.EmailChallenges WHERE ExpiresAt<=SYSUTCDATETIME(); DELETE FROM dbo.VerifiedEmailTokens WHERE ExpiresAt<=SYSUTCDATETIME();`);
  await executeSql(`CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_InsertOnly ON dbo.NoiseRecordings INSTEAD OF UPDATE, DELETE AS BEGIN SET NOCOUNT ON; THROW 51010, 'Noise recording ledger is insert-only.', 1; END;`);
  await executeSql(`CREATE OR ALTER TRIGGER dbo.TR_NoiseRecordings_ValidateInsert ON dbo.NoiseRecordings AFTER INSERT AS BEGIN SET NOCOUNT ON; IF EXISTS(SELECT 1 FROM inserted WHERE AudioLength<>DATALENGTH(AudioData) OR AudioSha256<>CONVERT(char(64),HASHBYTES('SHA2_256',AudioData),2)) THROW 51011, 'Noise recording hash or length is invalid.', 1; END;`);
}


