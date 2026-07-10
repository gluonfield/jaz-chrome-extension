import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (import.meta.url === `file://${process.argv[1]}`) {
  await validate(join(root, "dist"));
  console.log("Extension build is valid.");
}

export async function validate(dir) {
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert(manifest.manifest_version === 3, "manifest_version must be 3");
  assert(manifest.name === "Jaz Browser Bridge", "unexpected extension name");
  assert(manifest.background?.service_worker, "background service worker is required");
  assert(!manifest.action?.default_popup, "extension action must open the side panel, not a popup");
  assert(manifest.side_panel?.default_path === "sidepanel.html", "side panel path is required");
  await validateIcons(dir, manifest);
  assert(Array.isArray(manifest.permissions), "permissions must be an array");
  ["alarms", "storage", "tabs", "scripting", "webNavigation", "sidePanel"].forEach((permission) => {
    assert(manifest.permissions.includes(permission), `missing ${permission} permission`);
  });
  const [contentScript] = manifest.content_scripts || [];
  assert(contentScript?.all_frames === true, "content script must run in all frames");
  assert(contentScript?.match_about_blank === true, "content script must match about:blank frames");
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    "browser-extension-contract.json",
    "browser_actions.js",
    "chrome_async.js",
    "sidepanel.css",
    "sidepanel.js",
    "content.js"
  ];
  for (const file of files) await mustExist(join(dir, file));
  for (const file of ["background.js", "browser_actions.js", "chrome_async.js", "content.js", "sidepanel.js"]) nodeCheck(join(dir, file));
  await validateAutoConnectContract(dir);
  await validateContract(dir);
}

async function mustExist(path) {
  await access(path, constants.R_OK);
}

function nodeCheck(path) {
  const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${path} failed syntax check:\n${result.stderr || result.stdout}`);
  }
}

async function validateIcons(dir, manifest) {
  for (const size of [16, 32, 48, 128]) {
    const path = `icons/icon${size}.png`;
    assert(manifest.icons?.[size] === path, `missing ${size}px manifest icon`);
    assert(manifest.action?.default_icon?.[size] === path, `missing ${size}px action icon`);
    const png = await readFile(join(dir, path));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    assert(width === size && height === size, `${path} must be ${size}x${size}`);
  }
}

async function validateContract(dir) {
  const contract = JSON.parse(await readFile(join(dir, "browser-extension-contract.json"), "utf8"));
  const actions = await import(pathToFileURL(join(dir, "browser_actions.js")).href);
  assert(contract.protocol === actions.PROTOCOL, "contract protocol must match extension protocol");
  assert(new URL(actions.DEFAULT_BRIDGE_URL).pathname === contract.bridge_path, "contract bridge path must match default bridge URL");
  assert(JSON.stringify(contract.actions) === JSON.stringify(actions.ACTIONS), "contract actions must match extension actions");
}

async function validateAutoConnectContract(dir) {
  const source = await readFile(join(dir, "background.js"), "utf8");
  assert(source.includes("chrome.alarms.onAlarm"), "auto-connect must wake from a Chrome alarm");
  assert(source.includes("chrome.alarms.create"), "auto-connect alarm must be scheduled");
  assert(source.includes("WebSocket.CONNECTING"), "auto-connect must not reset an in-flight connection");
  assert(source.includes("HEARTBEAT_INTERVAL_MS"), "auto-connect must keep the MV3 worker awake while connected");
  assert(source.includes("setInterval") && source.includes("\"heartbeat\""), "auto-connect must send a socket heartbeat");
}

function assert(value, message) {
  if (!value) throw new Error(message);
}
