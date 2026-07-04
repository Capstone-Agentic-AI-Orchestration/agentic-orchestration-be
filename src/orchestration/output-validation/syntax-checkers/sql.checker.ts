import type { ValidationError } from '../schemas/schema.types';

let parser: any = null;

function getParser(): any {
  if (!parser) {
    try {
      const mod = require('node-sql-parser');
      parser = new mod.Parser();
    } catch {
      return null;
    }
  }
  return parser;
}

export function checkSqlSyntax(content: string): ValidationError[] {
  const p = getParser();
  if (!p) {
    return [{ code: 'SQL_SYNTAX', message: 'SQL parser not available — install node-sql-parser' }];
  }
  try {
    p.astify(content, { database: 'postgresql' });
    return [];
  } catch (e) {
    return [{
      code: 'SQL_SYNTAX',
      message: `SQL parse error: ${(e as Error).message}`,
    }];
  }
}
