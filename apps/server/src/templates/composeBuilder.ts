import yaml from "js-yaml";

export interface ComposeHealthcheck {
  test: string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  start_period?: string;
}

export interface ComposeService {
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: ComposeHealthcheck;
  deploy?: { replicas?: number; resources?: { limits?: { cpus?: string; memory?: string } } };
  restart?: string;
}

export interface ComposeDoc {
  services: Record<string, ComposeService>;
  volumes?: Record<string, null>;
}

/**
 * CapacityPlan carries k8s-style memory units ("512Mi", "1Gi") per the spec,
 * but docker compose only accepts b/k/m/g suffixes ("512M", "1G") and rejects
 * the "-i" forms at `config`/`up` time — normalize at the single dump point.
 */
function composeMemory(mem: string): string {
  return mem.replace(/([KMGT])i$/i, "$1");
}

export function dumpCompose(doc: ComposeDoc): string {
  for (const svc of Object.values(doc.services)) {
    const limits = svc.deploy?.resources?.limits;
    if (limits?.memory) limits.memory = composeMemory(limits.memory);
  }
  return yaml.dump(doc, { noRefs: true, lineWidth: 120 });
}

/** busybox wget ships in every *-alpine image, so this works with no extra install. */
export function httpHealthcheck(port: number, path = "/"): ComposeHealthcheck {
  return {
    test: ["CMD-SHELL", `wget -q --spider http://localhost:${port}${path} || exit 1`],
    interval: "5s",
    timeout: "3s",
    retries: 10,
    start_period: "10s",
  };
}

export function pgHealthcheck(user: string): ComposeHealthcheck {
  return { test: ["CMD-SHELL", `pg_isready -U ${user}`], interval: "5s", timeout: "3s", retries: 10 };
}

export function mysqlHealthcheck(): ComposeHealthcheck {
  return {
    test: ["CMD-SHELL", "mysqladmin ping -h localhost --silent"],
    interval: "5s",
    timeout: "3s",
    retries: 10,
  };
}

export function redisHealthcheck(): ComposeHealthcheck {
  return { test: ["CMD-SHELL", "redis-cli ping | grep PONG"], interval: "5s", timeout: "3s", retries: 10 };
}

/**
 * Plain `docker compose up` (no Swarm) refuses to bind a fixed host port
 * for a service scaled via `deploy.replicas > 1` — there is no built-in
 * fan-in for that. Nginx resolves the service hostname once at container
 * start; Docker's embedded DNS returns one A record per replica, so this
 * static upstream still round-robins across every replica present at
 * deploy time.
 */
export function singleUpstreamNginxConf(upstreamHost: string, upstreamPort: number): string {
  return [
    "events {}",
    "http {",
    "  upstream app_upstream {",
    `    server ${upstreamHost}:${upstreamPort};`,
    "  }",
    "  server {",
    "    listen 80;",
    "    location / {",
    "      proxy_pass http://app_upstream;",
    "      proxy_set_header Host $host;",
    "    }",
    "  }",
    "}",
    "",
  ].join("\n");
}
