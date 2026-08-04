// tsc only emits compiled .js from src/**/*.ts — prompts/ and skills/ are
// runtime-loaded markdown (llm/promptLoader.ts, llm/skillLoader.ts) and need
// to land next to the compiled dist/config.js that resolves PROMPTS_DIR/
// SKILLS_DIR from. Cross-platform (fs.cpSync) since this also runs in the
// Docker build stage on Linux.
import { cpSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

for (const dir of ["prompts", "skills"]) {
  cpSync(path.join(root, "src", dir), path.join(root, "dist", dir), { recursive: true });
}
