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
  const parameters = { memberId: Number(res.locals.memberId), kaptCode: res.locals.kaptCode, key: memberDataKey };
  const [rows, replies] = await Promise.all([
    querySql<DecisionNotificationRow & { UnreadCount: number }>(`
      EXEC dbo.GetCommitteeDecisionNotifications @MemberId=@memberId,@MemberDataKey=@key;
    `, parameters),
    querySql<{ InquiryId: number; Question: string; Reply: string; RepliedAt: Date; ReplyReadAt: Date | null; UnreadCount: number }>(`
      SELECT TOP (50) InquiryId,RepliedAt,ReplyReadAt,
        COUNT(CASE WHEN ReplyReadAt IS NULL THEN 1 END) OVER () AS UnreadCount,
        dbo.DecryptMemberData(QuestionCipher,@key) AS Question,dbo.DecryptMemberData(ReplyCipher,@key) AS Reply
      FROM dbo.CommitteeInquiries WHERE MemberId=@memberId AND KaptCode=@kaptCode AND RepliedAt IS NOT NULL
      ORDER BY CASE WHEN ReplyReadAt IS NULL THEN 0 ELSE 1 END,RepliedAt DESC,InquiryId DESC
    `, parameters),
  ]);
  const decisions = rows.map(row => ({
    kind: 'decision',
    notificationId: Number(row.NotificationId),
    decision: row.Decision,
    title: row.Title,
    message: row.Message,
    createdAt: new Date(row.CreatedAt).toISOString(),
    readAt: row.ReadAt ? new Date(row.ReadAt).toISOString() : null,
  }));
  const answers = replies.map(row => ({
    kind: 'inquiry', notificationId: row.InquiryId, decision: 'REPLIED',
    title: `문의 답변 · ${JSON.parse(row.Question).title}`, message: row.Reply,
    createdAt: new Date(row.RepliedAt).toISOString(), readAt: row.ReplyReadAt ? new Date(row.ReplyReadAt).toISOString() : null,
  }));
  const notifications = [...decisions, ...answers].sort((a, b) => Number(Boolean(a.readAt)) - Number(Boolean(b.readAt))
    || b.createdAt.localeCompare(a.createdAt));
  res.json({ notifications, unreadCount: (rows[0]?.UnreadCount ?? decisions.filter(row => !row.readAt).length)
    + (replies[0]?.UnreadCount ?? 0) });
}

export async function committeeUnreadNotificationCount(_req: Request, res: Response): Promise<void> {
  const memberId = Number(res.locals.memberId);
  const [decisions, replies] = await Promise.all([
    querySql<{ UnreadCount: number }>(`
      EXEC dbo.GetCommitteeDecisionNotifications @MemberId=@memberId,@MemberDataKey=@key,@CountOnly=1;
    `, { memberId, key: memberDataKey }),
    querySql<{ UnreadCount: number }>(`
      SELECT COUNT(*) AS UnreadCount FROM dbo.CommitteeInquiries
      WHERE MemberId=@memberId AND KaptCode=@kaptCode AND RepliedAt IS NOT NULL AND ReplyReadAt IS NULL;
    `, { memberId, kaptCode: res.locals.kaptCode }),
  ]);
  res.json({ unreadCount: (decisions[0]?.UnreadCount ?? 0) + (replies[0]?.UnreadCount ?? 0) });
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
