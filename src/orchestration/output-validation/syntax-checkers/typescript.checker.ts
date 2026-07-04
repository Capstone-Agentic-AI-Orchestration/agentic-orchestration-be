import * as ts from 'typescript';
import type { ValidationError } from '../schemas/schema.types';

export function checkTypeScriptSyntax(content: string, filePath: string): ValidationError[] {
  const kind = filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, kind);
  const parserDiagnostics = (sourceFile as any).parseDiagnostics as ts.Diagnostic[] | undefined;

  if (!parserDiagnostics?.length) return [];

  return parserDiagnostics.map(d => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const pos = d.start != null ? sourceFile.getLineAndCharacterOfPosition(d.start) : null;
    return {
      code: 'TS_SYNTAX' as const,
      message: pos
        ? `TS${d.code} at line ${pos.line + 1}: ${message}`
        : `TS${d.code}: ${message}`,
      line: pos?.line != null ? pos.line + 1 : undefined,
    };
  });
}
