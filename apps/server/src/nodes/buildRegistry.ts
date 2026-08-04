/**
 * Hardcoded, developer-reviewed registry of repos the pipeline is allowed to
 * clone and build. This is the ONLY place that maps a planner-emitted
 * sentinel string to a real repo URL — the LLM/user-supplied raw_text can
 * never influence what actually gets cloned or built (mirrors the
 * "__GENERATE__" secret sentinel pattern in templates/secrets.ts, applied to
 * build sources instead of random values). commandAllowList.ts derives its
 * git/build allow-list rules from this table, so the set of clonable repos
 * stays closed and auditable in one place.
 */
export interface BuildRegistryEntry {
  key: string;
  displayName: string;
  /** Exact clone URL — never a user/LLM-supplied value. */
  repoUrl: string;
  /** Exact 40-hex commit — never a floating branch/tag, for reproducibility and to close the "upstream force-pushes something malicious" window. */
  commitSha: string;
  containerPort: number;
  healthPath: string;
  /**
   * Registry key of the entry this one is meant to be deployed alongside
   * (e.g. a frontend paired with its backend API), or null for a
   * standalone entry. Kept here rather than having the planner independently
   * emit both sentinels together, so the pairing lives in the one file
   * that's already the source of truth for these repos and can't silently
   * drift. iac_generator looks up BUILD_REGISTRY[entry.pairedWith] to learn
   * the paired service's resolved host port (see iacGenerator.ts).
   */
  pairedWith: string | null;
  /**
   * True only for an entry whose build needs a database + host-side
   * migration step (today: realworld-node-express) — drives iac_generator.ts
   * down the db-bringup-and-migrate branch instead of treating `pairedWith
   * === null` alone as "this is a backend that needs a db", which stopped
   * being a safe assumption once standalone, no-DB build sentinels
   * (vite-react-frontend, nginx-hello, aws-copilot-sample) were added.
   */
  needsDatabase: boolean;
  /**
   * Subfolder within the cloned repo that actually contains the Dockerfile
   * (and is therefore the `docker build` context), or null when it's at the
   * repo root. Needed for nginx-hello, whose Dockerfile lives at
   * `nginx-hello/Dockerfile` inside the `nginxinc/NGINX-Demos` monorepo
   * checkout. build.ts's isKnownCwd() only allows this exact value (derived
   * from this closed table), never an arbitrary subpath.
   */
  dockerfileSubdir: string | null;
  /**
   * The repo's own Dockerfile only `npm --omit=dev install`s inside the
   * container, so @prisma/client's postinstall generate step has neither
   * the `prisma` CLI (a devDependency, stripped by --omit=dev) nor the
   * schema file (nx build's dist/api output doesn't include it) to work
   * with — every container built from it fails at runtime with
   * "@prisma/client did not initialize yet". Confirmed by manually running
   * the built image standalone.
   *
   * Fix required THREE separate layers, each confirmed by manually running
   * the built image standalone against a real Postgres until /api/tags
   * actually returned {"tags":[]}:
   *
   * 1. `prisma generate` MUST run inside the same target platform the engine
   *    binary will actually run on (generating on the Windows build host and
   *    copying the result in fails differently: "could not locate the Query
   *    Engine for runtime linux-musl... generated for windows"). So this
   *    override Dockerfile copies just package.json + the schema and runs
   *    npm ci + prisma generate INSIDE the linux-alpine container itself.
   * 2. Even generated in-container, Prisma's OWN platform auto-detection is
   *    broken here — it warns "failed to detect the libssl/openssl version,
   *    defaulting to openssl-1.1.x" and generates the wrong engine variant,
   *    even though node:lts-alpine actually ships libssl.so.3, not 1.1
   *    (confirmed: no libssl.so.1.1 anywhere in the image). Forcing
   *    `binaryTargets = ["linux-musl-openssl-3.0.x"]` in schema.prisma (via
   *    sed, since there's no CLI flag for it in this Prisma version) fixes
   *    generation, but:
   * 3. ...the CLIENT's runtime engine-selection is ALSO affected by the same
   *    broken auto-detection, so it still tries to load the (nonexistent)
   *    plain "linux-musl" variant at container startup and crashes anyway.
   *    PRISMA_QUERY_ENGINE_LIBRARY bypasses that auto-detection entirely by
   *    pointing directly at the one correct .so.node file that was actually
   *    generated — this is what actually gets the container to `Up` instead
   *    of `Exited` and serve real responses.
   *
   * Null for a registry entry whose own Dockerfile doesn't have this problem.
   *
   * NODE_TLS_REJECT_UNAUTHORIZED=0 on the `prisma generate` layer only:
   * this network's TLS-inspecting corporate proxy breaks that one call
   * (Prisma's engine-binary CDN, binaries.prisma.sh — confirmed via the
   * exact same SELF_SIGNED_CERT_IN_CHAIN signature as the server's own
   * earlier Supabase/Anthropic issue, but here inside an isolated Docker
   * build container where --use-system-ca has no reach at all). This is a
   * real, deliberate security downgrade for that one layer — accepted only
   * because the thing being fetched (Prisma's own official engine binary,
   * for the exact @prisma/client version this pinned commit already
   * depends on) is not attacker-influenced content; every other layer
   * keeps normal certificate verification. Not a general project pattern —
   * revert this the moment the proxy's root CA can be supplied instead.
   */
  dockerfileOverride: string | null;
}

export const BUILD_SENTINEL_PREFIX = "__BUILD__:";

/**
 * Placeholder token baked into the frontend's compiled JS bundle at build
 * time (see "realworld-react-frontend"'s dockerfileOverride below) —
 * iacGenerator.ts substitutes this for the real
 * `http://localhost:<backend host port>/api` URL once the backend's host
 * port is known, entirely at plan-render time (before either image is
 * actually built).
 */
export const FRONTEND_API_ROOT_PLACEHOLDER = "__OPS_MASTER_API_ROOT_PLACEHOLDER__";

export const BUILD_REGISTRY: Record<string, BuildRegistryEntry> = {
  "realworld-node-express": {
    key: "realworld-node-express",
    displayName: "RealWorld Node/Express/Prisma reference API",
    repoUrl: "https://github.com/gothinkster/node-express-realworld-example-app.git",
    // Verified via `git ls-remote` on 2026-07-24 — re-verify (and update commandAllowList.ts's
    // derived allow-list rule) before relying on this if the plan is executed much later.
    commitSha: "30b68e1e881462b2f4164ea09ab4c4f5699c7b0b",
    containerPort: 3000,
    healthPath: "/api/tags",
    pairedWith: null,
    needsDatabase: true,
    dockerfileSubdir: null,
    dockerfileOverride: [
      "FROM node:lts-alpine",
      "WORKDIR /app",
      "COPY package.json package-lock.json ./",
      "COPY src/prisma ./src/prisma",
      "RUN npm ci",
      // Force the one binary target that actually exists on this base image
      // (see dockerfileOverride doc comment above) — no CLI flag for this in
      // this Prisma version, so patched directly into the schema.
      "RUN sed -i '/generator client {/a\\  binaryTargets = [\"linux-musl-openssl-3.0.x\"]' src/prisma/schema.prisma",
      // Scoped TLS bypass, this layer only — see dockerfileOverride doc comment above.
      "RUN NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma generate",
      "RUN addgroup --system api && adduser --system -G api api",
      "COPY dist/api api",
      "RUN npm --prefix api --omit=dev -f install",
      "RUN rm -rf api/node_modules/.prisma && cp -r node_modules/.prisma api/node_modules/.prisma",
      "RUN chown -R api:api .",
      "USER api",
      "ENV PORT=3000",
      // Bypasses Prisma's own broken runtime engine auto-detection — see
      // dockerfileOverride doc comment above (point 3).
      "ENV PRISMA_QUERY_ENGINE_LIBRARY=/app/api/node_modules/.prisma/client/libquery_engine-linux-musl-openssl-3.0.x.so.node",
      'CMD [ "node", "api" ]',
      "",
    ].join("\n"),
  },
  "realworld-react-frontend": {
    key: "realworld-react-frontend",
    displayName: "RealWorld React/Redux/CRA reference frontend (Conduit)",
    repoUrl: "https://github.com/gothinkster/react-redux-realworld-example-app.git",
    // Verified via `git ls-remote` on 2026-07-25 (matches HEAD/master) — re-verify before relying on
    // this if executed much later, same discipline as the backend entry above.
    commitSha: "ee72eba4056392c95a27bc48d385d3f54ba38a18",
    containerPort: 80,
    healthPath: "/",
    pairedWith: "realworld-node-express",
    needsDatabase: false,
    dockerfileSubdir: null,
    dockerfileOverride: [
      // node:16-alpine, not node:lts-alpine: this repo is react-scripts@1.1.1
      // (2018-era webpack 2/3). Confirmed by actually building it: node:16
      // ships OpenSSL 1.1.1 (pre-3.0), so the classic
      // "error:0308010C:digital envelope routines::unsupported" crash a newer
      // Node would hit here never happens — no --openssl-legacy-provider
      // flag needed at all on this base image.
      "FROM node:16-alpine AS build",
      "WORKDIR /app",
      "COPY package.json ./",
      // No package-lock.json in this repo (confirmed) — npm ci isn't an
      // option, only npm install.
      "RUN npm install",
      "COPY . .",
      // src/agent.js hardcodes its API base URL as a plain string literal —
      // no env-var mechanism exists (upstream issue #107, never implemented,
      // repo archived 2021-09-08 read-only) — so patch it directly, same
      // sed-before-build pattern as the backend entry above. iacGenerator.ts
      // replaces this placeholder with the real, resolved backend host-port
      // URL before writing this Dockerfile out (see FRONTEND_API_ROOT_PLACEHOLDER).
      `RUN sed -i "s#https://conduit.productionready.io/api#${FRONTEND_API_ROOT_PLACEHOLDER}#" src/agent.js`,
      "RUN npm run build",
      "",
      "FROM nginx:alpine",
      "COPY --from=build /app/build /usr/share/nginx/html",
      "EXPOSE 80",
      "",
    ].join("\n"),
  },
  // Standalone entries below (source_configuration/new-use-case/0{1,2,3}-fargate-demo-*.md,
  // catalogued as UC-15/UC-16/UC-14 in agent-md-files/USE_CASES.md): pairedWith: null and
  // needsDatabase: false, so iac_generator.ts's build-sentinel loop takes the plain
  // "clone + checkout + docker build, no host build/migrate steps" path — the repo's own
  // Dockerfile does all the work (either it's a static-file COPY, or, for
  // vite-react-frontend, the Vite build happens entirely inside the Dockerfile's own
  // node:18-alpine3.17 build stage).
  "vite-react-frontend": {
    key: "vite-react-frontend",
    displayName: "Vite/React static frontend demo (no DB)",
    repoUrl: "https://github.com/mattburrell/vite-react-docker.git",
    // Verified via git clone on 2026-08-01 — re-verify before relying on this if executed much later.
    commitSha: "5d96169e8712659f60fc47f671cc54f6c4fe9d47",
    containerPort: 80,
    healthPath: "/",
    pairedWith: null,
    needsDatabase: false,
    dockerfileSubdir: null,
    dockerfileOverride: null, // repo's own two-stage Dockerfile is already correct as-is
  },
  "nginx-hello": {
    key: "nginx-hello",
    displayName: "nginx hello-world demo (live hostname/IP page)",
    repoUrl: "https://github.com/nginxinc/NGINX-Demos.git",
    // Verified via git clone on 2026-08-01 — re-verify before relying on this if executed much later.
    commitSha: "611fa05748a4031841e5607cd3069288b0aa9973",
    containerPort: 80,
    healthPath: "/",
    pairedWith: null,
    needsDatabase: false,
    // This repo's Dockerfile lives in the nginx-hello/ subfolder, not the repo root (the checkout
    // pulls the whole NGINX-Demos monorepo) — see dockerfileSubdir's doc comment above.
    dockerfileSubdir: "nginx-hello",
    dockerfileOverride: null, // repo's own Dockerfile is already correct as-is
  },
  "aws-copilot-sample": {
    key: "aws-copilot-sample",
    displayName: "AWS official Copilot sample service (static nginx page)",
    repoUrl: "https://github.com/aws-samples/aws-copilot-sample-service.git",
    // Verified via git clone on 2026-08-01 — re-verify before relying on this if executed much later.
    commitSha: "2f5a45e5561f0d99e4328eac02d93358d2489d63",
    containerPort: 80,
    healthPath: "/",
    pairedWith: null,
    needsDatabase: false,
    dockerfileSubdir: null,
    dockerfileOverride: null, // repo's own Dockerfile is already correct as-is
  },
};

/** Returns the registry key if `image` is a recognized build sentinel, else null. Unknown "__BUILD__:*" keys are NOT resolved — they fall through as an invalid image string rather than building something not in this table. */
export function isBuildSentinel(image: string): string | null {
  if (!image.startsWith(BUILD_SENTINEL_PREFIX)) return null;
  const key = image.slice(BUILD_SENTINEL_PREFIX.length);
  return key in BUILD_REGISTRY ? key : null;
}
