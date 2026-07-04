import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
};

const healthUrl =
  __ENV.LOCATION_SERVICE_HEALTH_URL ||
  __ENV.K6_BASE_URL ||
  'http://localhost:3000/api/v1/health';

export default function smokeTest() {
  const response = http.get(healthUrl);

  check(response, {
    'location service deployment health is 200': (res) => res.status === 200,
  });

  sleep(1);
}
