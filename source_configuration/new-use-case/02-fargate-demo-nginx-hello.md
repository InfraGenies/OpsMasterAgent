# Fargate Demo App 2 — nginx App with a Live Endpoint

Catalogued as **UC-16** in [`agent-md-files/USE_CASES.md`](../../agent-md-files/USE_CASES.md). Cost-safety
auto-teardown for the manual AWS CLI path below: [`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1)
(same folder) — see section 7.

| Field | Value |
|---|---|
| Repo | https://github.com/nginxinc/NGINX-Demos (subfolder: `nginx-hello`) |
| Maintainer | NGINX Inc. |
| License | **None found in the repo** — no `LICENSE` file at the root or in the `nginx-hello` folder. Low-risk since nothing is redistributed (you're just building the image yourself for an internal demo), but flag to whoever owns IP review before this goes anywhere near a shipped artifact. |
| Pinned commit | `611fa05748a4031841e5607cd3069288b0aa9973` |
| Build needed | **No** — Dockerfile just copies two static files onto `nginx:mainline-alpine` |
| Base image risk | Docker Hub (`nginx:mainline-alpine`) |
| Container port | 80 |
| Health path | `/` |
| Database / env vars | None |

Verified by cloning the repo directly.

## 1. What it is

```dockerfile
FROM nginx:mainline-alpine
RUN rm /etc/nginx/conf.d/*
ADD hello.conf /etc/nginx/conf.d/
ADD index.html /usr/share/nginx/html/
```

`hello.conf` uses nginx's `sub_filter` to inject live values into the page on every request:

```nginx
server {
    listen 80;
    listen [::]:80;

    root /usr/share/nginx/html;
    try_files /index.html =404;

    expires -1;

    sub_filter_once off;
    sub_filter 'server_hostname' '$hostname';
    sub_filter 'server_address' '$server_addr:$server_port';
    sub_filter 'server_url' '$request_uri';
    sub_filter 'server_date' '$time_local';
    sub_filter 'request_id' '$request_id';
}
```

The page shows the container's actual hostname, address, request URI, timestamp, and a per-request
ID — useful during the judge demo as visible proof the endpoint is a live container and not a
cached screenshot.

## 2. Fastest path: skip the clone entirely

Because there's no build step, you don't need to clone or build anything — you can push the
already-published Docker Hub image straight into ECR (avoids depending on Docker Hub at demo time,
and avoids needing `docker build` at all):

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export APP_NAME=ops-demo-nginx-hello

aws ecr create-repository --repository-name $APP_NAME --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker pull nginxdemos/hello:latest
docker tag nginxdemos/hello:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
```

Skip to **Section 4** if you use this path.

## 3. Alternative: build from the pinned source commit

Use this if you want full reproducibility tied to a specific commit rather than trusting whatever
`nginxdemos/hello:latest` currently points to on Docker Hub:

```bash
git clone https://github.com/nginxinc/NGINX-Demos.git
cd NGINX-Demos
git checkout 611fa05748a4031841e5607cd3069288b0aa9973
cd nginx-hello

aws ecr create-repository --repository-name $APP_NAME --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t $APP_NAME .
docker tag $APP_NAME:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
```

## 4. Prerequisites (skip if already done for another demo app)

```bash
# Execution role
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

# Cluster
aws ecs create-cluster --cluster-name ops-master-demo --region $AWS_REGION

# Security group allowing inbound 80
aws ec2 create-security-group --group-name ops-demo-sg \
  --description "ops master demo - port 80" --vpc-id <VPC_ID> --region $AWS_REGION
aws ec2 authorize-security-group-ingress --group-id <SG_ID> \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $AWS_REGION
```

## 5. Register task definition

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

## 6. Run and get the endpoint

```bash
aws ecs run-task \
  --cluster ops-master-demo \
  --launch-type FARGATE \
  --task-definition $APP_NAME-task \
  --count 1 \
  --network-configuration "awsvpcConfiguration={subnets=[<SUBNET_ID>],securityGroups=[<SG_ID>],assignPublicIp=ENABLED}" \
  --region $AWS_REGION

TASK_ARN=$(aws ecs list-tasks --cluster ops-master-demo --region $AWS_REGION \
  --query 'taskArns[0]' --output text)

# wait ~30-60s for RUNNING, then:
ENI_ID=$(aws ecs describe-tasks --cluster ops-master-demo --tasks $TASK_ARN --region $AWS_REGION \
  --query "tasks[0].attachments[0].details[?name=='networkInterfaceId'].value" --output text)

PUBLIC_IP=$(aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID --region $AWS_REGION \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text)

echo "Endpoint: http://$PUBLIC_IP"
curl "http://$PUBLIC_IP"     # response body will show live hostname/IP/request-id — good demo moment

# Cost safety, automatic — no separate step to remember: as soon as the endpoint is live, arm the
# auto-teardown timer (default 15 min; pass -Minutes to schedule-ecs-auto-teardown.ps1 to change
# it). Runs from the same shell via powershell.exe, same "schedule right after apply" pattern UC-9
# uses for its Terraform path (schedule-auto-destroy.ps1). See section 7 to cancel it.
# -ExecutionPolicy Bypass scopes to just this one invocation (no system policy change) — needed on
# any machine with the default Restricted policy, confirmed live: without it this fails with
# "running scripts is disabled on this system" and the task is left running with no timer armed.
powershell.exe -ExecutionPolicy Bypass -File ./schedule-ecs-auto-teardown.ps1 \
  -ClusterName ops-master-demo -TaskArn "$TASK_ARN" -Region "$AWS_REGION" -RepositoryName "$APP_NAME"
```

## 7. Teardown (already scheduled automatically by step 6 above)

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
```

Both scripts live in this same folder: [`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1) /
[`cancel-ecs-auto-teardown.ps1`](cancel-ecs-auto-teardown.ps1) — one script pair covers all three
demo apps in this folder, parameterized by cluster/task/repo. (`-Minutes 30`, etc. on the schedule
call in step 6 above changes the default delay for a longer demo.)

## 8. Wired into Ops Master Agent's `buildRegistry.ts`

Implemented — `apps/server/src/nodes/buildRegistry.ts` has an `"nginx-hello"` entry:

```ts
"nginx-hello": {
  key: "nginx-hello",
  displayName: "nginx hello-world demo (live hostname/IP page)",
  repoUrl: "https://github.com/nginxinc/NGINX-Demos.git",
  commitSha: "611fa05748a4031841e5607cd3069288b0aa9973",
  containerPort: 80,
  healthPath: "/",
  pairedWith: null,
  needsDatabase: false,
  // This repo's Dockerfile lives in the nginx-hello/ subfolder, not the repo root — see the next
  // paragraph for how the pipeline now handles that.
  dockerfileSubdir: "nginx-hello",
  dockerfileOverride: null, // repo's own Dockerfile is already correct as-is
},
```

**The subfolder problem this doc originally flagged is resolved:** every other `BUILD_REGISTRY`
entry has its Dockerfile at the repo root, but this one's is at `nginx-hello/Dockerfile` inside
the cloned `NGINX-Demos` monorepo. Rather than special-casing `nodes/build.ts`'s clone step, a new
`dockerfileSubdir` field on `BuildRegistryEntry` lets `iac_generator.ts` point the generated
`docker build` step's `cwd` at `repo-nginx-hello/nginx-hello` instead of `repo-nginx-hello` — the
clone/checkout steps still target the full repo unchanged. `nodes/build.ts`'s `isKnownCwd()` was
updated to accept exactly that one derived subpath (never an arbitrary nested path — still 100%
closed-table-driven). No `commandAllowList.ts` change was needed: the `docker build` allow-list
regex only constrains the image tag, not the working directory the command runs in.

This unlocks selecting the app through the agent's normal **docker-compose** deploy path — it does
not by itself make this an AWS/Terraform use case; the AWS CLI steps in sections 2–7 above remain
a separate, manual path for a real Fargate endpoint.
