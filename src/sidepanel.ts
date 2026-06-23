import { DEFAULT_BRIDGE_URL, type BridgeStatus } from "./browser_actions.js";
import { chromePromise, errorMessage } from "./chrome_async.js";

type Settings = {
  bridge_url: string;
  auto_connect: boolean;
};

type RuntimeResponse = {
  ok?: boolean;
  error?: string;
  status?: BridgeStatus;
};

const bridgeURL = mustElement<HTMLTextAreaElement>("bridge-url");
const autoConnect = mustElement<HTMLInputElement>("auto-connect");
const state = mustElement<HTMLElement>("state");
const connectionCopy = mustElement<HTMLElement>("connection-copy");
const lastConnected = mustElement<HTMLElement>("last-connected");
const lastError = mustElement<HTMLElement>("last-error");
const primaryAction = mustElement<HTMLButtonElement>("primary-action");
const secondaryAction = mustElement<HTMLButtonElement>("secondary-action");
const resetEndpoint = mustElement<HTMLButtonElement>("reset-endpoint");

let refreshTimer: number | undefined;
let savingTimer: number | undefined;
let connected = false;

primaryAction.addEventListener("click", () => {
  if (connected) void disconnect();
  else void connect();
});
secondaryAction.addEventListener("click", () => void refresh());
resetEndpoint.addEventListener("click", () => {
  bridgeURL.value = DEFAULT_BRIDGE_URL;
  void saveSettingsNow();
});
autoConnect.addEventListener("change", () => void saveSettingsNow());
bridgeURL.addEventListener("input", scheduleSettingsSave);

void init();

async function init(): Promise<void> {
  const settings = await storageGet({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true });
  bridgeURL.value = settings.bridge_url || DEFAULT_BRIDGE_URL;
  autoConnect.checked = settings.auto_connect;
  await refresh();
  refreshTimer = window.setInterval(refresh, 1500);
}

async function connect(): Promise<void> {
  primaryAction.disabled = true;
  try {
    await saveSettingsNow();
    render(await runtimeMessage({ type: "connect", bridge_url: bridgeURL.value }));
  } finally {
    primaryAction.disabled = false;
  }
}

async function disconnect(): Promise<void> {
  primaryAction.disabled = true;
  try {
    render(await runtimeMessage({ type: "disconnect" }));
  } finally {
    primaryAction.disabled = false;
  }
}

function scheduleSettingsSave(): void {
  window.clearTimeout(savingTimer);
  savingTimer = window.setTimeout(() => void saveSettingsNow(), 250);
}

async function saveSettingsNow(): Promise<RuntimeResponse> {
  window.clearTimeout(savingTimer);
  return runtimeMessage({
    type: "save_settings",
    bridge_url: bridgeURL.value,
    auto_connect: autoConnect.checked
  });
}

async function refresh(): Promise<void> {
  render(await runtimeMessage({ type: "status" }));
}

function render(response: RuntimeResponse): void {
  if (!response.ok && response.error) {
    setConnected(false);
    lastError.textContent = response.error;
    connectionCopy.textContent = "Extension bridge error";
    return;
  }

  const status = response.status ?? { connected: false };
  setConnected(Boolean(status.connected));
  lastConnected.textContent = formatTime(status.last_connected_at);
  lastError.textContent = status.last_error || "none";
  connectionCopy.textContent = connected ? "Signed-in browser is available" : "Bridge is not connected";
}

function setConnected(next: boolean): void {
  connected = next;
  state.textContent = connected ? "Connected" : "Disconnected";
  state.classList.toggle("connected", connected);
  state.classList.toggle("disconnected", !connected);
  primaryAction.textContent = connected ? "Disconnect" : "Connect";
  primaryAction.classList.toggle("disconnect", connected);
}

function formatTime(value?: string): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

function storageGet(defaults: Settings): Promise<Settings> {
  return chromePromise(chrome.storage.local.get, defaults) as Promise<Settings>;
}

function runtimeMessage(message: Record<string, unknown>): Promise<RuntimeResponse> {
  return chromePromise(chrome.runtime.sendMessage, message)
    .then((response) => (response ?? { ok: false, error: "empty extension response" }) as RuntimeResponse)
    .catch((error: unknown) => ({ ok: false, error: errorMessage(error) }));
}

window.addEventListener("unload", () => {
  window.clearInterval(refreshTimer);
  window.clearTimeout(savingTimer);
});
