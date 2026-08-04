import { spawn } from "node:child_process";
import { env } from "../config.js";
import { BUILD_REGISTRY } from "./buildRegistry.js";

export function isAwsApplyEnabled(): boolean {
  return env.ALLOW_AWS_APPLY;
}

/**
 * AWS_PROFILE (just a profile name, not a secret) is always forwarded via
 * scrubbedEnv()'s keep-list below. These three are actual credentials, so
 * they're only ever read here, on demand, for a terraform apply/destroy/
 * output spawn specifically — never added to the general keep-list. Prefer
 * AWS_PROFILE + `aws configure` over these for the demo; they exist for
 * anyone who'd rather pass temporary/explicit credentials instead.
 */
export function awsCredentialEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface AllowRule {
  re: RegExp;
  argv: (m: RegExpMatchArray) => string[];
  /** When present and false, this rule is skipped entirely (as if it didn't match) — used only by the terraform apply/destroy rules below, gated on ALLOW_AWS_APPLY. */
  enabled?: () => boolean;
}

/** git clone/checkout rules, one pair per BUILD_REGISTRY entry — generated from the registry so the set of clonable repos/commits is always exactly what's in that one hardcoded table, never a freeform URL pattern. */
function buildRegistryRules(): AllowRule[] {
  const rules: AllowRule[] = [];
  for (const entry of Object.values(BUILD_REGISTRY)) {
    // Destination dir is "repo-<registry key>", not a bare "repo" — lets a
    // single build clone more than one repo (e.g. the RealWorld backend +
    // frontend pair) without the second clone colliding with the first.
    // Still 100% derived from this closed table, never attacker/LLM input.
    const cloneDir = `repo-${entry.key}`;
    rules.push({
      re: new RegExp(`^git clone ${escapeRegex(entry.repoUrl)} ${escapeRegex(cloneDir)}$`),
      argv: () => ["clone", entry.repoUrl, cloneDir],
    });
    rules.push({
      re: new RegExp(`^git checkout ${escapeRegex(entry.commitSha)}$`),
      argv: () => ["checkout", entry.commitSha],
    });
  }
  return rules;
}

/**
 * Hard-coded allow-list (05-deploy-agent.md). Docker-compose commands, plus
 * (UC-9) terraform init/validate/plan for the AWS path, always available.
 * `apply`/`destroy` are also listed below but gated behind `enabled:
 * isAwsApplyEnabled` — with ALLOW_AWS_APPLY unset/false (every environment
 * except an explicitly configured demo machine) they never match, so this
 * sandbox stays exactly as plan-only as before. Anything that doesn't match
 * one of these exact shapes is refused before a single process is spawned;
 * there is no free-text command path.
 *
 * The git/npm/docker-build rules below exist only for the build-sentinel
 * path (nodes/buildRegistry.ts, nodes/build.ts) — npm ci/build/prisma are
 * fixed literal strings (identical regardless of which registry entry is
 * building), `docker build`'s tag is pinned to a `-app:<hex>` shape so
 * `:latest` can never match, and the git rules are generated from the
 * registry table itself (see buildRegistryRules above) rather than
 * accepting any URL that merely looks well-formed.
 */
const ALLOWED: AllowRule[] = [
  {
    re: /^docker compose -p ([a-z0-9][a-z0-9_.-]*) up -d --wait$/,
    argv: (m) => ["compose", "-p", m[1], "up", "-d", "--wait"],
  },
  {
    re: /^docker compose -p ([a-z0-9][a-z0-9_.-]*) up -d --wait ([a-z0-9][a-z0-9_.-]*)$/,
    argv: (m) => ["compose", "-p", m[1], "up", "-d", "--wait", m[2]],
  },
  {
    re: /^docker compose -p ([a-z0-9][a-z0-9_.-]*) down -v$/,
    argv: (m) => ["compose", "-p", m[1], "down", "-v"],
  },
  {
    re: /^docker compose -p ([a-z0-9][a-z0-9_.-]*) config -q$/,
    argv: (m) => ["compose", "-p", m[1], "config", "-q"],
  },
  {
    re: /^terraform init -backend=false -input=false -no-color$/,
    argv: () => ["init", "-backend=false", "-input=false", "-no-color"],
  },
  {
    re: /^terraform validate -no-color$/,
    argv: () => ["validate", "-no-color"],
  },
  {
    re: /^terraform plan -input=false -no-color -out=tfplan$/,
    argv: () => ["plan", "-input=false", "-no-color", "-out=tfplan"],
  },
  {
    // Applies the exact saved plan file from the rule above, never a fresh
    // unreviewed plan. `enabled` makes this rule invisible to
    // resolveAllowedCommand() entirely unless ALLOW_AWS_APPLY=true — this is
    // the one gated entry in this whole table, since it's the one entry
    // point from this app to a real AWS account. Default (flag off) leaves
    // it permanently unreachable, same as every other environment and the
    // smoke test.
    re: /^terraform apply -input=false -no-color -auto-approve tfplan$/,
    argv: () => ["apply", "-input=false", "-no-color", "-auto-approve", "tfplan"],
    enabled: isAwsApplyEnabled,
  },
  {
    // Same guard as apply above.
    re: /^terraform destroy -input=false -no-color -auto-approve$/,
    argv: () => ["destroy", "-input=false", "-no-color", "-auto-approve"],
    enabled: isAwsApplyEnabled,
  },
  {
    // Read-only introspection (fetch the applied endpoint URL) — harmless
    // without a prior real apply (just errors "no state"), so always allowed.
    re: /^terraform output -json$/,
    argv: () => ["output", "-json"],
  },
  ...buildRegistryRules(),
  { re: /^npm ci$/, argv: () => ["ci"] },
  { re: /^npm run build$/, argv: () => ["run", "build"] },
  { re: /^npx prisma migrate deploy$/, argv: () => ["prisma", "migrate", "deploy"] },
  {
    re: /^docker build -t ([a-z0-9][a-z0-9_.-]*-app:[0-9a-f]{6,40}) \.$/,
    argv: (m) => ["build", "-t", m[1], "."],
  },
];

export function resolveAllowedCommand(cmd: string): string[] | null {
  const trimmed = cmd.trim();
  for (const rule of ALLOWED) {
    if (rule.enabled && !rule.enabled()) continue;
    const m = trimmed.match(rule.re);
    if (m) return rule.argv(m);
  }
  return null;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "Path",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "DOCKER_HOST",
    "ProgramData",
    "ProgramFiles",
    // Named AWS CLI profile for the (gated) real-apply terraform path — just
    // a profile name, not a secret; harmless to forward unconditionally.
    "AWS_PROFILE",
    // Whatever TLS trust settings this server process itself runs with (e.g.
    // --use-system-ca on a machine behind a TLS-inspecting proxy — see
    // start-app.ps1) must also reach spawned Node-based tools (npm/npx) or
    // their own registry/network calls fail with SELF_SIGNED_CERT_IN_CHAIN
    // even though the server's own outbound calls work fine. Harmless for
    // non-Node binaries (git/docker/terraform just ignore it).
    "NODE_OPTIONS",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  // `terraform init` on a git-sourced module (e.g. templates/terraformCatalog.ts's
  // github.com/aws-containers/retail-store-sample-app source, which itself pulls in nested
  // dependencies like cloudposse/terraform-aws-security-group) shells out to the system `git`
  // internally via go-getter. On Windows, git's default config rejects the resulting deeply nested
  // paths once they exceed MAX_PATH (260 chars) — "fatal: cannot write keep file
  // '.../.git/objects/pack/....keep': Filename too long" — confirmed live against UC-9. These
  // GIT_CONFIG_* env vars (git >= 2.31) inject a one-off "core.longpaths=true" for just this
  // spawned process tree, without requiring the operator to edit their global .gitconfig. A no-op
  // on non-Windows and for every non-git command (docker compose, terraform plan/validate) this
  // same env is also used for.
  env.GIT_CONFIG_COUNT = "1";
  env.GIT_CONFIG_KEY_0 = "core.longpaths";
  env.GIT_CONFIG_VALUE_0 = "true";
  return env;
}

export interface ExecOutcome {
  ok: boolean;
  output: string;
}

/**
 * Runs an already-allow-listed argv via spawn — never shell:true, never a
 * string command line — with cwd pinned to the deployment dir, a scrubbed
 * env, and a hard timeout. Streams stdout/stderr line-by-line to `onLog`.
 * `extraEnv` merges on top of the scrubbed env for this one call only (e.g.
 * DATABASE_URL for a migration step) — never used to widen what env vars a
 * command can read in general, just to hand this specific spawn a value it
 * needs.
 */
export function runAllowedCommand(
  cmd: string,
  argv: string[],
  cwd: string,
  onLog: (line: string) => void,
  timeoutMs = 180_000,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env: { ...scrubbedEnv(), ...extraEnv }, shell: false, timeout: timeoutMs });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
      return;
    }

    let output = "";
    const handle = (buf: Buffer) => {
      const text = buf.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLog(line);
      }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (err) => resolve({ ok: false, output: output + `\n${err.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}
