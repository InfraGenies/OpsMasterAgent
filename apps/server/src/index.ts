import { createServer } from "node:http";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { env } from "./config.js";
import { HttpError } from "./orchestrator/errors.js";
import { rehydratePendingApprovals } from "./orchestrator/pipeline.js";
import { runsRouter } from "./routes/runs.js";
import { getStore } from "./store/index.js";
import { initWsHub } from "./ws/hub.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mockLlm: env.MOCK_LLM || !env.ANTHROPIC_API_KEY });
});

app.use("/api/runs", runsRouter);

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
