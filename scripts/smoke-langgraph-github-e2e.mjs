console.warn(
  'scripts/smoke-langgraph-github-e2e.mjs is deprecated; use scripts/smoke-direct-github-e2e.mjs.',
);
await import('./smoke-direct-github-e2e.mjs');
