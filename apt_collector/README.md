# 공동주택 공공데이터 일일 이관기

국토교통부 공동주택 API의 단지 목록과 단지별 기본·상세 정보를 SQL Server로 이관합니다. 매일 한 번 실행되고, 서울 시간 기준 API별 일일 사용량을 DB에 기록해 5,000회를 넘지 않습니다. 중단되면 저장된 목록 페이지와 단지별 상태에서 재개합니다.

수집 범위는 다음과 같습니다.

- [단지 목록 서비스](https://www.data.go.kr/data/15057332/openapi.do)의 `getTotalAptList4`: 정규화한 단지명·주소와 응답 원문을 `dbo.AptComplex`에 저장
- [기본 정보제공 서비스](https://www.data.go.kr/data/15058453/openapi.do)의 `getAphusBassInfoV5`: 주요 필드와 응답 원문을 `dbo.AptComplexDetail.rawJson`에 저장
- 같은 기본 정보제공 서비스의 `getAphusDtlInfoV5`: 전체 응답 원문을 `dbo.AptComplexDetail.extendedRawJson`에 저장

기본 정보와 상세 정보는 같은 `BASIS` 서비스의 5,000회 예산을 공유합니다. 단지 하나를 완성하는 데 정상적으로 2회가 필요하므로 하루 약 2,500개 단지가 처리되며, 재시도 발생 시 그보다 적을 수 있습니다. 목록 서비스는 별도 5,000회 예산을 사용합니다.

## 최초 설정

PowerShell에서 의존성을 설치하고 빌드합니다.

Node.js 20.6 이상이 필요합니다(`--env-file` 사용).

```powershell
cd C:\proj\mutelab\apt_collector
npm install
npm run build
```

`../server/.env`에 `DATA_GO_KR_SERVICE_KEY`를 추가합니다. 키는 저장소에 커밋하거나 로그에 출력하지 마세요. SQL 접속 정보는 기존 `SQL_SERVER`, `SQL_PORT`, `SQL_DATABASE`, `DB_USER`, `DB_PASSWORD`를 그대로 사용합니다.

DBA 계정으로 [daily-schema.sql](daily-schema.sql)을 대상 DB에 한 번 적용해야 합니다. 일반 앱 계정에는 테이블 생성 권한이 없어 자동 생성하지 않습니다. 스키마는 원문 JSON, 일일 호출 원장, 목록 커서, 단지별 성공·무자료·실패 상태, 실행 이력을 만듭니다.

수동으로 한 회차를 실행합니다.

```powershell
npm run preflight
npm run daily
```

`preflight`는 서비스키 값은 표시하지 않고 설정 여부, 이관 스키마 적용 여부, 현재 DB 계정의 테이블 생성 권한만 확인합니다.

한 회차가 끝나면 프로세스도 종료됩니다. 동시 실행은 SQL Server 애플리케이션 잠금으로 차단됩니다.

## 매일 자동 실행

빌드와 환경 설정, DB 스키마 적용을 마친 뒤 Windows 예약 작업을 등록합니다. 기본 실행 시각은 매일 03:10(호스트가 서울 시간대인 경우 KST)입니다.

```powershell
.\install-daily-task.ps1
```

등록 직후 첫 실행도 시작하려면 다음과 같이 실행합니다.

```powershell
.\install-daily-task.ps1 -RunNow
```

중복 실행은 무시되고, 실패하면 15분 간격으로 최대 3회 재시도합니다. 로그는 `apt_collector/logs`에 생성되며 Git에는 포함되지 않습니다.

Linux 서버에서는 같은 동작을 매일 03:10 cron으로 등록할 수 있습니다.

```cron
10 3 * * * cd /opt/mutelab/apt_collector && mkdir -p logs && /usr/bin/node --env-file=../server/.env dist/daily-collector.js --daily >> logs/cron.log 2>&1
```

## 주요 설정

| 변수 | 기본값 | 설명 |
|---|---:|---|
| `DATA_GO_KR_SERVICE_KEY` | 없음 | 공공데이터포털 서비스 키, 필수 |
| `APT_LIST_PAGE_SIZE` | 500 | 목록 API 페이지 크기 |
| `APT_LIST_DAILY_REQUEST_LIMIT` | 5000 | 목록 서비스 일일 최대 요청 수 |
| `APT_BASIS_DAILY_REQUEST_LIMIT` | 5000 | 기본·상세 서비스 합산 일일 최대 요청 수 |
| `APT_LIST_REQUEST_DELAY_MS` | 200 | 목록 호출 사이 최소 지연 |
| `APT_DETAIL_REQUEST_DELAY_MS` | 1250 | 기본·상세 호출 사이 최소 지연 |
| `APT_DETAIL_REFRESH_DAYS` | 30 | 성공 데이터 재수집 주기 |
| `APT_NO_DATA_RETRY_DAYS` | 7 | 무자료 응답 재확인 주기 |
| `APT_FAILED_RETRY_MINUTES` | 60 | 실패 재시도 기본 간격, 반복 실패 시 지수 증가 |
| `APT_HTTP_RETRIES` | 3 | 한 항목의 HTTP 재시도 횟수. 재시도도 일일 한도에 포함 |

## 진행 상태 확인

```sql
SELECT * FROM dbo.AptApiDailyUsage ORDER BY usageDate DESC,apiName;
SELECT TOP (20) * FROM dbo.AptDailyMigrationRun ORDER BY runId DESC;
SELECT status,endpoint,COUNT(*) AS count
FROM dbo.AptDetailFetchState GROUP BY status,endpoint ORDER BY endpoint,status;
SELECT COUNT(*) AS apartmentCount FROM dbo.AptComplex;
SELECT COUNT(*) AS detailCount FROM dbo.AptComplexDetail;
```

`remainingEndpoints=0`이면 현재 목록에 포함된 모든 단지의 기본·상세 정보가 한 차례 성공 또는 무자료로 확인된 상태입니다. 이후에는 설정된 주기에 따라 변경 정보를 다시 수집합니다.
