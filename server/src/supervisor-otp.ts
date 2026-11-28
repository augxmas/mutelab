import crypto from 'node:crypto';

export function otpSetupKey(secret: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, buffer = 0, encoded = '';
  for (const byte of secret) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(buffer >>> bits) & 31];
    }
  }
  return bits ? encoded + alphabet[(buffer << (5 - bits)) & 31] : encoded;
}

export function matchingOtpStep(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  const input = Buffer.alloc(8);
  for (const step of [current, current - 1, current + 1]) {
    if (step < 0 || step <= lastStep) continue;
    input.writeBigUInt64BE(BigInt(step));
    const mac = crypto.createHmac('sha1', secret).update(input).digest();
    const offset = mac[mac.length - 1] & 15;
    const expected = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return step;
  }
  return null;
}
