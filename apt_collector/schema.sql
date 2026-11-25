/* Run this while connected to the intended collector database. */
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
