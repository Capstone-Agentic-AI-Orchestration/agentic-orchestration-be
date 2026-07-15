import { Injectable } from '@nestjs/common';
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';

export interface ExtractedDocumentContent {
  text: string;
  sourceLocations: Array<{ locator: string; textLength: number }>;
}

@Injectable()
export class DocumentExtractionService {
  async extract(input: {
    fileName: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<ExtractedDocumentContent> {
    const extension = input.fileName.split('.').pop()?.toLowerCase();
    if (extension === 'txt') {
      const text = input.buffer.toString('utf8').trim();
      return { text, sourceLocations: [{ locator: 'text', textLength: text.length }] };
    }
    if (extension === 'pdf') return this.extractPdf(input.buffer);
    if (extension === 'docx') return this.extractDocx(input.buffer);
    if (extension === 'xlsx') return this.extractXlsx(input.buffer);
    if (extension === 'png' || extension === 'jpg' || extension === 'jpeg') {
      return this.extractImage(input.buffer);
    }
    throw new Error(`Unsupported extraction format: ${extension || input.mimeType}`);
  }

  private async extractPdf(buffer: Buffer): Promise<ExtractedDocumentContent> {
    const pdfParse = (await import('pdf-parse')).default as unknown as (
      input: Buffer,
    ) => Promise<{ text: string; numpages: number }>;
    const parsed = await pdfParse(buffer);
    const text = parsed.text.trim();
    return {
      text,
      sourceLocations: [{ locator: `PDF (${parsed.numpages || 1} page${parsed.numpages === 1 ? '' : 's'})`, textLength: text.length }],
    };
  }

  private async extractDocx(buffer: Buffer): Promise<ExtractedDocumentContent> {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value.trim();
    return { text, sourceLocations: [{ locator: 'DOCX body', textLength: text.length }] };
  }

  private async extractXlsx(buffer: Buffer): Promise<ExtractedDocumentContent> {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sections = workbook.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name] ?? {});
      return `Sheet: ${name}\n${csv}`.trim();
    });
    const text = sections.join('\n\n').trim();
    return {
      text,
      sourceLocations: workbook.SheetNames.map((name) => ({ locator: `Sheet: ${name}`, textLength: text.length })),
    };
  }

  private async extractImage(buffer: Buffer): Promise<ExtractedDocumentContent> {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const result = await worker.recognize(buffer);
      const text = result.data.text.trim();
      return { text, sourceLocations: [{ locator: 'OCR image', textLength: text.length }] };
    } finally {
      await worker.terminate();
    }
  }
}
