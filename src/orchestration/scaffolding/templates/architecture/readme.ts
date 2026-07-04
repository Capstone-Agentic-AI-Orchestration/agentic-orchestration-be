export function architectureReadme(): string {
  return [
    '# Architecture',
    '',
    '## Overview',
    '',
    'This document describes the system architecture, API contracts, and deployment strategy for the generated project.',
    '',
    '## Contents',
    '',
    '- `ARCHITECTURE.md` — System overview, component diagram, design decisions',
    '- `API.md` — Endpoint documentation, request/response schemas',
    '- `DEPLOYMENT.md` — Setup, environment variables, production checklist',
    '',
  ].join('\n');
}
