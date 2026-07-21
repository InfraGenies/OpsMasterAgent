import { spawn } from "node:child_process";

/**
 * Hard-coded allow-list (05-deploy-agent.md). Docker-compose commands, plus
 * (UC-9) a narrow terraform init/validate/plan set for the AWS path —
 * `apply`/`destroy` are deliberately NEVER in this list; this sandbox never
 * touches a real AWS account, only ever produces a plan. Anything that
 * doesn't match one of these exact shapes is refused before a single
 * process is spawned; there is no free-text command path.
 */
const ALLOWED: { re: RegExp; argv: (m: RegExpMatchArray) => string[] }[] = [
  {
    re: /^docker compose -p ([a-z0-9][a-z0-9_.-]*) up -d --wait$/,
    argv: (m) => ["compose", "-p", m[1], "up", "-d", "--wait"],
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
];

export function resolveAllowedCommand(cmd: string): string[] | null {
  const trimmed = cmd.trim();
  for (const rule of ALLOWED) {
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
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
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
 */
export function runAllowedCommand(
  cmd: string,
  argv: string[],
  cwd: string,
  onLog: (line: string) => void,
  timeoutMs = 180_000
): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, { cwd, env: scrubbedEnv(), shell: false, timeout: timeoutMs });
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
