import type { Request, Response } from 'express';
import { memberDataKey, querySql } from './db';
import { sendNotificationEmail } from './verification-email';

type DecisionEmailJob = {
  NotificationId: number;
  Decision: string;
  Title: string;
  Message: string;
  Email: string;
  KaptName: string | null;
  EmailAttempts: number;
};

type DecisionNotificationRow = {
  NotificationId: number;
  Decision: string;
  Title: string;
  Message: string;
  CreatedAt: Date;
  ReadAt: Date | null;
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 500);
}

export async function initializeCommitteeDecisionNotifications(): Promise<void> {
  const [state] = await querySql<{ Ready: number }>(`
    SELECT CASE WHEN OBJECT_ID(N'dbo.ClaimCommitteeDecisionEmail',N'P') IS NOT NULL
      AND OBJECT_ID(N'dbo.CompleteCommitteeDecisionEmail',N'P') IS NOT NULL
      AND OBJECT_ID(N'dbo.GetCommitteeDecisionNotifications',N'P') IS NOT NULL
      AND OBJECT_ID(N'dbo.ReadCommitteeDecisionNotification',N'P') IS NOT NULL
      THEN 1 ELSE 0 END AS Ready;
  `);
  if (state?.Ready !== 1) {
    throw new Error('Committee decision notification schema is incomplete. Apply server/supervisor-schema.sql.');
  }
}

export async function retryPendingCommitteeDecisionEmail(emailFrom: string): Promise<boolean> {
  const [job] = await querySql<DecisionEmailJob>(`
    EXEC dbo.ClaimCommitteeDecisionEmail @MemberDataKey=@key;
  `, { key: memberDataKey });
  if (!job) return false;

  try {
    await sendNotificationEmail({
      from: emailFrom,
      to: job.Email,
      subject: `[MuteLab] ${job.Title}`,
      heading: job.Title,
      message: job.Message,
      details: [
        job.KaptName ? `단지: ${job.KaptName}` : '',
        `처리 결과: ${job.Decision === 'APPROVED' ? '승인' : '반려'}`,
      ].filter(Boolean),
      messageId: `mutelab-committee-decision-${job.NotificationId}`,
    });
    await querySql(`
      EXEC dbo.CompleteCommitteeDecisionEmail
        @NotificationId=@id,@Succeeded=1,@Error=NULL,@DelayMinutes=0;
    `, { id: job.NotificationId });
  } catch (error) {
    const delayMinutes = Math.min(360, 2 ** Math.min(Number(job.EmailAttempts), 8));
    await querySql(`
      EXEC dbo.CompleteCommitteeDecisionEmail
        @NotificationId=@id,@Succeeded=0,@Error=@error,@DelayMinutes=@delay;
    `, { id: job.NotificationId, error: errorText(error), delay: delayMinutes });
  }
  return true;
}

export async function committeeDecisionNotifications(_req: Request, res: Response): Promise<void> {
  const rows = await querySql<DecisionNotificationRow>(`
    EXEC dbo.GetCommitteeDecisionNotifications @MemberId=@memberId,@MemberDataKey=@key;
  `, { memberId: Number(res.locals.memberId), key: memberDataKey });
  res.json({ notifications: rows.map(row => ({
    notificationId: Number(row.NotificationId),
    decision: row.Decision,
    title: row.Title,
    message: row.Message,
    createdAt: new Date(row.CreatedAt).toISOString(),
    readAt: row.ReadAt ? new Date(row.ReadAt).toISOString() : null,
  })) });
}

export async function readCommitteeDecisionNotification(req: Request, res: Response): Promise<void> {
  const notificationId = Number(req.params.notificationId);
  if (!Number.isSafeInteger(notificationId) || notificationId < 1) {
    res.status(404).json({ error: '알림을 찾을 수 없습니다.' });
    return;
  }
  const [result] = await querySql<{ Updated: number }>(`
    EXEC dbo.ReadCommitteeDecisionNotification @MemberId=@memberId,@NotificationId=@notificationId;
  `, { memberId: Number(res.locals.memberId), notificationId });
  if (!result || Number(result.Updated) !== 1) {
    res.status(404).json({ error: '알림을 찾을 수 없습니다.' });
    return;
  }
  res.json({ notificationId, read: true });
}
