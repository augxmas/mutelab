/* Run once with a database administrator account in the mutelab database. */
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'dbo.AptComplex', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptComplex (
        kaptCode nvarchar(50) NOT NULL CONSTRAINT PK_AptComplex PRIMARY KEY,
        kaptName nvarchar(500) NULL,
        sido nvarchar(100) NULL,
        sigungu nvarchar(100) NULL,
        address nvarchar(1000) NULL,
        rawJson nvarchar(max) NOT NULL,
        firstSeenAt datetime2(0) NOT NULL CONSTRAINT DF_AptComplex_firstSeen DEFAULT SYSUTCDATETIME(),
        lastSeenAt datetime2(0) NOT NULL,
        CONSTRAINT CK_AptComplex_rawJson CHECK (ISJSON(rawJson) = 1)
    );
END;
GO

IF OBJECT_ID(N'dbo.AptCollectionRun', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptCollectionRun (
        runId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_AptCollectionRun PRIMARY KEY,
        startedAt datetime2(0) NOT NULL,
        completedAt datetime2(0) NULL,
        apiTotalCount int NULL,
        fetchedCount int NOT NULL CONSTRAINT DF_AptCollectionRun_fetched DEFAULT 0,
        status nvarchar(20) NOT NULL,
        error nvarchar(2000) NULL
    );
END;
GO

CREATE OR ALTER PROCEDURE dbo.UpsertAptComplexListPage @payload nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @payload IS NULL OR ISJSON(@payload) <> 1 OR LEFT(LTRIM(@payload),1) <> N'['
        THROW 51040, 'Expected a JSON array of apartment list rows.', 1;

    ;WITH parsed_source AS (
        SELECT parsed.kaptCode, parsed.kaptName, parsed.sido, parsed.sigungu,
               COALESCE(parsed.address, NULLIF(CONCAT_WS(N' ', parsed.area3, parsed.area4), N'')) AS address,
               rows.[value] AS rawJson,
               ROW_NUMBER() OVER(PARTITION BY parsed.kaptCode ORDER BY TRY_CONVERT(int,rows.[key])) AS rowNumber
        FROM OPENJSON(@payload) AS rows
        CROSS APPLY OPENJSON(rows.[value]) WITH (
            kaptCode nvarchar(50) '$.kaptCode',
            kaptName nvarchar(500) '$.kaptName',
            sido nvarchar(100) '$.as1',
            sigungu nvarchar(100) '$.as2',
            area3 nvarchar(300) '$.as3',
            area4 nvarchar(300) '$.as4',
            address nvarchar(1000) '$.kaptAddr'
        ) AS parsed
        WHERE parsed.kaptCode IS NOT NULL
    ), source AS (
        SELECT kaptCode,kaptName,sido,sigungu,address,rawJson
        FROM parsed_source WHERE rowNumber=1
    )
    MERGE dbo.AptComplex WITH (HOLDLOCK) AS target
    USING source ON target.kaptCode=source.kaptCode
    WHEN MATCHED THEN UPDATE SET
        kaptName=source.kaptName,sido=source.sido,sigungu=source.sigungu,
        address=source.address,rawJson=source.rawJson,lastSeenAt=SYSUTCDATETIME()
    WHEN NOT MATCHED THEN INSERT(kaptCode,kaptName,sido,sigungu,address,rawJson,lastSeenAt)
        VALUES(source.kaptCode,source.kaptName,source.sido,source.sigungu,source.address,source.rawJson,SYSUTCDATETIME());
END;
GO

IF OBJECT_ID(N'dbo.AptComplexDetail', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptComplexDetail (
        kaptCode nvarchar(50) NOT NULL CONSTRAINT PK_AptComplexDetail PRIMARY KEY,
        kaptName nvarchar(500) NULL,
        roadAddress nvarchar(1000) NULL,
        legalAddress nvarchar(1000) NULL,
        postalCode nvarchar(20) NULL,
        complexType nvarchar(100) NULL,
        saleType nvarchar(100) NULL,
        managementType nvarchar(100) NULL,
        heatingType nvarchar(100) NULL,
        buildingCount int NULL,
        householdCount int NULL,
        approvalDate date NULL,
        grossFloorArea decimal(18,3) NULL,
        managementArea decimal(18,3) NULL,
        officePhone nvarchar(50) NULL,
        officeFax nvarchar(50) NULL,
        homepage nvarchar(1000) NULL,
        rawJson nvarchar(max) NULL,
        extendedRawJson nvarchar(max) NULL,
        basicFetchedAt datetime2(0) NULL,
        extendedFetchedAt datetime2(0) NULL,
        fetchedAt datetime2(0) NOT NULL,
        CONSTRAINT FK_AptComplexDetail_AptComplex FOREIGN KEY(kaptCode) REFERENCES dbo.AptComplex(kaptCode),
        CONSTRAINT CK_AptComplexDetail_rawJson CHECK (rawJson IS NULL OR ISJSON(rawJson) = 1),
        CONSTRAINT CK_AptComplexDetail_extendedRawJson CHECK (extendedRawJson IS NULL OR ISJSON(extendedRawJson) = 1)
    );
END
ELSE
BEGIN
    IF COL_LENGTH(N'dbo.AptComplexDetail', N'extendedRawJson') IS NULL
        ALTER TABLE dbo.AptComplexDetail ADD extendedRawJson nvarchar(max) NULL;
    IF COL_LENGTH(N'dbo.AptComplexDetail', N'basicFetchedAt') IS NULL
        ALTER TABLE dbo.AptComplexDetail ADD basicFetchedAt datetime2(0) NULL;
    IF COL_LENGTH(N'dbo.AptComplexDetail', N'extendedFetchedAt') IS NULL
        ALTER TABLE dbo.AptComplexDetail ADD extendedFetchedAt datetime2(0) NULL;
    ALTER TABLE dbo.AptComplexDetail ALTER COLUMN rawJson nvarchar(max) NULL;
    /* Keep references to newly-added columns in a later compilation scope. */
    EXEC(N'UPDATE dbo.AptComplexDetail
      SET basicFetchedAt=COALESCE(basicFetchedAt,fetchedAt)
      WHERE rawJson IS NOT NULL AND basicFetchedAt IS NULL;');
    IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.AptComplexDetail') AND name=N'CK_AptComplexDetail_extendedRawJson')
        EXEC(N'ALTER TABLE dbo.AptComplexDetail ADD CONSTRAINT CK_AptComplexDetail_extendedRawJson
          CHECK (extendedRawJson IS NULL OR ISJSON(extendedRawJson) = 1);');
END;
GO

CREATE OR ALTER PROCEDURE dbo.UpsertAptComplexEndpoint
    @kaptCode nvarchar(50), @endpoint varchar(20), @payload nvarchar(max)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF NULLIF(LTRIM(RTRIM(@kaptCode)),N'') IS NULL OR @endpoint IS NULL
       OR @endpoint NOT IN ('BASIC','EXTENDED') OR @payload IS NULL OR ISJSON(@payload) <> 1
        THROW 51041, 'Invalid apartment endpoint payload.', 1;

    IF @endpoint='BASIC'
    BEGIN
        ;WITH source AS (
            SELECT @kaptCode AS kaptCode, parsed.kaptName, parsed.roadAddress, parsed.legalAddress,
                   parsed.postalCode, parsed.complexType, parsed.saleType, parsed.managementType, parsed.heatingType,
                   TRY_CONVERT(int,TRY_CONVERT(decimal(18,3),NULLIF(TRIM(parsed.buildingCount),N''))) AS buildingCount,
                   TRY_CONVERT(int,TRY_CONVERT(decimal(18,3),NULLIF(TRIM(parsed.householdCount),N''))) AS householdCount,
                   TRY_CONVERT(date,NULLIF(parsed.approvalDate,N''),112) AS approvalDate,
                   TRY_CONVERT(decimal(18,3),NULLIF(parsed.grossFloorArea,N'')) AS grossFloorArea,
                   TRY_CONVERT(decimal(18,3),NULLIF(parsed.managementArea,N'')) AS managementArea,
                   parsed.officePhone,parsed.officeFax,parsed.homepage
            FROM OPENJSON(@payload) WITH (
                kaptName nvarchar(500) '$.kaptName', roadAddress nvarchar(1000) '$.doroJuso',
                legalAddress nvarchar(1000) '$.kaptAddr', postalCode nvarchar(20) '$.zipcode',
                complexType nvarchar(100) '$.codeAptNm', saleType nvarchar(100) '$.codeSaleNm',
                managementType nvarchar(100) '$.codeMgrNm', heatingType nvarchar(100) '$.codeHeatNm',
                buildingCount nvarchar(40) '$.kaptDongCnt', householdCount nvarchar(40) '$.kaptdaCnt',
                approvalDate nvarchar(40) '$.kaptUsedate', grossFloorArea nvarchar(40) '$.kaptTarea',
                managementArea nvarchar(40) '$.kaptMarea', officePhone nvarchar(50) '$.kaptTel',
                officeFax nvarchar(50) '$.kaptFax', homepage nvarchar(1000) '$.kaptUrl'
            ) AS parsed
        )
        MERGE dbo.AptComplexDetail WITH (HOLDLOCK) AS target
        USING source ON target.kaptCode=source.kaptCode
        WHEN MATCHED THEN UPDATE SET
            kaptName=source.kaptName,roadAddress=source.roadAddress,legalAddress=source.legalAddress,
            postalCode=source.postalCode,complexType=source.complexType,saleType=source.saleType,
            managementType=source.managementType,heatingType=source.heatingType,
            buildingCount=source.buildingCount,householdCount=source.householdCount,
            approvalDate=source.approvalDate,grossFloorArea=source.grossFloorArea,
            managementArea=source.managementArea,officePhone=source.officePhone,officeFax=source.officeFax,
            homepage=source.homepage,rawJson=@payload,basicFetchedAt=SYSUTCDATETIME(),fetchedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(
            kaptCode,kaptName,roadAddress,legalAddress,postalCode,complexType,saleType,managementType,heatingType,
            buildingCount,householdCount,approvalDate,grossFloorArea,managementArea,officePhone,officeFax,homepage,
            rawJson,basicFetchedAt,fetchedAt)
        VALUES(source.kaptCode,source.kaptName,source.roadAddress,source.legalAddress,source.postalCode,
            source.complexType,source.saleType,source.managementType,source.heatingType,source.buildingCount,
            source.householdCount,source.approvalDate,source.grossFloorArea,source.managementArea,source.officePhone,
            source.officeFax,source.homepage,@payload,SYSUTCDATETIME(),SYSUTCDATETIME());
    END
    ELSE
    BEGIN
        MERGE dbo.AptComplexDetail WITH (HOLDLOCK) AS target
        USING (SELECT @kaptCode AS kaptCode) AS source ON target.kaptCode=source.kaptCode
        WHEN MATCHED THEN UPDATE SET extendedRawJson=@payload,extendedFetchedAt=SYSUTCDATETIME(),fetchedAt=SYSUTCDATETIME()
        WHEN NOT MATCHED THEN INSERT(kaptCode,extendedRawJson,extendedFetchedAt,fetchedAt)
          VALUES(source.kaptCode,@payload,SYSUTCDATETIME(),SYSUTCDATETIME());
    END;
END;
GO

IF OBJECT_ID(N'dbo.AptApiDailyUsage', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptApiDailyUsage (
        usageDate date NOT NULL,
        apiName varchar(20) NOT NULL,
        requestCount int NOT NULL CONSTRAINT DF_AptApiDailyUsage_Request DEFAULT 0,
        successCount int NOT NULL CONSTRAINT DF_AptApiDailyUsage_Success DEFAULT 0,
        failureCount int NOT NULL CONSTRAINT DF_AptApiDailyUsage_Failure DEFAULT 0,
        updatedAt datetime2(0) NOT NULL CONSTRAINT DF_AptApiDailyUsage_Updated DEFAULT SYSUTCDATETIME(),
        CONSTRAINT PK_AptApiDailyUsage PRIMARY KEY(usageDate,apiName),
        CONSTRAINT CK_AptApiDailyUsage_Api CHECK(apiName IN('LIST','BASIS')),
        CONSTRAINT CK_AptApiDailyUsage_Counts CHECK(requestCount>=0 AND successCount>=0 AND failureCount>=0 AND successCount+failureCount<=requestCount)
    );
END;
GO

IF OBJECT_ID(N'dbo.AptListMigrationState', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptListMigrationState (
        stateId tinyint NOT NULL CONSTRAINT PK_AptListMigrationState PRIMARY KEY CONSTRAINT CK_AptListMigrationState_Id CHECK(stateId=1),
        nextPage int NOT NULL,
        pageSize int NOT NULL,
        totalCount int NULL,
        cycleStartedAt datetime2(0) NULL,
        lastCompletedAt datetime2(0) NULL,
        lastCompletedDate date NULL,
        updatedAt datetime2(0) NOT NULL,
        CONSTRAINT CK_AptListMigrationState_NextPage CHECK(nextPage>=1),
        CONSTRAINT CK_AptListMigrationState_PageSize CHECK(pageSize BETWEEN 1 AND 1000)
    );
    INSERT dbo.AptListMigrationState(stateId,nextPage,pageSize,updatedAt) VALUES(1,1,500,SYSUTCDATETIME());
END;
GO

IF OBJECT_ID(N'dbo.AptDetailFetchState', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptDetailFetchState (
        kaptCode nvarchar(50) NOT NULL,
        endpoint varchar(20) NOT NULL,
        status varchar(20) NOT NULL,
        attemptCount int NOT NULL CONSTRAINT DF_AptDetailFetchState_Attempts DEFAULT 0,
        lastAttemptAt datetime2(0) NULL,
        nextAttemptAt datetime2(0) NULL,
        completedAt datetime2(0) NULL,
        lastError nvarchar(2000) NULL,
        CONSTRAINT PK_AptDetailFetchState PRIMARY KEY(kaptCode,endpoint),
        CONSTRAINT FK_AptDetailFetchState_AptComplex FOREIGN KEY(kaptCode) REFERENCES dbo.AptComplex(kaptCode),
        CONSTRAINT CK_AptDetailFetchState_Endpoint CHECK(endpoint IN('BASIC','EXTENDED')),
        CONSTRAINT CK_AptDetailFetchState_Status CHECK(status IN('SUCCEEDED','NO_DATA','FAILED')),
        CONSTRAINT CK_AptDetailFetchState_AttemptCount CHECK(attemptCount>=0)
    );
    CREATE INDEX IX_AptDetailFetchState_NextAttempt ON dbo.AptDetailFetchState(nextAttemptAt,status);
END;
GO

IF OBJECT_ID(N'dbo.AptDailyMigrationRun', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.AptDailyMigrationRun (
        runId bigint IDENTITY(1,1) NOT NULL CONSTRAINT PK_AptDailyMigrationRun PRIMARY KEY,
        businessDate date NOT NULL,
        startedAt datetime2(0) NOT NULL,
        completedAt datetime2(0) NULL,
        listRequests int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_ListRequests DEFAULT 0,
        listItems int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_ListItems DEFAULT 0,
        listTotal int NULL,
        detailRequests int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_DetailRequests DEFAULT 0,
        detailSaved int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_DetailSaved DEFAULT 0,
        detailNoData int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_DetailNoData DEFAULT 0,
        detailFailed int NOT NULL CONSTRAINT DF_AptDailyMigrationRun_DetailFailed DEFAULT 0,
        remainingEndpoints bigint NULL,
        status varchar(20) NOT NULL,
        error nvarchar(2000) NULL
    );
END;
GO

CREATE OR ALTER VIEW dbo.AptComplexWithDetail AS
SELECT a.kaptCode,a.kaptName,a.sido,a.sigungu,a.address,
       d.kaptName AS detailName,d.roadAddress,d.legalAddress,d.postalCode,
       d.complexType,d.saleType,d.managementType,d.heatingType,
       d.buildingCount,d.householdCount,d.approvalDate,d.grossFloorArea,d.managementArea,
       d.officePhone,d.officeFax,d.homepage,d.fetchedAt AS detailFetchedAt,
       d.basicFetchedAt,d.extendedFetchedAt
FROM dbo.AptComplex AS a
LEFT JOIN dbo.AptComplexDetail AS d ON d.kaptCode=a.kaptCode;
GO

IF DATABASE_PRINCIPAL_ID(N'MuteLabApiRole') IS NOT NULL
BEGIN
    GRANT SELECT ON OBJECT::dbo.AptComplex TO MuteLabApiRole;
    GRANT SELECT ON OBJECT::dbo.AptCollectionRun TO MuteLabApiRole;
    GRANT SELECT ON OBJECT::dbo.AptComplexDetail TO MuteLabApiRole;
    GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.AptApiDailyUsage TO MuteLabApiRole;
    GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.AptListMigrationState TO MuteLabApiRole;
    GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.AptDetailFetchState TO MuteLabApiRole;
    GRANT SELECT,INSERT,UPDATE ON OBJECT::dbo.AptDailyMigrationRun TO MuteLabApiRole;
    GRANT SELECT ON OBJECT::dbo.AptComplexWithDetail TO MuteLabApiRole;
    GRANT EXECUTE ON OBJECT::dbo.UpsertAptComplexListPage TO MuteLabApiRole;
    GRANT EXECUTE ON OBJECT::dbo.UpsertAptComplexEndpoint TO MuteLabApiRole;
END;
GO
