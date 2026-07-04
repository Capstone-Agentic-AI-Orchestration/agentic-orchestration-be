# k6 Performance Tests

This folder contains optional k6 smoke scripts used by the backend workflow toggle `enable_k6`.

## API App

```bash
k6 run tests/performance/api-smoke.js
```

Set a custom base URL:

```bash
K6_BASE_URL=https://your-api.example k6 run tests/performance/api-smoke.js
```
