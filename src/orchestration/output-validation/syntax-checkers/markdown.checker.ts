import type { ValidationError } from '../schemas/schema.types';

let markdownParser: ((content: string) => void) | null = null;

function getMarkdownParser(): ((content: string) => void) | null {
  if (markdownParser !== undefined) return markdownParser;

  try {
    const { remark } = require('remark');
    const remarkParse = require('remark-parse');
    const processor = remark().use(remarkParse);
    markdownParser = (content: string) => { processor.parse(content); };
  } catch {
    markdownParser = null;
  }

  return markdownParser;
}

export function checkMarkdownSyntax(content: string): ValidationError[] {
  const parser = getMarkdownParser();
  if (!parser) {
    return [{ code: 'MD_SYNTAX', message: 'Markdown parser not available — install remark + remark-parse' }];
  }
  try {
    parser(content);
    return [];
  } catch (e) {
    return [{
      code: 'MD_SYNTAX',
      message: `Markdown parse error: ${(e as Error).message}`,
    }];
  }
}
