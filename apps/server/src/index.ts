import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { env } from "./config.js";
import { activeProviderName, isMockMode } from "./llm/client.js";
import { HttpError } from "./orchestrator/errors.js";
import { rehydratePendingApprovals } from "./orchestrator/pipeline.js";
import { runsRouter } from "./routes/runs.js";
import { getStore } from "./store/index.js";
import { initWsHub } from "./ws/hub.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mockLlm: isMockMode(), llmProvider: activeProviderName() });
});

app.use("/api/runs", runsRouter);

// apps/web/dist only exists in the production container image (built by the
// root Dockerfile) — a no-op in local dev, where vite serves the UI on :5173.
const webDist = path.resolve(env.SERVER_ROOT, "..", "web", "dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
});

const server = createServer(app);
initWsHub(server);

getStore(); // resolves + logs which store backend is active

server.listen(env.PORT, async () => {
  console.log(`[server] listening on http://localhost:${env.PORT}`);
  await rehydratePendingApprovals();
});
