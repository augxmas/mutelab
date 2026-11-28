import 'dotenv/config';
import { memberDataKey, querySql } from './db';
import { normalizeRoomNumber } from './room-number';

async function migrate(): Promise<void> {
  if (memberDataKey.length < 32) throw new Error('MEMBER_DATA_KEY must contain at least 32 characters.');
  const rows = await querySql<{ RecordNo: string; UserId: number; RoomNumber: string }>(`
    SELECT RecordNo, UserId, JSON_VALUE(journal.ValidJson, '$.otherHo') AS RoomNumber
    FROM dbo.NoiseIncidentJournals
    CROSS APPLY (VALUES (dbo.DecryptMemberData(JournalCipher, @key))) AS decrypted(ClearText)
    CROSS APPLY (VALUES (CASE WHEN ISJSON(decrypted.ClearText)=1 THEN decrypted.ClearText END)) AS journal(ValidJson)
    WHERE JSON_VALUE(journal.ValidJson, '$.otherHo') COLLATE Latin1_General_100_BIN2 LIKE N'%[^0-9]%'
  `, { key: memberDataKey });
  let migrated = 0;
  for (const row of rows) {
    const [result] = await querySql<{ Updated: number }>(`
      UPDATE j SET JournalCipher=dbo.EncryptMemberData(
        JSON_MODIFY(journal.ValidJson, '$.otherHo', @roomNumber), @key)
      FROM dbo.NoiseIncidentJournals AS j
      CROSS APPLY (VALUES (dbo.DecryptMemberData(j.JournalCipher, @key))) AS decrypted(ClearText)
      CROSS APPLY (VALUES (CASE WHEN ISJSON(decrypted.ClearText)=1 THEN decrypted.ClearText END)) AS journal(ValidJson)
      WHERE j.RecordNo=@recordNo AND j.UserId=@userId
        AND JSON_VALUE(journal.ValidJson, '$.otherHo') COLLATE Latin1_General_100_BIN2 = @previousRoomNumber;
      SELECT @@ROWCOUNT AS Updated;
    `, { key: memberDataKey, recordNo: row.RecordNo, userId: row.UserId,
      previousRoomNumber: row.RoomNumber, roomNumber: normalizeRoomNumber(row.RoomNumber) });
    migrated += result?.Updated ?? 0;
  }
  console.log(`Updated ${migrated} incident journal room numbers.`);
}

migrate().then(() => process.exit(0)).catch(error => {
  console.error('Incident journal room number migration failed:', error.message);
  process.exit(1);
});
