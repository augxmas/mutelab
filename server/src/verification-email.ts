import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export type EmailPurpose = 'signup' | 'find-id' | 'reset-password' | 'committee-signup' | 'committee-login';

interface VerificationEmail {
  from: string;
  to: string;
  code: string;
  ttlMinutes: number;
  purpose: EmailPurpose;
  preview?: boolean;
}

const titles = {
  signup: '회원가입 이메일 인증',
  'find-id': '아이디 찾기 이메일 인증',
  'reset-password': '비밀번호 재설정 이메일 인증',
  'committee-signup': '위원회 회원가입 이메일 인증',
  'committee-login': '위원회 로그인 2차 인증',
};

function encodedLines(value: string): string[] {
  return Buffer.from(value, 'utf8').toString('base64').match(/.{1,76}/g) ?? [];
}

export async function sendVerificationEmail(options: VerificationEmail): Promise<void> {
  const { from, to, code, ttlMinutes, purpose, preview = false } = options;
  if (!/^\d{6}$/.test(code) || !Number.isSafeInteger(ttlMinutes) || /[\r\n]/.test(from + to)) {
    throw new Error('Invalid verification email data');
  }
  const heading = titles[purpose];
  const intro = preview ? '메일 디자인을 확인하는 예시입니다. 아래 코드는 인증에 사용할 수 없습니다.'
    : '앱의 이메일 인증 화면에 아래 6자리 코드를 입력해 주세요.';
  const validity = preview ? '' : `인증코드는 발급 후 ${ttlMinutes}분간 유효합니다.`;
  const notice = '본인이 요청하지 않았다면 이 메일을 무시하셔도 됩니다.';
  const plain = ['MuteLab', heading, '', intro, '', code, ...(validity ? [validity] : []), '', notice].join('\r\n');
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head>
<body style="margin:0;background:#f5f5ef;color:#273730;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5ef"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:520px;background:#fff;border:1px solid #d8e1d9;border-radius:16px">
<tr><td style="padding:18px 26px;background:#3e6051;border-radius:15px 15px 0 0;color:#fff;font-size:20px;font-weight:700">MuteLab</td></tr>
<tr><td style="padding:26px">
<h1 style="margin:0 0 12px;font-size:23px;line-height:1.35;color:#273730">${heading}</h1>
<p style="margin:0 0 20px;color:#47584f">${intro}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:16px 10px;background:#eef4ef;border:1px solid #d8e1d9;border-radius:12px">
<div style="font-size:13px;color:#47584f">인증코드</div>
<div style="color:#273730;font:700 34px/1.45 Consolas,'Courier New',monospace;letter-spacing:.16em">${code}</div>
</td></tr></table>
${validity ? `<p style="margin:18px 0 0;color:#47584f;font-size:14px">${validity}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid #e0e7e1;color:#526359;font-size:13px">${notice}</td></tr>
</table>
</td></tr></table>
</body></html>`;
  const boundary = `mutelab-${randomUUID()}`;
  const message = [
    `From: MuteLab <${from}>`, `To: ${to}`,
    `Subject: ${preview ? '[Preview] ' : ''}MuteLab`,
    ` =?UTF-8?B?${Buffer.from(heading).toString('base64')}?=`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    ...encodedLines(plain),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    ...encodedLines(html),
    `--${boundary}--`, '',
  ].join('\r\n');

  await new Promise<void>((resolve, reject) => {
    const mailer = spawn(process.env.SENDMAIL_PATH ?? '/usr/sbin/sendmail', ['-i', '-f', from, '--', to], {
      stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000,
    });
    mailer.once('error', reject);
    mailer.once('close', status => status === 0 ? resolve() : reject(new Error('Local mail submission failed')));
    mailer.stdin.on('error', reject);
    mailer.stdin.end(message);
  });
}

interface NotificationEmail {
  from: string;
  to: string;
  subject: string;
  heading: string;
  message: string;
  details?: string[];
  messageId?: string;
}

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, character => replacements[character] ?? character);
}

export async function sendNotificationEmail(options: NotificationEmail): Promise<void> {
  const { from, to, subject, heading, message, details = [], messageId } = options;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)
      || !subject.trim() || !heading.trim() || !message.trim()
      || /[\r\n]/.test(from + to + subject) || subject.length > 150 || message.length > 4000
      || (messageId !== undefined && !/^[A-Za-z0-9._+-]{1,120}$/.test(messageId))) {
    throw new Error('Invalid notification email data');
  }
  const safeDetails = details.map(value => value.replace(/[\r\n]+/g, ' ').slice(0, 500));
  const plain = ['MuteLab', heading, '', message, ...safeDetails.flatMap(value => ['', value]), '',
    '본 메일은 층간소음 발생일지 처리와 관련된 필수 안내입니다.'].join('\r\n');
  const detailHtml = safeDetails.length
    ? `<ul style="margin:18px 0 0;padding-left:22px;color:#47584f">${safeDetails.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul>`
    : '';
  const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#f5f5ef;color:#273730;font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','Malgun Gothic',sans-serif">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f5ef"><tr><td align="center" style="padding:28px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border:1px solid #d8e1d9;border-radius:16px">
<tr><td style="padding:18px 26px;background:#3e6051;border-radius:15px 15px 0 0;color:#fff;font-size:20px;font-weight:700">MuteLab</td></tr>
<tr><td style="padding:26px"><h1 style="margin:0 0 12px;font-size:23px;line-height:1.35;color:#273730">${escapeHtml(heading)}</h1>
<p style="margin:0;color:#47584f">${escapeHtml(message)}</p>${detailHtml}</td></tr>
<tr><td style="padding:16px 26px;border-top:1px solid #e0e7e1;color:#526359;font-size:13px">본 메일은 층간소음 발생일지 처리와 관련된 필수 안내입니다.</td></tr>
</table></td></tr></table></body></html>`;
  const boundary = `mutelab-${randomUUID()}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const email = [
    `From: MuteLab <${from}>`, `To: ${to}`, `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${messageId ?? randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    ...encodedLines(plain),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    ...encodedLines(html), `--${boundary}--`, '',
  ].join('\r\n');

  await new Promise<void>((resolve, reject) => {
    const mailer = spawn(process.env.SENDMAIL_PATH ?? '/usr/sbin/sendmail', ['-i', '-f', from, '--', to], {
      stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000,
    });
    mailer.once('error', reject);
    mailer.once('close', status => status === 0 ? resolve() : reject(new Error('Local mail submission failed')));
    mailer.stdin.on('error', reject);
    mailer.stdin.end(email);
  });
}
