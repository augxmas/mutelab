import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { parse as parseEnv } from 'dotenv';
import { ConnectionPool } from 'mssql';

type ReviewRow = {
  ApplicationId: number;
  KaptCode: string;
  RequestedRole: string;
  Email: string;
  MemberJson: string;
  DocumentCipher: Buffer;
  DocumentSha256: string;
  ConsentedAt: Date;
  SubmittedAt: Date;
};

function option(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : '';
}

function required(value: string, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function decryptDocument(envelope: Buffer, memberDataKey: string): Buffer {
  if (!Buffer.isBuffer(envelope) || envelope.length <= 28) throw new Error('The encrypted document envelope is invalid.');
  const key = crypto.createHash('sha256').update(memberDataKey).update(':committee-document').digest();
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(envelope.length - 16);
  const cipherText = envelope.subarray(12, envelope.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

async function main(): Promise<void> {
  const action = process.argv[2] ?? '';
  const applicationId = Number(process.argv[3]);
  if (!['inspect', 'approve', 'reject'].includes(action) || !Number.isSafeInteger(applicationId) || applicationId < 1) {
    throw new Error('Usage: committee:review <inspect|approve|reject> <applicationId> [--review-env <path>] [options]');
  }
  const reviewEnvPath = option('--review-env').trim();
  let reviewEnvironment: Record<string, string | undefined> = process.env;
  if (reviewEnvPath) {
    try {
      reviewEnvironment = parseEnv(await readFile(path.resolve(reviewEnvPath)));
    } catch (error) {
      throw new Error(`Unable to load the dedicated review environment: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const memberDataKey = required(reviewEnvironment.MEMBER_DATA_KEY ?? '', 'MEMBER_DATA_KEY is required.');
  if (memberDataKey.length < 32) throw new Error('MEMBER_DATA_KEY must contain at least 32 characters.');
  const user = required(reviewEnvironment.COMMITTEE_APPROVER_DB_USER ?? '', 'COMMITTEE_APPROVER_DB_USER is required.');
  const password = required(reviewEnvironment.COMMITTEE_APPROVER_DB_PASSWORD ?? '', 'COMMITTEE_APPROVER_DB_PASSWORD is required.');
  const pool = await new ConnectionPool({
    user,
    password,
    server: reviewEnvironment.SQL_SERVER ?? '127.0.0.1',
    port: Number(reviewEnvironment.SQL_PORT ?? 1433),
    database: reviewEnvironment.SQL_DATABASE ?? 'mutelab',
    connectionTimeout: 8_000,
    requestTimeout: 30_000,
    options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true },
  }).connect();
  try {
    if (action === 'inspect') {
      const output = required(option('--out'), '--out <document path> is required for inspect.');
      const result = await pool.request()
        .input('ApplicationId', applicationId)
        .input('MemberDataKey', memberDataKey)
        .execute<ReviewRow>('dbo.GetCommitteeApplicationForReview');
      const row = result.recordset[0];
      if (!row) throw new Error('The pending committee application was not found.');
      const document = decryptDocument(row.DocumentCipher, memberDataKey);
      const sha256 = crypto.createHash('sha256').update(document).digest('hex').toUpperCase();
      if (sha256 !== row.DocumentSha256.trim().toUpperCase()) throw new Error('The decrypted document hash does not match the application.');
      const target = path.resolve(output);
      await writeFile(target, document, { flag: 'wx', mode: 0o600 });
      let member: unknown = row.MemberJson;
      try { member = JSON.parse(row.MemberJson); } catch { /* show the authenticated raw value */ }
      console.log(JSON.stringify({
        applicationId: Number(row.ApplicationId), kaptCode: row.KaptCode, requestedRole: row.RequestedRole,
        email: row.Email, member, documentSha256: sha256, documentPath: target,
        consentedAt: row.ConsentedAt, submittedAt: row.SubmittedAt,
      }, null, 2));
      return;
    }

    const note = required(option('--note'), '--note <review note> is required.').trim();
    if (note.length > 1_000) throw new Error('Review note is too long.');
    if (action === 'approve') {
      const documentSha256 = required(option('--document-sha256'), '--document-sha256 <SHA-256> is required.').toUpperCase();
      if (!/^[A-F0-9]{64}$/.test(documentSha256)) throw new Error('Document SHA-256 must be 64 hexadecimal characters.');
      const result = await pool.request()
        .input('ApplicationId', applicationId)
        .input('ReviewedDocumentSha256', documentSha256)
        .input('ReviewNote', note)
        .input('MemberDataKey', memberDataKey)
        .execute('dbo.ApproveCommitteeApplication');
      console.log(JSON.stringify({ status: 'APPROVED', ...result.recordset[0] }, null, 2));
      return;
    }
    const result = await pool.request()
      .input('ApplicationId', applicationId)
      .input('ReviewNote', note)
      .input('MemberDataKey', memberDataKey)
      .execute('dbo.RejectCommitteeApplication');
    console.log(JSON.stringify({ status: 'REJECTED', ...result.recordset[0] }, null, 2));
  } finally {
    await pool.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
