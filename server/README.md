# MuteLab local API

The Android app talks to this API over the laptop's private Wi-Fi address. The API connects to SQL Server Express on 127.0.0.1 using credentials stored only in the server .env file. Keep this process on a trusted private network.

## Run

1. Install Node.js 22 or later.
2. Copy `.env.example` to `.env`; set independent random secrets for `JWT_SECRET`, `MOCK_EMAIL_SECRET`, and `MEMBER_DATA_KEY`.
3. Run `npm install`, then `npm run dev`.
4. Open `http://172.30.1.14:3100/api/health` from the laptop. The laptop address can change; update `API_BASE_URL` in the Android app when it does.
5. Allow inbound TCP port 3100 on the Windows **Private** firewall profile if Windows Firewall blocks the phone.

The `mutelab` database and SQL login are provisioned locally. The API creates its tables and encryption functions at startup and uses SQL authentication from the server .env file. Keep `MEMBER_DATA_KEY` private and back it up securely: encrypted member data cannot be decrypted if the key is lost. SQL Server must have Mixed Mode and TCP/IP enabled on 127.0.0.1:1433; restart the SQL Server service after changing those settings. Do not place SQL credentials or the encryption key in the Android app.

Member ID, email, profile and occurrence journal values are encrypted with the database functions `dbo.EncryptMemberData` and `dbo.DecryptMemberData`; keyed hashes support account lookup. New recordings are uploaded to SQL Server with a SHA-256 digest and a daily `yyyymmdd_0001` number. An insert-only trigger rejects updates and deletes on the original recording ledger. The report flow re-hashes the stored audio and compares it with the phone's original file before allowing it into the report list.

## Simulated email verification

With `MOCK_EMAIL=true`, `/auth/email/start` returns a one-time code in its response. The app displays it as a development-only simulated email. No code is sent over email. Set `MOCK_EMAIL=false` when a mail provider is configured; code delivery then needs to be implemented before account recovery can be used.

## API

- `POST /api/auth/email/start` — request a code for `signup`, `find-id`, or `reset-password`.
- `POST /api/auth/email/verify` — validate a code and issue a short-lived, one-use verification token.
- `POST /api/auth/signup`, `POST /api/auth/login`
- `POST /api/auth/find-id`, `POST /api/auth/password/reset`
- `GET /api/profile`, `PUT /api/profile` — requires a bearer token.

