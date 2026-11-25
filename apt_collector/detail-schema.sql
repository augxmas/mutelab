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
        grossFloorArea decimal(18, 3) NULL,
        managementArea decimal(18, 3) NULL,
        officePhone nvarchar(50) NULL,
        officeFax nvarchar(50) NULL,
        homepage nvarchar(1000) NULL,
        rawJson nvarchar(max) NOT NULL,
        fetchedAt datetime2(0) NOT NULL,
        CONSTRAINT FK_AptComplexDetail_AptComplex FOREIGN KEY(kaptCode) REFERENCES dbo.AptComplex(kaptCode),
        CONSTRAINT CK_AptComplexDetail_rawJson CHECK (ISJSON(rawJson) = 1)
    );
END;
GO

CREATE OR ALTER VIEW dbo.AptComplexWithDetail AS
SELECT a.kaptCode, a.kaptName, a.sido, a.sigungu, a.address,
       d.kaptName AS detailName, d.roadAddress, d.legalAddress, d.postalCode,
       d.complexType, d.saleType, d.managementType, d.heatingType,
       d.buildingCount, d.householdCount, d.approvalDate, d.grossFloorArea, d.managementArea,
       d.officePhone, d.officeFax, d.homepage, d.fetchedAt AS detailFetchedAt
FROM dbo.AptComplex AS a
LEFT JOIN dbo.AptComplexDetail AS d ON d.kaptCode = a.kaptCode;
GO

IF DATABASE_PRINCIPAL_ID(N'MuteLabApiRole') IS NOT NULL
    GRANT SELECT ON OBJECT::dbo.AptComplexWithDetail TO [MuteLabApiRole];
GO

CREATE OR ALTER PROCEDURE dbo.UpsertAptComplexDetails @payload nvarchar(max) AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    IF @payload IS NULL OR ISJSON(@payload, ARRAY) <> 1
        THROW 51022, 'Expected a JSON array of apartment details.', 1;

    DECLARE @fetchedAt datetime2(0) = SYSUTCDATETIME();

    ;WITH source AS (
        SELECT parsed.kaptCode, parsed.kaptName, parsed.roadAddress, parsed.legalAddress,
               parsed.postalCode, parsed.complexType, parsed.saleType, parsed.managementType, parsed.heatingType,
               TRY_CONVERT(int, TRY_CONVERT(decimal(18,3), NULLIF(TRIM(parsed.buildingCount), N''))) AS buildingCount,
               TRY_CONVERT(int, TRY_CONVERT(decimal(18,3), NULLIF(TRIM(parsed.householdCount), N''))) AS householdCount,
               TRY_CONVERT(date, NULLIF(parsed.approvalDate, N''), 112) AS approvalDate,
               TRY_CONVERT(decimal(18,3), NULLIF(parsed.grossFloorArea, N'')) AS grossFloorArea,
               TRY_CONVERT(decimal(18,3), NULLIF(parsed.managementArea, N'')) AS managementArea,
               parsed.officePhone, parsed.officeFax, parsed.homepage, items.[value] AS rawJson
        FROM OPENJSON(@payload) AS items
        CROSS APPLY OPENJSON(items.[value]) WITH (
            kaptCode nvarchar(50) '$.kaptCode',
            kaptName nvarchar(500) '$.kaptName',
            roadAddress nvarchar(1000) '$.doroJuso',
            legalAddress nvarchar(1000) '$.kaptAddr',
            postalCode nvarchar(20) '$.zipcode',
            complexType nvarchar(100) '$.codeAptNm',
            saleType nvarchar(100) '$.codeSaleNm',
            managementType nvarchar(100) '$.codeMgrNm',
            heatingType nvarchar(100) '$.codeHeatNm',
            buildingCount nvarchar(40) '$.kaptDongCnt',
            householdCount nvarchar(40) '$.kaptdaCnt',
            approvalDate nvarchar(40) '$.kaptUsedate',
            grossFloorArea nvarchar(40) '$.kaptTarea',
            managementArea nvarchar(40) '$.kaptMarea',
            officePhone nvarchar(50) '$.kaptTel',
            officeFax nvarchar(50) '$.kaptFax',
            homepage nvarchar(1000) '$.kaptUrl'
        ) AS parsed
    )
    MERGE dbo.AptComplexDetail WITH (HOLDLOCK) AS target
    USING source ON target.kaptCode = source.kaptCode
    WHEN MATCHED THEN UPDATE SET
        kaptName=source.kaptName, roadAddress=source.roadAddress, legalAddress=source.legalAddress,
        postalCode=source.postalCode, complexType=source.complexType, saleType=source.saleType,
        managementType=source.managementType, heatingType=source.heatingType, buildingCount=source.buildingCount,
        householdCount=source.householdCount, approvalDate=source.approvalDate, grossFloorArea=source.grossFloorArea,
        managementArea=source.managementArea, officePhone=source.officePhone, officeFax=source.officeFax,
        homepage=source.homepage, rawJson=source.rawJson, fetchedAt=@fetchedAt
    WHEN NOT MATCHED THEN INSERT (
        kaptCode,kaptName,roadAddress,legalAddress,postalCode,complexType,saleType,managementType,heatingType,
        buildingCount,householdCount,approvalDate,grossFloorArea,managementArea,officePhone,officeFax,homepage,rawJson,fetchedAt
    ) VALUES (
        source.kaptCode,source.kaptName,source.roadAddress,source.legalAddress,source.postalCode,source.complexType,
        source.saleType,source.managementType,source.heatingType,source.buildingCount,source.householdCount,
        source.approvalDate,source.grossFloorArea,source.managementArea,source.officePhone,source.officeFax,source.homepage,
        source.rawJson,@fetchedAt
    );
END;
GO
