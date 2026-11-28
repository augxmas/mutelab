export function committeeDocumentType(bytes: Buffer): { mime: string; extension: string } | null {
  const header = bytes.toString('latin1', 0, 12);
  if (header.startsWith('%PDF-')) return { mime: 'application/pdf', extension: 'pdf' };
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { mime: 'image/png', extension: 'png' };
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return { mime: 'image/jpeg', extension: 'jpg' };
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return { mime: 'image/gif', extension: 'gif' };
  if (header.startsWith('RIFF') && header.slice(8) === 'WEBP'
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) {
    return { mime: 'image/webp', extension: 'webp' };
  }
  return null;
}
