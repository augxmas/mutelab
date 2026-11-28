import crypto from 'node:crypto';
import { committeeDocumentType } from './committee-document-type';

const encryptionKey = (key: string) => crypto.createHash('sha256').update(key).update(':inquiry-attachment:v1').digest();

export function encryptInquiryImage(value: unknown, key: string) {
  if (typeof value !== 'string' || value.length > 2_796_204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  const type = committeeDocumentType(bytes);
  if (!type?.mime.startsWith('image/') || bytes.length > 2 * 1024 * 1024) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(key), iv);
  return { cipher: Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]), mime: type.mime };
}

export function decryptInquiryImage(cipher: Buffer, key: string): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(key), cipher.subarray(0, 12));
  decipher.setAuthTag(cipher.subarray(-16));
  return Buffer.concat([decipher.update(cipher.subarray(12, -16)), decipher.final()]);
}

export type InquiryRow = { InquiryId: number; ComplexName?: string; CreatedAt: Date; RepliedAt: Date | null;
  AttachmentType: string | null; Question: string; Reply: string | null };

export function formatInquiry(row: InquiryRow) {
  const question = JSON.parse(row.Question) as { title: string; content: string };
  return { id: row.InquiryId, title: question.title, content: question.content, complexName: row.ComplexName,
    hasImage: Boolean(row.AttachmentType), createdAt: row.CreatedAt, repliedAt: row.RepliedAt, reply: row.Reply };
}
