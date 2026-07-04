export type ValidationErrorCode =
  | 'SCHEMA_VIOLATION'
  | 'TS_SYNTAX'
  | 'TS_TYPE'
  | 'SQL_SYNTAX'
  | 'MD_SYNTAX'
  | 'BASE'
  | 'CONTRACT';

/** The code-gen agent an error is attributed to, for precise retry routing. */
export type ValidationAgentType =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'architecture';

export interface ValidationError {
  code: ValidationErrorCode;
  path?: string;
  message: string;
  line?: number;
  /**
   * The agent whose artifact produced this error, when known. Set by
   * batch/program validation so the validator can route a retry to the actual
   * failing agent instead of guessing from file extensions.
   */
  agentType?: ValidationAgentType;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  summary: string;
}
