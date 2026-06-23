import { cp, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "./validate.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");
const dist = join(root, "dist");
const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
run(tsc, ["-p", join(root, "tsconfig.json")]);
await copyStatic();
await validate(dist);
console.log(`Built ${dist}`);

async function copyStatic() {
  await Promise.all([
    cp(join(src, "manifest.json"), join(dist, "manifest.json")),
    cp(join(src, "sidepanel.html"), join(dist, "sidepanel.html")),
    cp(join(src, "sidepanel.css"), join(dist, "sidepanel.css")),
    cp(join(src, "browser-extension-contract.json"), join(dist, "browser-extension-contract.json")),
    cp(join(src, "icons"), join(dist, "icons"), { recursive: true })
  ]);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
