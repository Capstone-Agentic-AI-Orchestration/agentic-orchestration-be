import * as ts from 'typescript';
import type { ValidationError } from '../schemas/schema.types';

/**
 * Program-level (type-aware) TypeScript checking.
 *
 * Unlike {@link checkTypeScriptSyntax}, which only runs the parser over a single
 * file, this builds an in-memory `ts.Program` over the whole generated artifact
 * set and surfaces *semantic* diagnostics — i.e. references to things that do
 * not exist. This is what catches the cross-agent integration failures the
 * single-file parser cannot: a backend service importing `./user.service` that
 * no agent generated, a component using an identifier that was never declared,
 * or a named import that the referenced generated module does not export.
 *
 * The generated project's node_modules are NOT installed during a run, so a full
 * type-check would drown in "cannot find module '@nestjs/common'" noise. We
 * therefore restrict reporting to a conservative allow-list of unambiguous
 * "you referenced something that doesn't exist" diagnostics, and only report
 * unresolved-module errors for *relative* specifiers (a missing generated file),
 * never for bare/external package imports. Type-mismatch codes (2322/2345) are
 * intentionally excluded because they are unreliable without installed
 * third-party type definitions.
 */

export interface ProgramFile {
  filePath: string;
  content: string;
}

/**
 * High-signal semantic diagnostic codes: "you referenced a name/member that
 * does not exist". These rarely false-positive even without external types.
 */
const REFERENCE_ERROR_CODES = new Set<number>([
  2304, // Cannot find name 'X'.
  2305, // Module '...' has no exported member 'X'.
  2552, // Cannot find name 'X'. Did you mean 'Y'?
  2724, // '...' has no exported member named 'X'. Did you mean 'Y'?
  2503, // Cannot find namespace 'X'.
]);

/** Cannot find module — only meaningful here for relative (generated) imports. */
const CANNOT_FIND_MODULE = 2307;

const normalize = (filePath: string): string => filePath.replace(/\\/g, '/');

/**
 * Virtual root the generated files are mounted under. Using an absolute virtual
 * prefix makes root-name and relative-import resolution fully deterministic and
 * immune to the real working directory; only lib.d.ts lookups fall through to
 * the real filesystem (they live outside this prefix).
 */
const VIRTUAL_ROOT = '/devflow-validate';

const toVirtual = (filePath: string): string =>
  `${VIRTUAL_ROOT}/${normalize(filePath).replace(/^\.?\//, '')}`;

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.ReactJSX,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  esModuleInterop: true,
  noEmit: true,
  skipLibCheck: true,
  // Deliberately lax: we want hard "does not exist" errors, not strictness noise.
  strict: false,
  noImplicitAny: false,
  allowJs: false,
};

/**
 * Type-checks the TypeScript/TSX artifacts together and returns the high-signal
 * reference errors keyed by the original `filePath`. Files with no errors are
 * omitted from the map. Never throws — type-checking is best-effort and must not
 * break the validation pass.
 */
export function checkTypeScriptProgram(
  files: ProgramFile[],
): Map<string, ValidationError[]> {
  const result = new Map<string, ValidationError[]>();

  const tsFiles = files.filter((f) => /\.tsx?$/.test(f.filePath));
  if (tsFiles.length === 0) return result;

  // Map virtual absolute path → original ProgramFile so diagnostics (which carry
  // the virtual file name) map back to the caller's exact filePath.
  const byVirtual = new Map<string, ProgramFile>();
  for (const file of tsFiles) {
    byVirtual.set(toVirtual(file.filePath), file);
  }

  try {
    const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const baseGetSourceFile = host.getSourceFile.bind(host);
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    const baseDirectoryExists = host.directoryExists?.bind(host);

    host.getCurrentDirectory = () => VIRTUAL_ROOT;
    host.useCaseSensitiveFileNames = () => true;
    // Module resolution probes directoryExists before fileExists; the virtual
    // tree is not on disk, so claim every path under the virtual root exists or
    // relative imports between generated files never resolve (they 2307 instead
    // of surfacing the real "no exported member" error).
    host.directoryExists = (dir) => {
      const normalized = normalize(dir);
      if (normalized === VIRTUAL_ROOT || normalized.startsWith(`${VIRTUAL_ROOT}/`)) {
        return true;
      }
      return baseDirectoryExists ? baseDirectoryExists(dir) : ts.sys.directoryExists(dir);
    };
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const generated = byVirtual.get(normalize(fileName));
      if (generated) {
        return ts.createSourceFile(
          fileName,
          generated.content,
          languageVersion,
          true,
          fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
      }
      return baseGetSourceFile(fileName, languageVersion, onError, shouldCreate);
    };
    host.fileExists = (fileName) =>
      byVirtual.has(normalize(fileName)) || baseFileExists(fileName);
    host.readFile = (fileName) =>
      byVirtual.get(normalize(fileName))?.content ?? baseReadFile(fileName);

    const program = ts.createProgram(
      tsFiles.map((f) => toVirtual(f.filePath)),
      COMPILER_OPTIONS,
      host,
    );

    for (const diagnostic of program.getSemanticDiagnostics()) {
      if (!diagnostic.file) continue;
      if (!isReportable(diagnostic)) continue;

      const original = byVirtual.get(normalize(diagnostic.file.fileName));
      if (!original) continue; // diagnostic in a lib file — ignore.

      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        '\n',
      );
      const pos =
        diagnostic.start != null
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : null;

      const error: ValidationError = {
        code: 'TS_TYPE',
        path: original.filePath,
        message: pos
          ? `TS${diagnostic.code} at line ${pos.line + 1}: ${message}`
          : `TS${diagnostic.code}: ${message}`,
        line: pos?.line != null ? pos.line + 1 : undefined,
      };

      const bucket = result.get(original.filePath);
      if (bucket) bucket.push(error);
      else result.set(original.filePath, [error]);
    }
  } catch {
    // Type-checking is advisory; a host/program failure must never block a run.
    return result;
  }

  return result;
}

function isReportable(diagnostic: ts.Diagnostic): boolean {
  if (REFERENCE_ERROR_CODES.has(diagnostic.code)) return true;
  if (diagnostic.code === CANNOT_FIND_MODULE) {
    const specifier = moduleSpecifierOf(diagnostic);
    return specifier != null && specifier.startsWith('.');
  }
  return false;
}

function moduleSpecifierOf(diagnostic: ts.Diagnostic): string | null {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const match = message.match(/Cannot find module '([^']+)'/);
  return match ? match[1] : null;
}
