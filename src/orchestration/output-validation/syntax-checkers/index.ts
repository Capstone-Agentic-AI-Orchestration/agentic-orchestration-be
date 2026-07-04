import type { ValidationError } from '../schemas/schema.types';
import { checkTypeScriptSyntax } from './typescript.checker';
import { checkSqlSyntax } from './sql.checker';
import { checkMarkdownSyntax } from './markdown.checker';

export function checkSyntax(
  content: string,
  filePath: string,
): ValidationError[] {
  if (/\.tsx?$/.test(filePath)) {
    return checkTypeScriptSyntax(content, filePath);
  }
  if (/\.sql$/.test(filePath)) {
    return checkSqlSyntax(content);
  }
  if (/\.md$/.test(filePath)) {
    return checkMarkdownSyntax(content);
  }
  return [];
}
