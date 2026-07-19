# Installation & Environment Setup (Windows) — Ops Master Agent

Owner: Anshul + Aparna · File the Docker Desktop IS request on **Day 1** — it is the long pole.

---

## 0. IS / Admin requests to file first (single consolidated ticket)

| # | Request | Why | Priority |
|---|---|---|---|
| 1 | **Docker Desktop + WSL2 enablement** (local admin on Windows) | All deployments run in containers | 🔴 Day 1 |
| 2 | Firewall: `registry.npmjs.org` (npm) | React UI deps | 🔴 Day 1 |
| 3 | Firewall: `pypi.org`, `files.pythonhosted.org` (pip) | LangGraph/FastAPI | 🔴 Day 1 |
| 4 | Firewall: `docker.io` / `registry-1.docker.io` / `ghcr.io` (image pulls incl. `localstack/localstack`, `grafana/k6`, `postgres`, `redis`, `node`) | Base images | 🔴 Day 1 |
| 5 | Outbound HTTPS to approved LLM API (Anthropic `api.anthropic.com` or Azure OpenAI endpoint) + API key provisioning | Agent brains | 🔴 Day 1 |
| 6 | `github.com` clone access (public repos only) | Demo apps | 🟡 |
| 7 | Terraform CLI install (`releases.hashicorp.com`) | IaC path (optional if compose-only) | 🟡 |
| 8 | Minikube + kubectl | UC-6 stretch only | 🟢 later |

**State explicitly in the ticket:** no production/customer data, synthetic test data only, everything runs locally in sandboxed containers, nothing exposed to the internet, no real cloud account (LocalStack emulates AWS locally). This framing speeds approval.

**Fallback if npm registry is blocked:** `npm install --registry https://registry.npmmirror.com` (add mirror to the firewall request as plan B).

**Fallback if LocalStack is blocked:** use plain docker-compose as the deploy target — same demo story, drop the AWS flavour.

---

## 1. Core runtimes

```powershell
# Verify after install
python --version      # need 3.11+
node --version        # need 18 LTS+
npm --version
git --version
docker --version
docker compose version
```

- **Python 3.11+** — https://www.python.org/downloads/ → check "Add to PATH"
- **Node.js 18 LTS** — https://nodejs.org/
- **Git for Windows** — https://git-scm.com/
- **Docker Desktop** — https://www.docker.com/products/docker-desktop/ → Settings → General → "Use WSL 2 based engine" ✔

If behind a corporate proxy, configure once:

```powershell
npm config set registry https://registry.npmjs.org
# only if IS blocks npmjs:
# npm config set registry https://registry.npmmirror.com
git config --global http.proxy http://<proxy>:<port>   # if applicable
```

---

## 2. Python environment (agent backend)

```powershell
cd ops-master-agent
python -m venv .venv
.venv\Scripts\activate

pip install --upgrade pip
pip install fastapi "uvicorn[standard]" langgraph langchain langchain-anthropic ^
    pydantic httpx python-dotenv sqlalchemy aiosqlite websockets
# If using Azure OpenAI instead: pip install langchain-openai
```

`requirements.txt` (freeze on Day 2):

```
fastapi
uvicorn[standard]
langgraph
langchain
langchain-anthropic
pydantic>=2
httpx
python-dotenv
sqlalchemy
aiosqlite
websockets
```

`.env` (never commit):

```
ANTHROPIC_API_KEY=sk-ant-...        # or AZURE_OPENAI_* vars
DEPLOY_TARGET=compose               # compose | localstack | minikube
AUDIT_DB=sqlite:///./audit.db
```

---

## 3. Frontend (React chat + pipeline view)

```powershell
npm create vite@latest ui -- --template react
cd ui
npm install
npm install tailwindcss @tailwindcss/vite lucide-react
npm run dev
```

---

## 4. Deploy & verify toolchain

```powershell
# Terraform (optional — compose path needs nothing extra)
winget install HashiCorp.Terraform
terraform -version

# LocalStack (runs inside Docker — no AWS account)
docker pull localstack/localstack
docker run -d -p 4566:4566 --name localstack localstack/localstack
curl http://localhost:4566/_localstack/health

# k6 load testing
winget install Grafana.k6        # or: docker pull grafana/k6 (run containerised, no install)
k6 version

# Minikube (UC-6 stretch only)
winget install Kubernetes.minikube Kubernetes.kubectl
```

**Tip:** run k6 as a container (`docker run --rm -i --network host grafana/k6 run - < smoke.js`) — one less Windows install to get approved.

---

## 5. Pre-pull demo images (do this the night before demo — removes network from the live path)

```powershell
docker pull node:18-alpine
docker pull postgres:16-alpine
docker pull redis:7-alpine
docker pull nginx:alpine
docker pull mysql:8
docker pull grafana/k6
```

Clone demo repos ahead of time too:

```powershell
git clone https://github.com/gothinkster/node-express-realworld-example-app
git clone https://github.com/docker/getting-started-app
git clone https://github.com/dockersamples/example-voting-app
git clone https://github.com/docker/awesome-compose        # use nginx-nodejs-redis/
git clone https://github.com/spring-projects/spring-petclinic          # UC-5 only
git clone https://github.com/GoogleCloudPlatform/microservices-demo    # UC-6 only
```

---

## 6. Verification checklist (run before Day 3)

- [ ] `docker run hello-world` succeeds without admin prompt
- [ ] `pip install fastapi` succeeds from corporate network
- [ ] `npm install react` succeeds (or mirror fallback works)
- [ ] LLM API call returns a response from a 5-line Python script
- [ ] `docker compose up` on `getting-started-app` serves http://localhost:3000
- [ ] k6 runs a 10-second script against it
- [ ] `sqlite3` (bundled with Python) — audit DB needs **no separate install**
