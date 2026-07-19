# Repo Catalogue → Executable Use Cases

Each repo below is mapped to an **executable use case**: the exact natural-language request to type in the demo, the vetted template the IaC agent should select, the apply/rollback commands, and the verify checks. UC-1..UC-8 match `USE_CASES.md`; UC-9..UC-13 are the additions (including AWS/LocalStack).

**Priority tiers:** 🔴 lock in first · 🟡 variety/backup · 🟢 stretch

---

## 🔴 UC-1 — Node.js + PostgreSQL @ 500 rps (FLAGSHIP)

- **Repo:** https://github.com/gothinkster/node-express-realworld-example-app
- **NL request:** "Create a staging environment for a Node.js application with PostgreSQL capable of handling 500 requests/second."
- **Template:** `compose-web-db-v1` · **Expected plan:** 2× api (512Mi) + nginx + postgres (1Gi) + volume
- **Apply:** `docker compose -p uc1 up -d --wait` · **Rollback:** `docker compose -p uc1 down -v`
- **Verify:** `GET http://localhost:3000/api/tags` = 200 · k6 500 rps/30s, p95<300ms, err<1%
- **Prep:** clone repo, `docker build -t realworld-api .` night before; seed script in repo's `prisma/seed`

## 🔴 UC-2 — Single-container dev env (OPENER)

- **Repo:** https://github.com/docker/getting-started-app
- **NL request:** "Spin up a dev environment for a simple Node.js todo app, low traffic, single instance."
- **Template:** `compose-single-v1` · **Plan:** 1× app 256Mi
- **Verify:** `GET http://localhost:3000/` = 200 · k6 20 rps/15s
- **Total runtime target:** < 60s end-to-end — use as every-morning pipeline sanity check

## 🟡 UC-3 — 5-service voting app (MULTI-SERVICE)

- **Repo:** https://github.com/dockersamples/example-voting-app
- **NL request:** "Provision a QA environment for a voting application with vote frontend, results dashboard, Redis queue and Postgres, ~200 concurrent voters."
- **Template:** `compose-voting-v1` (mirror the repo's own compose topology; agent sizes each service)
- **Verify:** 200 on :8080 (vote) and :8081 (results) · functional smoke: POST 20 votes → results total increments

## 🟡 UC-4 — Load-balanced Node + Redis (REPLICAS)

- **Repo:** https://github.com/docker/awesome-compose → folder `nginx-nodejs-redis/`
- **NL request:** "I need a load-balanced Node.js web tier with Redis, 3 replicas behind Nginx, for performance testing."
- **Template:** `compose-lb-replicas-v1` (`deploy.replicas: 3`)
- **Verify:** k6 via Nginx · assert ≥3 distinct upstream hostnames in responses (proves round-robin) + p95 threshold

## 🟡 UC-5 — Spring Boot + MySQL (JVM SIZING)

- **Repo:** https://github.com/spring-projects/spring-petclinic
- **NL request:** "Set up a test environment for a Java Spring Boot application with MySQL, around 50 users."
- **Template:** `compose-web-db-v1` (mysql variant) · **Plan must show:** 1Gi memory + `JAVA_OPTS=-Xmx768m` with JVM rule cited in reasoning
- **Verify:** `GET :8080/actuator/health` → `{"status":"UP"}` · k6 50 rps
- **Prep:** JVM build is slow — pre-build the image; skip live if running behind schedule

## 🟢 UC-6 — Online Boutique on Minikube (KUBERNETES STRETCH)

- **Repo:** https://github.com/GoogleCloudPlatform/microservices-demo
- **NL request:** "Deploy the Online Boutique storefront to a Kubernetes staging cluster with autoscaling on the frontend."
- **Template:** `k8s-manifests-v1` · **Apply:** `kubectl apply -f deployments/uc6/` · **Rollback:** `kubectl delete -f deployments/uc6/`
- **Verify:** `kubectl rollout status` per deployment + frontend HTTP 200
- **Gate:** attempt only after UC-1/2/7/8 are rock solid; needs 8Gi+ free RAM

## 🔴 UC-7 — Add Redis cache to running env (MODIFY)

- **Repo:** extends UC-1 (alt. richer target: https://github.com/thedevs-network/kutt — see UC-9)
- **NL request:** "Add a Redis cache to the staging environment we just created and wire the app to it."
- **Template:** `compose-web-db-cache-v1` with `diff_from` = UC-1 files → UI renders diff at approval gate
- **Verify:** Redis PING · app health unchanged · Postgres data intact (query a seeded row before/after)
- **Rollback rule:** re-apply previous files, **never** `down -v`

## 🔴 UC-8 — Refusal + rollback (RESPONSIBLE AI, no repo)

- **8a Refusal:** "Provision production with 50,000 req/s and five-nines availability." → planner: `feasible=false`, reasoned alternative, nothing deploys, audit shows the refusal.
- **8b Rollback:** prepared request with wrong DB password → deploy up → verify red → auto-rollback → timeline shows the full sequence.

## 🟡 UC-9 — 3-tier URL shortener (Node + Postgres + Redis)

- **Repo:** https://github.com/thedevs-network/kutt
- **NL request:** "Provision a staging environment for a URL-shortener service with Postgres and Redis, ~100 rps."
- **Template:** `compose-web-db-cache-v1` · **Plan:** app 512Mi + postgres 1Gi + redis 256Mi
- **Verify:** `GET /api/v2/health` (or `/` 200) · functional: create short link via API → GET redirect works
- **Why:** an app that *genuinely needs* all three tiers — strongest "real product" feel per minute of setup

## 🟡 UC-10 — Instant-UI monitoring tool (single container)

- **Repo:** https://github.com/louislam/uptime-kuma
- **NL request:** "Give me a monitoring dashboard environment, single instance, internal use."
- **Template:** `compose-single-v1` (image `louislam/uptime-kuma:1`, volume for data)
- **Verify:** `GET http://localhost:3001/` = 200
- **Why:** the dashboard appears seconds after approval — best pure crowd moment per effort

## 🟡 UC-11 — Python variants (FastAPI / Flask)

- **Repos:** https://github.com/tiangolo/full-stack-fastapi-template (FastAPI + Postgres + React) · https://github.com/miguelgrinberg/microblog (Flask + MySQL)
- **NL request:** "Create a staging environment for a Python FastAPI application with PostgreSQL, 300 requests/second."
- **Template:** `compose-web-db-v1` · **Plan must apply the Python rule:** ~150 rps/instance → 2 replicas (different arithmetic than Node — say this aloud in demo)
- **Verify:** FastAPI `GET /docs` or `/api/v1/utils/health-check` = 200 · k6 300 rps

---

# AWS / LocalStack use cases (Terraform path)

Common prep: `pip install terraform-local` (gives `tflocal`, auto-points providers at `localhost:4566`); LocalStack container running per INSTALLATION.md §4. Deploy-agent allow-list already covers `terraform apply/destroy` — use `tflocal` as the binary in template metadata for these.

## 🟡 UC-12 — Serverless API on emulated AWS

- **Repos:** https://github.com/localstack/localstack-terraform-samples (primary — lift the `apigateway-lambda-dynamodb` style sample) · https://github.com/aws-samples/serverless-patterns (backup pattern source)
- **NL request:** "Provision a serverless REST API on AWS with API Gateway, a Lambda function and a DynamoDB table for a staging test."
- **Template:** `tf-localstack-serverless-v1` (new — Anshul lifts from the LocalStack sample, parameterises table/function names)
- **Apply:** `tflocal init -input=false && tflocal apply -auto-approve -input=false` · **Rollback:** `tflocal destroy -auto-approve -input=false`
- **Verify:** invoke the API Gateway URL on :4566 → 200 · `awslocal dynamodb scan --table-name <t>` returns the written item
- **Why:** shows the same pipeline emitting **Terraform for AWS resources**, zero cloud cost — the "target-agnostic" proof

## 🟢 UC-13 — AWS network foundation (VPC)

- **Repo:** https://github.com/terraform-aws-modules/terraform-aws-vpc
- **NL request:** "Set up an AWS VPC with two public and two private subnets across two AZs for a new project."
- **Template:** `tf-localstack-vpc-v1` (thin root module calling `terraform-aws-modules/vpc/aws` with agent-filled CIDRs)
- **Verify:** `awslocal ec2 describe-vpcs` / `describe-subnets` → counts match plan
- **Why:** `terraform plan` output at the approval gate looks exactly like real enterprise change management — great governance visual. Stretch: no HTTP endpoint to load-test, so verify is API-assertion only

---

## Quick reference: repo → template → tier

| UC | Repo | Template | Tier |
|----|------|----------|------|
| 1 | node-express-realworld-example-app | compose-web-db-v1 | 🔴 |
| 2 | getting-started-app | compose-single-v1 | 🔴 |
| 3 | example-voting-app | compose-voting-v1 | 🟡 |
| 4 | awesome-compose/nginx-nodejs-redis | compose-lb-replicas-v1 | 🟡 |
| 5 | spring-petclinic | compose-web-db-v1 (mysql) | 🟡 |
| 6 | microservices-demo | k8s-manifests-v1 | 🟢 |
| 7 | (UC-1 modify) | compose-web-db-cache-v1 | 🔴 |
| 8 | — (refusal/rollback) | — | 🔴 |
| 9 | kutt | compose-web-db-cache-v1 | 🟡 |
| 10 | uptime-kuma | compose-single-v1 | 🟡 |
| 11 | full-stack-fastapi-template / microblog | compose-web-db-v1 | 🟡 |
| 12 | localstack-terraform-samples (+ serverless-patterns) | tf-localstack-serverless-v1 | 🟡 |
| 13 | terraform-aws-vpc | tf-localstack-vpc-v1 | 🟢 |

**Demo-day run order:** UC-2 (opener) → UC-1 (flagship) → UC-7 (modify+diff) → UC-12 (AWS flavour) → UC-8 (refusal + rollback close). Everything else is bench strength.
