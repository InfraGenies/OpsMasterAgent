# Fargate Demo App 3 — AWS Official Sample (recommended lead demo)

Catalogued as **UC-14** in [`agent-md-files/USE_CASES.md`](../../agent-md-files/USE_CASES.md). Cost-safety
auto-teardown for the manual AWS CLI path below (Option B): [`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1)
(same folder) — see the Teardown subsection of section 3.

| Field | Value |
|---|---|
| Repo | https://github.com/aws-samples/aws-copilot-sample-service |
| Maintainer | **AWS official** (`aws-samples` org) |
| License | MIT-0 |
| Pinned commit | `2f5a45e5561f0d99e4328eac02d93358d2489d63` |
| Build needed | **No** — Dockerfile just copies one static `index.html` |
| Base image risk | **Public ECR** (`public.ecr.aws/nginx/nginx:1.19`) — no Docker Hub anonymous-pull rate-limit risk on demo day |
| Container port | 80 |
| Health path | `/` |
| Database / env vars | None |

Verified by cloning the repo directly — only 3 real files exist (`Dockerfile`, `index.html`,
`README.md`), nothing else to account for.

## 1. What it is

```dockerfile
FROM public.ecr.aws/nginx/nginx:1.19
EXPOSE 80
COPY index.html /usr/share/nginx/html
```

This is AWS's own reference app for demonstrating a "Load Balanced Web Service" (their name for
an ECS Fargate service behind an ALB) via the AWS Copilot CLI. It's the smallest of the three
demo repos and the only one pulling from `public.ecr.aws` instead of Docker Hub, which removes
one class of demo-day flakiness. **Recommended as the lead/flagship demo app for the AWS
deployment portion of the pitch.**

## 2. Option A — AWS Copilot CLI (fastest path, fully automated)

If the Copilot CLI is installed (`brew install aws/tap/copilot-cli` or see AWS's install docs),
this is the single fastest way to get a real, publicly reachable Fargate endpoint — Copilot
provisions the VPC, subnets, security groups, ALB, ECR repo, ECS cluster, and Fargate service for
you:

```bash
git clone https://github.com/aws-samples/aws-copilot-sample-service.git
cd aws-copilot-sample-service
git checkout 2f5a45e5561f0d99e4328eac02d93358d2489d63

copilot init --app demo \
  --name api \
  --type "Load Balanced Web Service" \
  --dockerfile "./Dockerfile" \
  --deploy
```

Copilot prints the public ALB endpoint URL when it finishes — that's your demo endpoint, live and
already fronted by a load balancer (closer to how a real production deploy would look than the
raw-task approach below).

**Teardown:**

```bash
copilot app delete
```

Use this option if the demo needs to look "production-grade" (real ALB, real target group) with
minimal manual AWS CLI work.

## 3. Option B — Manual AWS CLI (matches how UC-9's `tf-ecs-fargate-v1` template works)

Use this path if you want the exact same manual control the agent's existing Terraform template
gives you, or if Copilot CLI isn't available on the demo machine.

### Prerequisites

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export APP_NAME=ops-demo-copilot-sample
```

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

aws ecs create-cluster --cluster-name ops-master-demo --region $AWS_REGION

aws ec2 create-security-group --group-name ops-demo-sg \
  --description "ops master demo - port 80" --vpc-id <VPC_ID> --region $AWS_REGION
aws ec2 authorize-security-group-ingress --group-id <SG_ID> \
  --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $AWS_REGION
```

### Build and push to ECR

```bash
git clone https://github.com/aws-samples/aws-copilot-sample-service.git
cd aws-copilot-sample-service
git checkout 2f5a45e5561f0d99e4328eac02d93358d2489d63

aws ecr create-repository --repository-name $APP_NAME --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker build -t $APP_NAME .
docker tag $APP_NAME:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP_NAME:latest
```

### Register task definition

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

### Run and get the endpoint

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
curl -I "http://$PUBLIC_IP"     # expect HTTP/1.1 200 OK
```

### Teardown

```bash
aws ecs stop-task --cluster ops-master-demo --task $TASK_ARN --region $AWS_REGION
aws ecr batch-delete-image --repository-name $APP_NAME --region $AWS_REGION \
  --image-ids imageTag=latest
```

**Cost-safety timer (recommended):** same auto-teardown-after-N-minutes pattern as UC-9's
`schedule-auto-destroy.ps1` for its Terraform path, applied to this app's `aws ecs run-task`
workflow (Option B only — Option A's `copilot app delete` is already a single manual step with
nothing to schedule):

```powershell
.\schedule-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN `
  -Region $AWS_REGION -RepositoryName $APP_NAME
# If script execution is disabled ("running scripts is disabled on this system", confirmed live on
# a default-Restricted-policy machine): powershell -ExecutionPolicy Bypass -File .\schedule-ecs-auto-teardown.ps1 ...
```

Defaults to 15 minutes (`-Minutes` to change it); cancel with
`.\cancel-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN`. Same shared
script as the other two demo apps in this folder:
[`schedule-ecs-auto-teardown.ps1`](schedule-ecs-auto-teardown.ps1) /
[`cancel-ecs-auto-teardown.ps1`](cancel-ecs-auto-teardown.ps1).

## 4. Wired into Ops Master Agent's `buildRegistry.ts`

Implemented — `apps/server/src/nodes/buildRegistry.ts` has an `"aws-copilot-sample"` entry:

```ts
"aws-copilot-sample": {
  key: "aws-copilot-sample",
  displayName: "AWS official Copilot sample service (static nginx page)",
  repoUrl: "https://github.com/aws-samples/aws-copilot-sample-service.git",
  commitSha: "2f5a45e5561f0d99e4328eac02d93358d2489d63",
  containerPort: 80,
  healthPath: "/",
  pairedWith: null,
  needsDatabase: false,
  dockerfileSubdir: null,
  dockerfileOverride: null, // repo's own Dockerfile is already correct as-is
},
```

`needsDatabase: false` + `pairedWith: null` routes this through `iac_generator.ts`'s standalone
build-sentinel branch: clone + checkout + `docker build`, nothing else. No `commandAllowList.ts`
change was needed — its rules are generated from this table. Note this repo pulls its base image
from `public.ecr.aws`, not Docker Hub, so if the pipeline's `docker build` step ever runs somewhere
with restricted egress, confirm `public.ecr.aws` is reachable alongside whatever Docker Hub access
is already configured.

This unlocks selecting the app through the agent's normal **docker-compose** deploy path — it does
not by itself make this an AWS/Terraform use case; the Copilot CLI / manual AWS CLI steps above
remain the path to an actual Fargate + ALB endpoint (see `USE_CASES.md` UC-14's status note for
what a real Terraform-driven path through the pipeline would still need).

## 5. Why this is the recommended lead demo

Of the three apps, this is the only one that is (a) AWS-maintained, (b) MIT-0 licensed with zero
ambiguity, (c) requires no build-tool dependency beyond Docker itself, and (d) avoids Docker Hub
entirely. If judges ask "why this base image," the honest answer — "it's AWS's own sample app for
exactly this scenario, pulling from AWS's own public registry" — is a stronger answer than for
either of the other two.
