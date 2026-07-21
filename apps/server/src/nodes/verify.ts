import autocannon from "autocannon";
import type { CheckResult, SmokeTest, VerifyReport } from "@ops-master/shared";
import { env } from "../config.js";
import { shouldMockDeploy } from "./dockerProbe.js";

export interface VerifyInput {
  requestId: string;
  /** e.g. ["http://localhost:3000"] */
  endpoints: string[];
  healthPath: string;
  targetRps: number | null;
  onLog: (line: string) => void;
  /**
   * UC-8b rollback demo: when the original request contains a deliberate
   * failure marker ("demo-fail" / "wrong db password"), mock-deploy mode
   * simulates a red verification so the auto-rollback path can be shown
   * offline. Real mode ignores this — a genuinely bad config fails naturally.
   */
  forceFail?: boolean;
  /** UC-9: AWS/Terraform path never has a live endpoint to probe (plan-only, nothing applied) — set to the deploy step's detail message to short-circuit straight to a plan-based verify report. */
  terraformDeployDetail?: string;
}

function joinUrl(base: string, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

async function checkHealth(url: string, onLog: (l: string) => void): Promise<CheckResult> {
  const attempts = 10;
  for (let i = 1; i <= attempts; i++) {
    const start = Date.now();
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const latency = Date.now() - start;
      if (res.status >= 200 && res.status < 300) {
        onLog(`health check ${url} -> ${res.status} (${latency}ms, attempt ${i}/${attempts})`);
        return { name: `GET ${url}`, status: "pass", latency_ms: latency };
      }
      onLog(`health check ${url} -> HTTP ${res.status}, retrying (${i}/${attempts})`);
    } catch (err) {
      onLog(`health check ${url} -> ${err instanceof Error ? err.message : String(err)}, retrying (${i}/${attempts})`);
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
  }
  return { name: `GET ${url}`, status: "fail", latency_ms: 0 };
}

/**
 * k6 (agent-md-files/06-verify-agent.md) needs `docker run --network host`,
 * which is a Linux-only trick — Docker Desktop on Windows/Mac runs
 * containers in a VM where host networking doesn't pass through. Autocannon
 * gives the same rps / p95 / error-rate shape from plain Node with no extra
 * install, so it stands in here. autocannon has no exact p95 bucket; p97_5
 * is its closest percentile and is used as a (slightly conservative) stand-in.
 */
async function runSmokeTest(url: string, targetRps: number, onLog: (l: string) => void): Promise<SmokeTest> {
  onLog(`starting autocannon smoke test against ${url} (target ~${targetRps} rps, 15s)`);
  const connections = Math.min(200, Math.max(2, Math.ceil(targetRps / 25)));
  const result = await autocannon({ url, connections, duration: 15, pipelining: 1 });
  const sent = result.requests.sent || result.requests.total || 1;
  const failed = (result.errors ?? 0) + (result.timeouts ?? 0) + (result.non2xx ?? 0);
  const smoke: SmokeTest = {
    tool: "autocannon",
    target_rps: targetRps,
    achieved_rps: Math.round(result.requests.average),
    p95_ms: Math.round(result.latency.p97_5),
    error_rate: Number((failed / sent).toFixed(4)),
    duration_s: 15,
  };
  onLog(
    `smoke test done: ${smoke.achieved_rps} rps achieved, p95≈${smoke.p95_ms}ms, error rate ${(smoke.error_rate * 100).toFixed(2)}%`
  );
  return smoke;
}

/** Deterministic verdict per 06-verify-agent.md: no LLM in the pass/fail decision. */
export async function runVerify(input: VerifyInput): Promise<VerifyReport> {
  if (input.terraformDeployDetail !== undefined) {
    input.onLog("[verify] terraform plan-only path — no live AWS endpoint exists to health-check");
    return {
      request_id: input.requestId,
      checks: [{ name: "terraform plan (plan-only — no live endpoint)", status: "pass", latency_ms: 0 }],
      smoke_test: null,
      verdict: "green",
      rolled_back: false,
      endpoints: [],
      summary: `Plan-only verification: ${input.terraformDeployDetail} No live AWS resources exist to health-check in this sandbox.`,
    };
  }

  if (await shouldMockDeploy()) {
    if (input.forceFail) {
      const checks: CheckResult[] = input.endpoints.map((e) => {
        input.onLog(`[mock verify] simulated health check GET ${joinUrl(e, input.healthPath)} -> 500 (forced failure marker in request)`);
        return { name: `GET ${joinUrl(e, input.healthPath)} (SIMULATED)`, status: "fail" as const, latency_ms: 0 };
      });
      return {
        request_id: input.requestId,
        checks,
        smoke_test: null,
        verdict: "red",
        rolled_back: false,
        endpoints: input.endpoints,
        summary:
          "SIMULATED verification FAILURE (request carried a deliberate failure marker — UC-8b rollback demo): app container cannot reach the database, health checks red.",
      };
    }
    // Nothing was really deployed, so probing real endpoints would be
    // meaningless — report clearly-labeled simulated checks instead.
    const checks: CheckResult[] = input.endpoints.map((e) => {
      input.onLog(`[mock verify] simulated health check GET ${joinUrl(e, input.healthPath)} -> 200`);
      return { name: `GET ${joinUrl(e, input.healthPath)} (SIMULATED)`, status: "pass" as const, latency_ms: 1 };
    });
    return {
      request_id: input.requestId,
      checks,
      smoke_test: null,
      verdict: "green",
      rolled_back: false,
      endpoints: input.endpoints,
      summary: `SIMULATED verification (mock deploy mode — docker CLI not present): ${checks.length} health check(s) assumed passing; load test skipped.`,
    };
  }

  const checks: CheckResult[] = [];
  for (const endpoint of input.endpoints) {
    checks.push(await checkHealth(joinUrl(endpoint, input.healthPath), input.onLog));
  }

  const allChecksPass = checks.length > 0 && checks.every((c) => c.status === "pass");
  let smokeTest: SmokeTest | null = null;
  let smokeOk = true;

  if (env.SKIP_LOAD_TEST) {
    input.onLog("load test skipped (SKIP_LOAD_TEST=true) — verdict based on health checks only");
  } else if (allChecksPass && input.endpoints.length > 0 && input.targetRps) {
    smokeTest = await runSmokeTest(joinUrl(input.endpoints[0], input.healthPath), input.targetRps, input.onLog);
    smokeOk = smokeTest.p95_ms < 300 && smokeTest.error_rate < 0.01;
  }

  const verdict: VerifyReport["verdict"] = allChecksPass && smokeOk ? "green" : "red";
  const failedChecks = checks.filter((c) => c.status === "fail").map((c) => c.name);
  const summary =
    verdict === "green"
      ? `All ${checks.length} health check(s) passed.${
          smokeTest
            ? ` Sustained ~${smokeTest.achieved_rps} rps with p95 ${smokeTest.p95_ms}ms (threshold 300ms), error rate ${(smokeTest.error_rate * 100).toFixed(2)}% (threshold 1%).`
            : ""
        }`
      : `Verification failed.${failedChecks.length ? ` Failed checks: ${failedChecks.join(", ")}.` : ""}${
          smokeTest && !smokeOk
            ? ` Smoke test missed threshold: p95 ${smokeTest.p95_ms}ms / error rate ${(smokeTest.error_rate * 100).toFixed(2)}%.`
            : ""
        }`;

  return {
    request_id: input.requestId,
    checks,
    smoke_test: smokeTest,
    verdict,
    rolled_back: false,
    endpoints: input.endpoints,
    summary,
  };
}
