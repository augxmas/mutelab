# MuteLab local API

The Android app talks to this API over the laptop's private Wi-Fi address. The API connects to SQL Server Express on 127.0.0.1 using credentials stored only in the server .env file. Keep this process on a trusted private network.

## Run

1. Install Node.js 22 or later.
2. Copy `.env.example` to `.env`; set independent random secrets for `JWT_SECRET`, `EMAIL_CODE_SECRET`, and `MEMBER_DATA_KEY`.
3. Run `npm install`, then `npm run dev`.
4. Open `http://172.30.1.14:3100/api/health` from the laptop. Open `http://172.30.1.14:3100/committee` for the committee portal. The laptop address can change; update `API_BASE_URL` in the Android app when it does.
5. Allow inbound TCP port 3100 on the Windows **Private** firewall profile if Windows Firewall blocks the phone.

The `mutelab` database and SQL login are provisioned locally. The API creates its tables and encryption functions at startup and uses SQL authentication from the server .env file. Keep `MEMBER_DATA_KEY` private and back it up securely: encrypted member data cannot be decrypted if the key is lost. SQL Server must have Mixed Mode and TCP/IP enabled on 127.0.0.1:1433; restart the SQL Server service after changing those settings. Do not place SQL credentials or the encryption key in the Android app.

Member ID, email, profile and occurrence journal values are encrypted with the database functions `dbo.EncryptMemberData` and `dbo.DecryptMemberData`; keyed hashes support account lookup. New recordings are uploaded to SQL Server with a SHA-256 digest and a daily `yyyymmdd_0001` number. An insert-only trigger rejects updates and deletes on the original recording ledger. The report flow re-hashes the stored audio and compares it with the phone's original file before allowing it into the report list.

## Email verification

The API submits a six-digit code through the local Postfix sendmail interface. Set `EMAIL_FROM`, `EMAIL_CODE_SECRET`, and optionally `SENDMAIL_PATH` and `EMAIL_CODE_TTL_MINUTES`. Deploy behind HTTPS for Android clients. The server needs DNS and an outbound SMTP route. Successful signup returns a bearer session for completing the profile.

## Committee portal

`/committee` provides apartment selection, verified-email application, password login followed by email two-factor authentication, and the occurrence journal grid. A submitted application remains `PENDING` and cannot log in until an operator verifies the business-registration document and apartment affiliation. Approval transactionally assigns one of three seats; a complex may have one chair and up to three total committee members. Committee email addresses and mobile numbers are globally unique. Business registration uploads and member details are encrypted before storage.

The Android app uploads a separate committee-submission copy of the actual `.m4a` file before submitting an occurrence. The server computes that artifact's SHA-256 itself and compares both the artifact bytes and the immutable original recording bytes. A mismatch creates a resident in-app notification, sends an email, and blocks selection, printing, and download until the resident submits a matching file. The committee can filter applicant and alleged-source households, play the submitted artifact, open the audio analysis details, and print or download the official incident-log template. More than 13 selected occurrences continue on duplicated template pages. Set `COMMITTEE_PDF_FONT` to a Korean TrueType font available to the server. The Windows default in `.env.example` is Malgun Gothic.

If the API SQL login is intentionally restricted from DDL, apply `committee-schema.sql` once with a database administrator account before starting the updated server. The script is idempotent and grants the existing `MuteLabApiRole` only the table permissions used by the portal.

### Committee application approval

Run review from a separate back-office OS account and environment. Give every human reviewer an individual SQL login, add only those logins to `MuteLabCommitteeApproverRole`, and never add the API database user to this role. The procedures record `ORIGINAL_LOGIN()` as the reviewer, so the audit identity cannot be supplied or forged as a CLI argument. The API role can create and inspect only the minimal status/hash columns of an application and is explicitly denied access to the review and approval procedures.

1. Copy `.env.committee-review.example` to an access-controlled path outside the API checkout and service account, and fill it with the reviewer-specific SQL login and review secrets. The review CLI deliberately does not auto-load the API `.env`. Run `npm run build`, then inspect an application without overwriting an existing file:

   `npm run committee:review -- inspect 123 --review-env C:\secure-review\reviewer.env --out C:\secure-review\application-123.pdf`

   The command decrypts the authenticated AES-256-GCM document envelope, verifies its SHA-256, writes it with exclusive-create semantics, and prints the applicant/complex metadata needed for review. Keep the extracted document in access-controlled temporary storage and remove it according to the review retention policy. On Windows, Node's `0600` mode does not establish an NTFS ACL: create the review directory with inheritance disabled and access limited to the review operator before running the command, verify it with `icacls`, and do not grant the API service account access.
2. After verifying the business registration document and apartment affiliation, approve with the exact hash printed by `inspect`:

   `npm run committee:review -- approve 123 --review-env C:\secure-review\reviewer.env --document-sha256 64_HEX_CHARACTERS --note "단지 소속 확인"`

   The procedure serializes identity and complex-seat allocation, rechecks global login/email/mobile uniqueness, the one-chair rule, and the three-member limit, then creates the active member. Its result includes the authenticated SQL reviewer identity stored in the audit row.
3. To reject, run:

   `npm run committee:review -- reject 123 --review-env C:\secure-review\reviewer.env --note "반려 사유"`

Example role assignment, performed by a DBA after creating each reviewer-specific database user: `ALTER ROLE MuteLabCommitteeApproverRole ADD MEMBER [reviewer_specific_user];`

## API

- `POST /api/auth/email/start` — request a code for `signup`, `find-id`, `reset-password`, or `committee-signup`.
- `POST /api/auth/email/verify` — validate a code and issue a short-lived, one-use verification token.
- `POST /api/auth/signup`, `POST /api/auth/login`
- `POST /api/auth/find-id`, `POST /api/auth/password/reset`
- `GET /api/profile`, `PUT /api/profile` — requires a bearer token.
- `GET /api/apartments?name=단지명` — authenticated partial-name search, backed by `dbo.AptComplexWithDetail` from the apartment collector's detail schema.
- `POST /api/recordings/:recordNo/committee-audio` — upload the resident's actual `audio/mp4` submission artifact and receive its server-owned `artifactId`.
- `POST /api/recordings/:recordNo/committee-submission`, `DELETE /api/recordings/:recordNo/committee-submission` — submit an artifact-backed occurrence or withdraw it.
- `GET /api/notifications`, `POST /api/notifications/:notificationId/read` — retrieve and acknowledge resident integrity alerts.
- `GET /api/committee-contacts` — names and mobile numbers of committee members, available only after the signed-in resident has submitted an occurrence to that complex.
- `/api/committee/*` — committee signup, two-factor login, journal search, audio detail, and PDF export APIs used by `/committee`.

