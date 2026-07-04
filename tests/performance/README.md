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

## Location Service

The location runtime is a TCP Nest microservice, so the smoke script checks the deployment health URL provided by the environment.

```bash
LOCATION_SERVICE_HEALTH_URL=https://your-healthcheck.example k6 run tests/performance/location-service-smoke.js
```

If `LOCATION_SERVICE_HEALTH_URL` is not set, the script falls back to `K6_BASE_URL` and then to the local API health endpoint.
