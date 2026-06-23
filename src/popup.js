const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:5299/v1/browser/extension";

const bridgeURL = document.getElementById("bridge-url");
const autoConnect = document.getElementById("auto-connect");
const state = document.getElementById("state");
const details = document.getElementById("details");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
let refreshTimer;

connectButton.addEventListener("click", () => connect());
disconnectButton.addEventListener("click", () => disconnect());
autoConnect.addEventListener("change", () => saveSettings());
bridgeURL.addEventListener("change", () => saveSettings());

init();

async function init() {
  const settings = await storageGet({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true });
  bridgeURL.value = settings.bridge_url;
  autoConnect.checked = settings.auto_connect;
  await refresh();
  refreshTimer = setInterval(refresh, 1500);
}

async function connect() {
  await saveSettings();
  const response = await runtimeMessage({ type: "connect", bridge_url: bridgeURL.value });
  render(response);
}

async function disconnect() {
  const response = await runtimeMessage({ type: "disconnect" });
  render(response);
}

async function saveSettings() {
  const response = await runtimeMessage({
    type: "save_settings",
    bridge_url: bridgeURL.value,
    auto_connect: autoConnect.checked
  });
  if (response?.ok) bridgeURLDirty = false;
  return response;
}

async function refresh() {
  const response = await runtimeMessage({ type: "status" });
  render(response);
}

function render(response) {
  if (!response?.ok && response?.error) {
    state.textContent = "Error";
    state.classList.toggle("connected", false);
    state.classList.toggle("disconnected", true);
    details.textContent = response.error;
    return;
  }
  const payload = response && response.status ? response.status : {};
  const connected = Boolean(payload.connected);
  state.textContent = connected ? "Connected" : "Disconnected";
  state.classList.toggle("connected", connected);
  state.classList.toggle("disconnected", !connected);
  details.textContent = [
    `Bridge: ${payload.bridge_url || bridgeURL.value}`,
    `Connected: ${connected ? "yes" : "no"}`,
    payload.last_connected_at ? `Last connected: ${payload.last_connected_at}` : "",
    payload.last_error ? `Last error: ${payload.last_error}` : ""
  ].filter(Boolean).join("\n");
}

function storageGet(defaults) {
  return new Promise((resolve) => chrome.storage.local.get(defaults, resolve));
}

function runtimeMessage(message) {
  return new Promise((resolve) => chrome.runtime.sendMessage(message, resolve));
}

window.addEventListener("unload", () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
