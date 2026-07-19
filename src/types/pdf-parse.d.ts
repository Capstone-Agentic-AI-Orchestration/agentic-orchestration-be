declare module 'pdf-parse' {
  export interface PdfParseResult {
    text: string;
    numpages: number;
  }

  export default function pdfParse(input: Buffer): Promise<PdfParseResult>;
}
