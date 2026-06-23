import { DEFAULT_BRIDGE_URL, type BridgeStatus } from "./browser_actions.js";
import { chromePromise, errorMessage } from "./chrome_async.js";
import type { ActionHistoryEntry } from "./history.js";

type Settings = {
  bridge_url: string;
  auto_connect: boolean;
};

type RuntimeResponse = {
  ok?: boolean;
  error?: string;
  status?: BridgeStatus;
  history?: ActionHistoryEntry[];
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
const clearHistory = mustElement<HTMLButtonElement>("clear-history");
const historyCount = mustElement<HTMLElement>("history-count");
const historyList = mustElement<HTMLOListElement>("history-list");

let refreshTimer: number | undefined;
let savingTimer: number | undefined;
let connected = false;

primaryAction.addEventListener("click", () => {
  if (connected) void disconnect();
  else void connect();
});
secondaryAction.addEventListener("click", () => void refresh());
clearHistory.addEventListener("click", () => void clearActionHistory());
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
    if (response.history) renderHistory(response.history);
    return;
  }

  if (response.status) {
    setConnected(Boolean(response.status.connected));
    lastConnected.textContent = formatTime(response.status.last_connected_at);
    lastError.textContent = response.status.last_error || "none";
    connectionCopy.textContent = connected ? "Signed-in browser is available" : "Bridge is not connected";
  }
  if (response.history) renderHistory(response.history);
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

async function clearActionHistory(): Promise<void> {
  clearHistory.disabled = true;
  try {
    render(await runtimeMessage({ type: "clear_history" }));
  } finally {
    clearHistory.disabled = false;
  }
}

function renderHistory(history: ActionHistoryEntry[]): void {
  historyList.replaceChildren();
  historyCount.textContent = String(history.length);
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "No browser actions yet";
    historyList.append(empty);
    return;
  }
  history.slice(0, 20).forEach((entry) => historyList.append(historyItem(entry)));
}

function historyItem(entry: ActionHistoryEntry): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `history-item ${entry.result}`;

  const head = document.createElement("div");
  head.className = "history-head";

  const action = document.createElement("span");
  action.className = "history-action";
  action.textContent = entry.action;

  const time = document.createElement("time");
  time.dateTime = entry.at;
  time.textContent = formatClock(entry.at);

  const target = document.createElement("div");
  target.className = "history-target";
  target.textContent = entry.target || entry.session;

  const summary = document.createElement("div");
  summary.className = "history-summary";
  summary.textContent = entry.summary || entry.result;

  head.append(action, time);
  item.append(head, target, summary);
  return item;
}

function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
