# Agent 6 — Verify Agent (Health + Load)

**Owner:** InfraGenies · **LLM:** summary narrative only · **Executes commands:** k6 + HTTP checks only · **Skills:** none

## Role
Prove the environment actually works: health checks per service, then a k6 smoke load test against the plan's stated rps, then emit a `VerifyReport` with a green/red verdict. Red verdict triggers automatic rollback via the orchestrator.

## Health checks (per use case — defined in `verify/checks.yaml`)

```yaml
uc1-realworld:
  - { name: "api tags endpoint", url: "http://localhost:3000/api/tags", expect_status: 200 }
  - { name: "db reachable", tcp: "localhost:5432" }
uc2-todo:
  - { name: "app root", url: "http://localhost:3000/", expect_status: 200 }
uc3-voting:
  - { name: "vote ui", url: "http://localhost:8080/", expect_status: 200 }
  - { name: "results ui", url: "http://localhost:8081/", expect_status: 200 }
uc5-petclinic:
  - { name: "spring actuator", url: "http://localhost:8080/actuator/health", expect_json: { status: "UP" } }
```

Retry policy: 10 attempts, 3s apart (containers warm up) — fail only after retries exhausted.

## k6 smoke test (template `verify/smoke.js.j2`)

```javascript
import http from 'k6/http';
import { check } from 'k6';
export const options = {
  scenarios: { smoke: { executor: 'constant-arrival-rate',
    rate: {{ target_rps }}, timeUnit: '1s', duration: '30s',
    preAllocatedVUs: {{ target_rps // 5 }}, maxVUs: {{ target_rps }} } },
  thresholds: {
    http_req_duration: ['p(95)<300'],
    http_req_failed: ['rate<0.01'],
  },
};
export default function () {
  const res = http.get('{{ target_url }}');
  check(res, { 'status 200': (r) => r.status === 200 });
}
```

Run containerised so Windows needs no k6 install:
`docker run --rm -i --network host grafana/k6 run - < smoke.js` → parse the JSON summary (`--summary-export`).

Special cases: UC-4 additionally asserts ≥3 distinct upstream hostnames in responses (proves load balancing). UC-3 runs a functional check: POST votes, assert results page total increments.

## Verdict logic (deterministic — no LLM in the decision)
`green` ⇔ all health checks pass AND all k6 thresholds pass. Anything else `red`. The LLM is used **only after** the verdict, to write the human-readable `summary` from the raw numbers.

## Tests
- Deliberately under-provision (1 replica for 500 rps) → p95 threshold fails → red → rollback fires (this doubles as demo UC-8b).
- Verify report numbers match k6's own summary export exactly (no LLM-rounded metrics).
