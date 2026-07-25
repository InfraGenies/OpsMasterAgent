import type { TemplateId } from "@ops-master/shared";
import {
  dumpCompose,
  httpHealthcheck,
  mysqlHealthcheck,
  pgHealthcheck,
  redisHealthcheck,
  singleUpstreamNginxConf,
  type ComposeDoc,
  type ComposeService,
} from "./composeBuilder.js";
import { generateSecret } from "./secrets.js";
import { TERRAFORM_TEMPLATES } from "./terraformCatalog.js";
import {
  appServices,
  cacheService,
  dbService,
  hostPortFor,
  type RenderContext,
  type RenderResult,
  type TemplateDefinition,
} from "./types.js";

/**
 * Plain `docker compose up` cannot bind one fixed host port across multiple
 * replicas of the same service (no Swarm-style ingress mesh). So whenever a
 * service's planned replica count is > 1, every template fronts it with an
 * nginx sidecar that owns the host port instead of publishing it directly —
 * this is what 02-planner.md's "add nginx automatically when replicas > 1"
 * rule cashes out to at render time.
 */
function frontIfScaled(
  appName: string,
  containerPort: number,
  hostPort: number,
  replicas: number
): { appPorts?: string[]; extraServices: Record<string, ComposeService>; extraFiles: { path: string; content: string }[] } {
  if (replicas <= 1) {
    return { appPorts: [`${hostPort}:${containerPort}`], extraServices: {}, extraFiles: [] };
  }
  return {
    extraServices: {
      nginx: {
        image: "nginx:alpine",
        ports: [`${hostPort}:80`],
        restart: "unless-stopped",
        volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro"],
        depends_on: { [appName]: { condition: "service_healthy" } },
      },
    },
    extraFiles: [{ path: "nginx.conf", content: singleUpstreamNginxConf(appName, containerPort) }],
  };
}

const composeSingleV1: TemplateDefinition = {
  id: "compose-single-v1",
  format: "compose",
  description:
    "app only, any replica count (nginx auto-added if >1) — use ONLY when the plan has NO db and NO cache service; picking this for a plan that includes one silently drops it (UC-2)",
  render(plan, variables, ctx): RenderResult {
    const app = appServices(plan)[0] ?? plan.services[0];
    if (!app) throw new Error("compose-single-v1: plan has no services");
    const containerPort = app.ports[0] ?? 3000;
    const hostPort = hostPortFor(plan, app.name, containerPort);
    const healthPath = typeof variables.health_path === "string" ? variables.health_path : "/";
    const front = frontIfScaled(app.name, containerPort, hostPort, app.replicas);
    const appStorage = plan.storage.find((s) => s.attached_to === app.name);

    const doc: ComposeDoc = {
      services: {
        [app.name]: {
          image: app.image,
          ports: front.appPorts,
          restart: "unless-stopped",
          volumes: appStorage ? [`${appStorage.name}:/app/data`] : undefined,
          healthcheck: httpHealthcheck(containerPort, healthPath),
          deploy: { replicas: app.replicas, resources: { limits: { cpus: app.cpu, memory: app.memory } } },
        },
        ...front.extraServices,
      },
      volumes: appStorage ? { [appStorage.name]: null } : undefined,
    };

    return {
      files: [{ path: "docker-compose.yml", content: dumpCompose(doc) }, ...front.extraFiles],
      applyCommand: `docker compose -p ${ctx.projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${ctx.projectName} down -v`,
    };
  },
};

const composeWebDbV1: TemplateDefinition = {
  id: "compose-web-db-v1",
  format: "compose",
  description:
    "app + postgres/mysql + volume, ANY replica count (nginx auto-added if >1) — use this whenever the plan has a db service and no cache, regardless of replica count (UC-1, UC-5)",
  render(plan, variables, ctx): RenderResult {
    const app = appServices(plan)[0];
    const db = dbService(plan);
    if (!app || !db) {
      throw new Error("compose-web-db-v1: plan must include one app service and one db service");
    }

    const containerPort = app.ports[0] ?? 3000;
    const hostPort = hostPortFor(plan, app.name, containerPort);
    const healthPath = typeof variables.health_path === "string" ? variables.health_path : "/";
    const dbName = typeof variables.db_name === "string" ? variables.db_name : "appdb";
    const dbUser = typeof variables.db_user === "string" ? variables.db_user : "appuser";
    const dbPassword = typeof variables.db_password === "string" ? variables.db_password : generateSecret();

    const isPg = db.image.startsWith("postgres");
    const dbPort = db.ports[0] ?? (isPg ? 5432 : 3306);
    // Only published when the plan explicitly asks for it (network.expose
    // carrying an entry for the db service name) — every existing plan
    // leaves the db unexposed to the host, as before. The build-sentinel
    // path (nodes/planner.ts) is what sets this, since its migration step
    // runs as a host process and needs to reach Postgres directly.
    const dbExpose = plan.network.expose.find((e) => e.service === db.name);
    const storageName = plan.storage[0]?.name ?? "dbdata";
    const dataPath = isPg ? "/var/lib/postgresql/data" : "/var/lib/mysql";
    const databaseUrl = isPg
      ? `postgres://${dbUser}:${dbPassword}@${db.name}:${dbPort}/${dbName}`
      : `mysql://${dbUser}:${dbPassword}@${db.name}:${dbPort}/${dbName}`;
    const front = frontIfScaled(app.name, containerPort, hostPort, app.replicas);

    const doc: ComposeDoc = {
      services: {
        [app.name]: {
          image: app.image,
          ports: front.appPorts,
          restart: "unless-stopped",
          environment: { DATABASE_URL: databaseUrl },
          depends_on: { [db.name]: { condition: "service_healthy" } },
          healthcheck: httpHealthcheck(containerPort, healthPath),
          deploy: { replicas: app.replicas, resources: { limits: { cpus: app.cpu, memory: app.memory } } },
        },
        [db.name]: {
          image: db.image,
          ports: dbExpose ? [`${dbExpose.host_port}:${dbPort}`] : undefined,
          restart: "unless-stopped",
          environment: isPg
            ? { POSTGRES_DB: dbName, POSTGRES_USER: dbUser, POSTGRES_PASSWORD: dbPassword }
            : {
                MYSQL_DATABASE: dbName,
                MYSQL_USER: dbUser,
                MYSQL_PASSWORD: dbPassword,
                MYSQL_ROOT_PASSWORD: dbPassword,
              },
          volumes: [`${storageName}:${dataPath}`],
          healthcheck: isPg ? pgHealthcheck(dbUser) : mysqlHealthcheck(),
          deploy: { resources: { limits: { cpus: db.cpu, memory: db.memory } } },
        },
        ...front.extraServices,
      },
      volumes: { [storageName]: null },
    };

    return {
      files: [
        { path: "docker-compose.yml", content: dumpCompose(doc) },
        { path: ".env", content: `DB_PASSWORD=${dbPassword}\n` },
        ...front.extraFiles,
      ],
      applyCommand: `docker compose -p ${ctx.projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${ctx.projectName} down -v`,
    };
  },
};

const composeWebDbCacheV1: TemplateDefinition = {
  id: "compose-web-db-cache-v1",
  format: "compose",
  description:
    "app + db + redis, ANY replica count (nginx auto-added if >1) — use this whenever the plan has BOTH a db and a cache service, regardless of replica count (UC-7 target state)",
  render(plan, variables, ctx): RenderResult {
    const app = appServices(plan)[0];
    const db = dbService(plan);
    const cache = cacheService(plan);
    if (!app || !db || !cache) {
      throw new Error("compose-web-db-cache-v1: plan must include app, db, and cache services");
    }

    const containerPort = app.ports[0] ?? 3000;
    const hostPort = hostPortFor(plan, app.name, containerPort);
    const healthPath = typeof variables.health_path === "string" ? variables.health_path : "/";
    const dbName = typeof variables.db_name === "string" ? variables.db_name : "appdb";
    const dbUser = typeof variables.db_user === "string" ? variables.db_user : "appuser";
    const dbPassword = typeof variables.db_password === "string" ? variables.db_password : generateSecret();

    const isPg = db.image.startsWith("postgres");
    const dbPort = db.ports[0] ?? (isPg ? 5432 : 3306);
    const dbExpose = plan.network.expose.find((e) => e.service === db.name);
    const storageName = plan.storage[0]?.name ?? "dbdata";
    const dataPath = isPg ? "/var/lib/postgresql/data" : "/var/lib/mysql";
    const cachePort = cache.ports[0] ?? 6379;
    const databaseUrl = isPg
      ? `postgres://${dbUser}:${dbPassword}@${db.name}:${dbPort}/${dbName}`
      : `mysql://${dbUser}:${dbPassword}@${db.name}:${dbPort}/${dbName}`;
    const front = frontIfScaled(app.name, containerPort, hostPort, app.replicas);

    const doc: ComposeDoc = {
      services: {
        [app.name]: {
          image: app.image,
          ports: front.appPorts,
          restart: "unless-stopped",
          environment: { DATABASE_URL: databaseUrl, REDIS_URL: `redis://${cache.name}:${cachePort}` },
          depends_on: {
            [db.name]: { condition: "service_healthy" },
            [cache.name]: { condition: "service_healthy" },
          },
          healthcheck: httpHealthcheck(containerPort, healthPath),
          deploy: { replicas: app.replicas, resources: { limits: { cpus: app.cpu, memory: app.memory } } },
        },
        [db.name]: {
          image: db.image,
          ports: dbExpose ? [`${dbExpose.host_port}:${dbPort}`] : undefined,
          restart: "unless-stopped",
          environment: isPg
            ? { POSTGRES_DB: dbName, POSTGRES_USER: dbUser, POSTGRES_PASSWORD: dbPassword }
            : {
                MYSQL_DATABASE: dbName,
                MYSQL_USER: dbUser,
                MYSQL_PASSWORD: dbPassword,
                MYSQL_ROOT_PASSWORD: dbPassword,
              },
          volumes: [`${storageName}:${dataPath}`],
          healthcheck: isPg ? pgHealthcheck(dbUser) : mysqlHealthcheck(),
          deploy: { resources: { limits: { cpus: db.cpu, memory: db.memory } } },
        },
        [cache.name]: {
          image: cache.image,
          restart: "unless-stopped",
          healthcheck: redisHealthcheck(),
          deploy: { resources: { limits: { cpus: cache.cpu, memory: cache.memory } } },
        },
        ...front.extraServices,
      },
      volumes: { [storageName]: null },
    };

    return {
      files: [
        { path: "docker-compose.yml", content: dumpCompose(doc) },
        { path: ".env", content: `DB_PASSWORD=${dbPassword}\n` },
        ...front.extraFiles,
      ],
      applyCommand: `docker compose -p ${ctx.projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${ctx.projectName} down -v`,
    };
  },
};

const composeLbReplicasV1: TemplateDefinition = {
  id: "compose-lb-replicas-v1",
  format: "compose",
  description:
    "nginx + N app replicas + optional redis, NO db support — do not pick this for a plan that includes a db service, it will be silently dropped; only use when there is no db service, even if replicas > 1 (compose-web-db-v1 already handles replicas > 1 with a db) (UC-4)",
  render(plan, _variables, ctx): RenderResult {
    const app = appServices(plan)[0];
    const cache = cacheService(plan);
    if (!app) throw new Error("compose-lb-replicas-v1: plan must include one app service");

    const containerPort = app.ports[0] ?? 3000;
    const hostPort = hostPortFor(plan, "nginx", 3000);

    const services: ComposeDoc["services"] = {
      nginx: {
        image: "nginx:alpine",
        ports: [`${hostPort}:80`],
        restart: "unless-stopped",
        volumes: ["./nginx.conf:/etc/nginx/nginx.conf:ro"],
        depends_on: { [app.name]: { condition: "service_healthy" } },
      },
      [app.name]: {
        image: app.image,
        restart: "unless-stopped",
        environment: cache ? { REDIS_URL: `redis://${cache.name}:${cache.ports[0] ?? 6379}` } : undefined,
        depends_on: cache ? { [cache.name]: { condition: "service_healthy" } } : undefined,
        healthcheck: httpHealthcheck(containerPort, "/"),
        deploy: { replicas: app.replicas, resources: { limits: { cpus: app.cpu, memory: app.memory } } },
      },
    };
    if (cache) {
      services[cache.name] = {
        image: cache.image,
        restart: "unless-stopped",
        healthcheck: redisHealthcheck(),
        deploy: { resources: { limits: { cpus: cache.cpu, memory: cache.memory } } },
      };
    }

    return {
      files: [
        { path: "docker-compose.yml", content: dumpCompose({ services }) },
        { path: "nginx.conf", content: singleUpstreamNginxConf(app.name, containerPort) },
      ],
      applyCommand: `docker compose -p ${ctx.projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${ctx.projectName} down -v`,
    };
  },
};

/**
 * Fixed worked example pairing the two realworld-* build-sentinel entries
 * (nodes/buildRegistry.ts) — postgres + the Node/Express/Prisma backend +
 * a browser-rendered React frontend. Unlike every other template here, this
 * one is never picked by the LLM's own judgement — iac_generator forces this
 * template_id whenever both sentinels are present in the plan (see
 * iacGenerator.ts) — so it's allowed to assume a fixed "app"/"web" service
 * naming and 2-app-service shape that appServices(plan)[0] alone can't
 * express, rather than trying to generalize appServices() itself.
 */
const composeRealworldFullstackV1: TemplateDefinition = {
  id: "compose-realworld-fullstack-v1",
  format: "compose",
  description:
    "RealWorld/Conduit fullstack worked example: postgres + Node/Express/Prisma backend (build-sentinel " +
    "realworld-node-express, service name \"app\") + React/CRA frontend served by nginx (build-sentinel " +
    "realworld-react-frontend, service name \"web\") — use ONLY when plan.services contains both of those " +
    "two exact build sentinels alongside a db service; never pick this for any other topology (backend " +
    "forces this template_id itself when both sentinels are present, so the LLM does not need to choose it).",
  render(plan, variables, ctx): RenderResult {
    const backend = plan.services.find((s) => s.name === "app");
    const frontend = plan.services.find((s) => s.name === "web");
    const db = dbService(plan);
    if (!backend || !frontend || !db) {
      throw new Error(
        'compose-realworld-fullstack-v1: plan must include an "app" (backend) service, a "web" (frontend) service, and a db service'
      );
    }

    const backendContainerPort = backend.ports[0] ?? 3000;
    const backendHostPort = hostPortFor(plan, backend.name, backendContainerPort);
    const frontendContainerPort = frontend.ports[0] ?? 80;
    const frontendHostPort = hostPortFor(plan, frontend.name, frontendContainerPort);

    const dbName = typeof variables.db_name === "string" ? variables.db_name : "appdb";
    const dbUser = typeof variables.db_user === "string" ? variables.db_user : "appuser";
    const dbPassword = typeof variables.db_password === "string" ? variables.db_password : generateSecret();
    const dbPort = db.ports[0] ?? 5432;
    const dbExpose = plan.network.expose.find((e) => e.service === db.name);
    const storageName = plan.storage[0]?.name ?? "dbdata";
    const databaseUrl = `postgres://${dbUser}:${dbPassword}@${db.name}:${dbPort}/${dbName}`;

    const doc: ComposeDoc = {
      services: {
        [db.name]: {
          image: db.image,
          ports: dbExpose ? [`${dbExpose.host_port}:${dbPort}`] : undefined,
          restart: "unless-stopped",
          environment: { POSTGRES_DB: dbName, POSTGRES_USER: dbUser, POSTGRES_PASSWORD: dbPassword },
          volumes: [`${storageName}:/var/lib/postgresql/data`],
          healthcheck: pgHealthcheck(dbUser),
          deploy: { resources: { limits: { cpus: db.cpu, memory: db.memory } } },
        },
        [backend.name]: {
          image: backend.image, // already resolved to the local -app:<hex> tag by iacGenerator.ts
          ports: [`${backendHostPort}:${backendContainerPort}`],
          restart: "unless-stopped",
          environment: { DATABASE_URL: databaseUrl },
          depends_on: { [db.name]: { condition: "service_healthy" } },
          healthcheck: httpHealthcheck(backendContainerPort, "/api/tags"),
          deploy: { resources: { limits: { cpus: backend.cpu, memory: backend.memory } } },
        },
        [frontend.name]: {
          image: frontend.image, // already resolved to its own local -app:<hex> tag by iacGenerator.ts
          ports: [`${frontendHostPort}:${frontendContainerPort}`],
          restart: "unless-stopped",
          // No depends_on the backend: the frontend's API base URL is already burned into its static
          // JS bundle at BUILD time (buildRegistry.ts) — it doesn't need the backend up to start
          // serving, only to successfully answer the browser's own fetches once a user loads it.
          healthcheck: httpHealthcheck(frontendContainerPort, "/"),
          deploy: { resources: { limits: { cpus: frontend.cpu, memory: frontend.memory } } },
        },
      },
      volumes: { [storageName]: null },
    };

    return {
      files: [{ path: "docker-compose.yml", content: dumpCompose(doc) }],
      applyCommand: `docker compose -p ${ctx.projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${ctx.projectName} down -v`,
    };
  },
};

// "freeform" is a sentinel template_id for LLM-written files (skills/novel-requirement-reasoning.md),
// not a real catalog entry. "tf-enterprise-ecs-fargate-v1" is rendered directly by
// templates/enterpriseCatalog.ts (Enterprise Architecture Advisor, Phase 2) — iacGenerator.ts
// bypasses this catalogue entirely for it, so it's never LLM-choosable and never appears in
// templateCatalogSummary()'s output. Both excluded here so TEMPLATES stays exactly the
// generic-engine's own rendered-template catalogue.
export const TEMPLATES: Record<Exclude<TemplateId, "freeform" | "tf-enterprise-ecs-fargate-v1">, TemplateDefinition> = {
  "compose-single-v1": composeSingleV1,
  "compose-web-db-v1": composeWebDbV1,
  "compose-web-db-cache-v1": composeWebDbCacheV1,
  "compose-lb-replicas-v1": composeLbReplicasV1,
  "compose-realworld-fullstack-v1": composeRealworldFullstackV1,
  ...TERRAFORM_TEMPLATES,
};

export function renderTemplate(
  templateId: Exclude<TemplateId, "freeform" | "tf-enterprise-ecs-fargate-v1">,
  plan: Parameters<TemplateDefinition["render"]>[0],
  variables: Record<string, unknown>,
  ctx: RenderContext
): RenderResult {
  const tpl = TEMPLATES[templateId];
  if (!tpl) throw new Error(`renderTemplate: unknown template_id "${templateId}"`);
  return tpl.render(plan, variables, ctx);
}

export function templateCatalogSummary(): string {
  return Object.values(TEMPLATES)
    .map((t) => `- ${t.id} (${t.format}): ${t.description}`)
    .join("\n");
}
