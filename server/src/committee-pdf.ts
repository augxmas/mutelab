import path from 'node:path';
import { readFile } from 'node:fs/promises';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFPage, type PDFFont, rgb } from 'pdf-lib';
import type { CommitteeIncident } from './committee-data';

const templatePath = path.resolve(__dirname, '../../app/src/main/assets/forms/noise_incident_log.pdf');
const defaultFontPath = process.platform === 'win32'
  ? 'C:/Windows/Fonts/malgun.ttf'
  : '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf';
const ink = rgb(0.10, 0.14, 0.19);
const rowsPerPage = 13;

function fitSize(font: PDFFont, text: string, maximum: number, width: number): number {
  let size = maximum;
  while (size > 6 && font.widthOfTextAtSize(text, size) > width) size -= 0.25;
  return size;
}

function drawCell(page: PDFPage, font: PDFFont, value: string, left: number, right: number,
  top: number, bottom: number, maximum = 10, centered = false): void {
  const text = value.replace(/[\r\n]+/g, ' ').trim();
  if (!text) return;
  const size = fitSize(font, text, maximum, right - left - 6);
  const width = font.widthOfTextAtSize(text, size);
  const x = centered ? left + Math.max(3, (right - left - width) / 2) : left + 4;
  const y = page.getHeight() - bottom + Math.max(2, (bottom - top - size) / 2 + 1);
  page.drawText(text, { x, y, size, font, color: ink, maxWidth: right - left - 6 });
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

export async function createIncidentPdf(rows: CommitteeIncident[], chair: { name: string; email: string }): Promise<Buffer> {
  if (!rows.length) throw new Error('At least one incident is required to create a PDF.');
  const [templateBytes, fontBytes] = await Promise.all([
    readFile(templatePath),
    readFile(process.env.COMMITTEE_PDF_FONT ?? defaultFontPath),
  ]);
  const template = await PDFDocument.load(templateBytes);
  const output = await PDFDocument.create();
  output.registerFontkit(fontkit);
  const font = await output.embedFont(fontBytes, { subset: true });
  output.setTitle('층간소음 발생일지');
  output.setCreator('MuteLab 위원회');
  if (chair.name) output.setAuthor(chair.name);
  if (chair.email) output.setSubject(`위원장 ${chair.name} · ${chair.email}`);

  for (let offset = 0; offset < rows.length; offset += rowsPerPage) {
    const [page] = await output.copyPages(template, [0]);
    output.addPage(page);
    const applicant = rows[0];
    drawCell(page, font, applicant.applicantName, 119.16, 232, 135, 166.92, 11, false);
    drawCell(page, font, applicant.applicantPhone, 360.12, 534.96, 135, 166.92, 11, true);
    drawCell(page, font, applicant.applicantAddress, 119.16, 534.96, 166.92, 198.72, 10, false);

    const pageRows = rows.slice(offset, offset + rowsPerPage);
    const tableTop = 243.12;
    const rowHeight = (632.28 - tableTop) / rowsPerPage;
    pageRows.forEach((row, index) => {
      const top = tableTop + index * rowHeight;
      const bottom = top + rowHeight;
      drawCell(page, font, incidentTime(row.startedAt), 65.88, 225.96, top, bottom, 9, true);
      drawCell(page, font, row.noiseType, 225.96, 380.52, top, bottom, 9, true);
      drawCell(page, font, row.durationOrCount, 380.52, 529.44, top, bottom, 9, true);
    });
  }
  return Buffer.from(await output.save());
}
