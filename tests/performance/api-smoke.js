import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 1,
  iterations: 1,
};

const baseUrl = __ENV.BASE_URL || __ENV.K6_BASE_URL || 'http://localhost:3000';

export default function smokeTest() {
  const response = http.get(`${baseUrl}/api/v1/health`);

  check(response, {
    'api health status is 200': (res) => res.status === 200,
  });

  sleep(1);
}
