export function normalizeRoomNumber(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[^0-9]/g, '') : '';
}
