import path from 'node:path';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PageSizes, type PDFPage, type PDFFont, rgb } from 'pdf-lib';
import type { CommitteeIncident } from './committee-data';

const templatePath = path.resolve(__dirname, '../../app/src/main/assets/forms/noise_incident_log.pdf');
const defaultFontPath = process.platform === 'win32'
  ? 'C:/Windows/Fonts/malgun.ttf'
  : '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf';
const ink = rgb(0.10, 0.14, 0.19);
// Boundaries measured from the vector lines in the official form, in PDF points.
const rowEdges = [243.12, 272.64, 302.52, 332.52, 362.52, 392.52, 422.4, 452.4,
  482.4, 512.4, 542.28, 572.28, 602.28, 632.28];
const rowsPerPage = rowEdges.length - 1;

function drawCell(page: PDFPage, font: PDFFont, value: string, left: number, right: number,
  top: number, bottom: number, maximum = 10, centered = false): void {
  const text = value.replace(/[\r\n]+/g, ' ').trim();
  if (!text) return;
  const available = right - left - 8;
  const size = maximum * Math.min(1, available / font.widthOfTextAtSize(text, maximum));
  const width = font.widthOfTextAtSize(text, size);
  const x = centered ? (left + right - width) / 2 : left + 4;
  const ascent = font.heightAtSize(size, { descender: false });
  const descent = font.heightAtSize(size) - ascent;
  const y = page.getHeight() - (top + bottom + ascent - descent) / 2;
  page.drawText(text, { x, y, size, font, color: ink });
}

const unit = (dong: string, ho: string) => [dong && `${dong.replace(/동$/, '')}동`, ho && `${ho.replace(/호$/, '')}호`].filter(Boolean).join(' ');

function contactText(value: string): string {
  const digits = value.replace(/[\s-]/g, '');
  if (/^02\d{7,8}$/.test(digits)) return digits.replace(/^(02)(\d{3,4})(\d{4})$/, '$1-$2-$3');
  if (/^0\d{9,10}$/.test(digits)) return digits.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3');
  return value;
}

const kstDateTime = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function incidentTime(value: string): string {
  const parts = kstDateTime.formatToParts(new Date(value));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}.${get('month')}.${get('day')} ${get('hour')}:${get('minute')}`;
}

export async function createIncidentPdf(rows: CommitteeIncident[], chair: { name: string; email: string },
  format: 'legacy' | 'report' | 'incident-log' = 'legacy',
  complex: { name?: string; address?: string } = {},
  incidentGroupKey?: (incident: CommitteeIncident) => string): Promise<Buffer> {
  if (!rows.length) throw new Error('At least one incident is required to create a PDF.');
  const report = format === 'report';
  const [templateBytes, fontBytes] = await Promise.all([
    readFile(format === 'incident-log' ? path.resolve(__dirname, '../committee-documents/incident-log.pdf') : templatePath),
    readFile(process.env.COMMITTEE_PDF_FONT ?? defaultFontPath),
  ]);
  const template = await PDFDocument.load(templateBytes);
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(fontBytes, { subset: true });
  output.setTitle(report ? '층간소음보고서' : '층간소음 발생일지');
  output.setCreator('MuteLab 위원회');
  if (chair.name) output.setAuthor(chair.name);
  if (chair.email) output.setSubject(`위원장 ${chair.name} · ${chair.email}`);

  if (report) {
    const cover = output.addPage(PageSizes.A4);
    const first = rows[0];
    const latest = rows.at(-1)!;
    drawCell(cover, font, '층간소음보고서', 48, 547, 50, 110, 26, true);
    const summary = [
      ['신청세대', [first.applicantName, unit(first.applicantDong, first.applicantHo)].filter(Boolean).join(' · ')],
      ['상대세대', [latest.otherName, unit(latest.otherDong, latest.otherHo)].filter(Boolean).join(' · ')],
      ['발생 기간', `${incidentTime(first.startedAt)} ~ ${incidentTime(latest.endedAt)}`],
      ['포함된 발생일지', `${rows.length}건`],
    ];
    summary.forEach(([label, value], index) => {
      const top = 130 + index * 38;
      drawCell(cover, font, label, 55, 175, top, top + 38, 12);
      drawCell(cover, font, value, 175, 540, top, top + 38, 12);
    });
  }

  const groups = new Map<string, CommitteeIncident[]>();
  for (const row of rows) {
    const key = format === 'incident-log'
      ? incidentGroupKey?.(row) ?? JSON.stringify([row.userId, row.applicantDong, row.applicantHo, row.otherDong, row.otherHo])
      : '';
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  for (const group of groups.values()) {
    const applicant = group[0];
    const location = format === 'incident-log' ? complex.name || complex.address : complex.address;
    const address = location
      ? [location, unit(applicant.applicantDong, applicant.applicantHo)].filter(Boolean).join(' ')
      : applicant.applicantAddress;
    for (let offset = 0; offset < group.length; offset += rowsPerPage) {
      const [page] = await output.copyPages(template, [0]);
      output.addPage(page);
      drawCell(page, font, applicant.applicantName, 119.16, 296.16, 135, 166.92, 11);
      drawCell(page, font, contactText(applicant.applicantPhone), 360.12, 534.36, 135, 166.92, 11, true);
      drawCell(page, font, address, 119.16, 534.36, 166.92, 198.72, 11);

      const pageRows = group.slice(offset, offset + rowsPerPage);
      pageRows.forEach((row, index) => {
        const top = rowEdges[index];
        const bottom = rowEdges[index + 1];
        drawCell(page, font, incidentTime(row.startedAt), 65.88, 225.96, top, bottom, 10, true);
        drawCell(page, font, row.noiseType, 225.96, 380.52, top, bottom, 10, true);
        drawCell(page, font, row.durationOrCount, 380.52, 529.44, top, bottom, 10, true);
      });
    }
  }
  return Buffer.from(await output.save());
}

export async function createMediationPdf(reportNo: string, data: Record<string, unknown>,
  entries: { date: string; content: string }[]): Promise<Buffer> {
  const [templateBytes, fontBytes] = await Promise.all([
    readFile(path.resolve(__dirname, '../committee-documents/mediation-report.pdf')),
    readFile(process.env.COMMITTEE_PDF_FONT ?? defaultFontPath),
  ]);
  const template = await PDFDocument.load(templateBytes);
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(fontBytes, { subset: true });
  output.setTitle(`층간소음 중재상담 보고서 ${reportNo}`);
  const value = (key: string) => typeof data[key] === 'string' ? data[key] as string : '';
  const date = (text: string) => text.replaceAll('-', '.');
  const lines: string[] = [];
  for (const entry of [...entries].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const paragraph of entry.content.split(/\r?\n/)) {
      let line = '';
      for (const character of paragraph) {
        if (line && font.widthOfTextAtSize(line + character, 10) > 376) {
          lines.push(line.trimEnd());
          line = character === ' ' ? '' : character;
        } else line += character;
      }
      lines.push(line);
    }
    lines.push(`-- ${date(entry.date)} --`, '');
  }

  const linesPerPage = 21;
  for (let offset = 0; offset < Math.max(lines.length, 1); offset += linesPerPage) {
    const [page] = await output.copyPages(template, [0]);
    output.addPage(page);
    const put = (key: string, left: number, right: number, top: number, bottom: number) =>
      drawCell(page, font, value(key), left, right, top, bottom, 10);
    const checkboxX = new Map([['관리주체', 218], ['층간소음 관리위원회', 295], ['기타', 438]]).get(value('mediatorType'));
    if (checkboxX !== undefined) {
      const y = page.getHeight() - 153;
      const point = { x: checkboxX + 3, y: y - 2 };
      page.drawLine({ start: { x: checkboxX + 1, y }, end: point, thickness: 1, color: ink });
      page.drawLine({ start: point, end: { x: checkboxX + 7, y: y + 4 }, thickness: 1, color: ink });
    }
    if (value('mediatorType') === '기타') put('mediatorOther', 480, 517, 141, 164);
    put('mediatorName', 214, 329, 164, 187);
    drawCell(page, font, contactText(value('mediatorPhone')), 405, 534, 164, 187);
    drawCell(page, font, date(value('requestedDate')), 214, 329, 187, 210);
    drawCell(page, font, date(value('mediationDate')), 405, 534, 187, 210);
    put('applicantName', 214, 329, 210, 242);
    put('counterpartName', 214, 329, 242, 274);
    for (const [key, top] of [['applicantUnit', 210], ['counterpartUnit', 242]] as const) {
      page.drawRectangle({ x: 440, y: page.getHeight() - top - 24, width: 75, height: 17, color: rgb(1, 1, 1) });
      put(key, 405, 534, top, top + 32);
    }
    for (const [key, top, bottom] of [
      ['noiseType', 274, 298], ['damagePeriod', 298, 321], ['damage', 321, 344],
      ['demands', 344, 368], ['applicantLifestyle', 368, 391], ['counterpartLifestyle', 391, 414],
    ] as const) put(key, 214, 534, top, bottom);
    lines.slice(offset, offset + linesPerPage).forEach((line, index) => {
      const top = 422 + index * 14;
      drawCell(page, font, line, 149, 531, top, top + 14, 10);
    });
    drawCell(page, font, `${reportNo} · ${Math.floor(offset / linesPerPage) + 1}/${Math.max(1, Math.ceil(lines.length / linesPerPage))}`, 320, 534, 732, 750, 8, true);
  }
  return Buffer.from(await output.save());
}

export async function createVisitApplicationPdf(id: number, data: Record<string, unknown>): Promise<Buffer> {
  const [templateBytes, fontBytes] = await Promise.all([
    readFile(path.resolve(__dirname, '../committee-documents/visit-consultation.pdf')),
    readFile(process.env.COMMITTEE_PDF_FONT ?? defaultFontPath),
  ]);
  const template = await PDFDocument.load(templateBytes);
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(fontBytes, { subset: true });
  output.setTitle(`층간소음 방문상담 신청서 ${id}`);
  const [page] = await output.copyPages(template, [0]);
  output.addPage(page);
  const value = (key: string) => typeof data[key] === 'string' ? data[key] as string : '';
  const put = (key: string, left: number, right: number, top: number, bottom: number) =>
    drawCell(page, font, value(key), left, right, top, bottom);

  // Cell boundaries measured from the official form, in PDF points.
  put('complexName', 204, 532, 132, 155);
  put('managerName', 204, 297, 155, 197);
  put('representativeName', 353, 426, 155, 197);
  put('representativePosition', 469, 532, 155, 197);
  drawCell(page, font, contactText(value('managerPhone')), 204, 297, 197, 221);
  put('managerEmail', 412, 532, 197, 221);
  put('applicantName', 256, 359, 221, 244);
  drawCell(page, font, contactText(value('applicantPhone')), 412, 532, 221, 244);
  put('applicantAddress', 256, 532, 244, 267);
  put('counterpartName', 256, 359, 267, 291);
  drawCell(page, font, contactText(value('counterpartPhone')), 412, 532, 267, 291);
  put('counterpartAddress', 256, 532, 291, 319);
  put('noiseType', 204, 532, 319, 356);

  const damageLines = value('damage').split(/\r?\n/).flatMap(paragraph => {
    const lines: string[] = [];
    let line = '';
    for (const character of paragraph) {
      if (line && font.widthOfTextAtSize(line + character, 10) > 315) {
        lines.push(line.trimEnd());
        line = character.trimStart();
      } else line += character;
    }
    lines.push(line);
    return lines;
  });
  const first = damageLines.length > 3 ? [...damageLines.slice(0, 2), '이하 피해내용은 다음 페이지에 계속됩니다.'] : damageLines;
  first.forEach((text, index) => drawCell(page, font, text, 204, 532, 359 + index * 14, 373 + index * 14));
  const [year = '', month = '', day = ''] = value('applicationDate').split('-');
  drawCell(page, font, year, 183, 230, 497, 523, 10, true);
  drawCell(page, font, month, 246, 290, 497, 523, 10, true);
  drawCell(page, font, day, 307, 350, 497, 523, 10, true);

  for (let offset = 2; damageLines.length > 3 && offset < damageLines.length; offset += 42) {
    const continuation = output.addPage(PageSizes.A4);
    drawCell(continuation, font, `층간소음 방문상담 신청서 ${id} · 피해기간 및 내용 (계속)`, 48, 547, 42, 75, 14);
    damageLines.slice(offset, offset + 42).forEach((text, index) =>
      drawCell(continuation, font, text, 48, 547, 82 + index * 16, 98 + index * 16));
  }
  return Buffer.from(await output.save());
}
