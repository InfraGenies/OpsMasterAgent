# Fargate Demo App 1 — Static React Frontend (no DB, dev environment)

Catalogued as **UC-15** in [`agent-md-files/USE_CASES.md`](../../agent-md-files/USE_CASES.md). Cost-safety
auto-teardown for the manual AWS CLI path below: [`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1)
(same folder) — see section 6.

| Field | Value |
|---|---|
| Repo | https://github.com/mattburrell/vite-react-docker |
| Maintainer | Individual dev (Matt Burrell) |
| License | MIT |
| Pinned commit | `5d96169e8712659f60fc47f671cc54f6c4fe9d47` |
| Build needed | **Yes** — Vite build runs inside the Docker build |
| Base image risk | Docker Hub (`node:18-alpine3.17` build stage, `ubuntu` runtime stage) |
| Container port | 80 |
| Health path | `/` |
| Database / env vars | None |

Verified by cloning the repo directly — the Dockerfile below is the exact file at the pinned
commit, not reconstructed from memory.

## 1. What it is

A minimal Vite + React app with a two-stage Dockerfile: the app is built in a Node stage, then the
static `dist/` output is copied into an `nginx`-on-`ubuntu` runtime stage. No backend calls, no
environment variables, no database — purely static assets served on port 80. Good for demonstrating
the "static frontend, dev environment" use case cleanly.

```dockerfile
FROM node:18-alpine3.17 as build

WORKDIR /app
COPY . /app

RUN npm install
RUN npm run build

FROM ubuntu
RUN apt-get update
RUN apt-get install nginx -y
COPY --from=build /app/dist /var/www/html/
EXPOSE 80
CMD ["nginx","-g","daemon off;"]
```

**Note on build time:** the runtime stage is `ubuntu` + `apt-get install nginx`, not
`nginx:alpine` — this makes the image larger and the build slower than it needs to be
(~150–200MB extra, ~30–60s extra build time). Fine for a one-off demo build; if this becomes a
recurring pipeline step, consider swapping the second stage for `nginx:alpine` +
`COPY --from=build /app/dist /usr/share/nginx/html` instead — behavior is identical, image is
smaller, and it drops the `apt-get` step's network dependency entirely.

## 2. Prerequisites (do once per AWS account/region)

```bash
export AWS_REGION=us-east-1              # adjust to your region
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export APP_NAME=ops-demo-react-frontend
```

Create the ECS task execution role if it doesn't already exist:

```bash
cat > ecs-tasks-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }
  ]
}
EOF

aws iam create-role --role-name ecsTaskExecutionRole \
  --assume-role-policy-document file://ecs-tasks-trust-policy.json

aws iam attach-role-policy --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

Create a cluster (skip if you already have one from UC-9's `tf-ecs-fargate-v1` work):

```bash
aws ecs create-cluster --cluster-name ops-master-demo --region $AWS_REGION
```

You'll also need a VPC subnet ID and a security group ID that allows inbound TCP 80 from
`0.0.0.0/0` — reuse whatever the team's existing sandbox VPC provides, or create a throwaway one:

```bash
aws ec2 create-security-group --group-name ops-demo-sg \
  --description "ops master demo - port 80" --vpc-id <VPC_ID> --region $AWS_REGION
aws ec2 authorize-security-group-ingress --group-id <SG_ID> \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $AWS_REGION
```

## 3. Clone, build, push to ECR

```bash
git clone https://github.com/mattburrell/vite-react-docker.git
cd vite-react-docker
git checkout 5d96169e8712659f60fc47f671cc54f6c4fe9d47

aws ecr create-repository --repository-name $APP_NAME --region $AWS_REGION

aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t $APP_NAME .
docker tag $APP_NAME:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
```

## 4. Register the Fargate task definition

```bash
aws logs create-log-group --log-group-name /ecs/$APP_NAME --region $AWS_REGION

cat > task-def.json << EOF
{
  "family": "$APP_NAME-task",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::$AWS_ACCOUNT_ID:role/ecsTaskExecutionRole",
  "containerDefinitions": [
    {
      "name": "$APP_NAME",
      "image": "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest",
      "portMappings": [{ "containerPort": 80, "protocol": "tcp" }],
      "essential": true,
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/$APP_NAME",
          "awslogs-region": "$AWS_REGION",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
EOF

aws ecs register-task-definition --cli-input-json file://task-def.json --region $AWS_REGION
```

## 5. Run it on Fargate and get the endpoint

Standalone task (fastest — no ALB needed for a demo):

```bash
aws ecs run-task \
  --cluster ops-master-demo \
  --launch-type FARGATE \
  --task-definition $APP_NAME-task \
  --count 1 \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_ID>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" \
  --region $AWS_REGION
```

```bash
TASK_ARN=$(aws ecs list-tasks --cluster ops-master-demo --region $AWS_REGION \
  --query 'taskArns[0]' --output text)

# wait ~30-60s for the task to reach RUNNING, then:
ENI_ID=$(aws ecs describe-tasks --cluster ops-master-demo --tasks $TASK_ARN --region $AWS_REGION \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)

PUBLIC_IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --region $AWS_REGION \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

echo "Endpoint: http://$PUBLIC_IP"
curl -I "http://$PUBLIC_IP"     # expect HTTP/1.1 200 OK

# Cost safety, automatic — no separate step to remember: as soon as the endpoint is live, arm the
# auto-teardown timer (default 15 min; pass -Minutes to schedule-ecs-auto-teardown.ps1 to change
# it). Runs from the same shell via powershell.exe, same "schedule right after apply" pattern UC-9
# uses for its Terraform path (schedule-auto-destroy.ps1). See section 6 to cancel it.
# -ExecutionPolicy Bypass scopes to just this one invocation (no system policy change) — needed on
# any machine with the default Restricted policy, confirmed live: without it this fails with
# "running scripts is disabled on this system" and the task is left running with no timer armed.
powershell.exe -ExecutionPolicy Bypass -File ./schedule-ecs-auto-teardown.ps1 \
  -ClusterName ops-master-demo -TaskArn "$TASK_ARN" -Region "$AWS_REGION" -RepositoryName "$APP_NAME"
```

## 6. Teardown (already scheduled automatically by step 5 above)

The `run-task` step above already armed a 15-minute auto-teardown — you don't need to do anything
else for cost safety. Two things you might still want to do manually:

**Tear down right now, instead of waiting for the timer:**

```bash
aws ecs stop-task --cluster ops-master-demo --task $TASK_ARN --region $AWS_REGION
aws ecr batch-delete-image --repository-name $APP_NAME --region $AWS_REGION \
  --image-ids imageTag=latest
```

**Keep the demo running longer than 15 minutes — cancel the timer first, then tear down manually
whenever you're actually done:**

```powershell
.\cancel-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN
# If script execution is disabled: powershell -ExecutionPolicy Bypass -File .\cancel-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN
```

Both scripts live in this same folder: [`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1) /
[`cancel-ecs-auto-teardown.ps1`](cancel-ecs-auto-teardown.ps1) — one script pair covers all three
demo apps in this folder, parameterized by cluster/task/repo. (`-Minutes 30`, etc. on the schedule
call in step 5 above changes the default delay for a longer demo.)

## 7. Wired into Ops Master Agent's `buildRegistry.ts`

Implemented — `apps/server/src/nodes/buildRegistry.ts` has a `"vite-react-frontend"` entry so the
agent itself can clone, build, and deploy this app (not just run it by hand via sections 2–6
above):

```ts
"vite-react-frontend": {
  key: "vite-react-frontend",
  displayName: "Vite/React static frontend demo (no DB)",
  repoUrl: "https://github.com/mattburrell/vite-react-docker.git",
  commitSha: "5d96169e8712659f60fc47f671cc54f6c4fe9d47",
  containerPort: 80,
  healthPath: "/",
  pairedWith: null,
  needsDatabase: false,
  dockerfileSubdir: null,
  dockerfileOverride: null, // repo's own two-stage Dockerfile is already correct as-is
},
```

`needsDatabase: false` + `pairedWith: null` routes this entry through `iac_generator.ts`'s new
"standalone" build-sentinel branch (added alongside this wiring): clone + checkout + `docker
build`, no host-side `npm ci`/`npm run build`/migrate steps — the repo's own two-stage Dockerfile
does the Vite build entirely inside the image. No `commandAllowList.ts` change was needed — its
git/build rules are generated from the registry table automatically, and the existing `docker
build` allow-list regex already accepts any `<name>-app:<hex>` tag (e.g.
`vite-react-frontend-app:5d96169`).

This unlocks selecting the app through the agent's normal **docker-compose** deploy path (e.g. via
`compose-single-v1` once a plan resolves to this build sentinel) — it does not by itself make this
an AWS/Terraform use case; the AWS CLI steps in sections 2–6 above remain a separate, manual path
for a real Fargate endpoint.
