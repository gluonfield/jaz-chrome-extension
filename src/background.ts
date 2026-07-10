import { ACTIONS, DEFAULT_BRIDGE_URL, PROTOCOL, callBrowser, type BridgeStatus } from "./browser_actions.js";
import { chromePromise, errorMessage } from "./chrome_async.js";
import { ACTION_HISTORY_KEY, ACTION_HISTORY_LIMIT, type ActionHistoryEntry } from "./history.js";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const AUTO_CONNECT_ALARM = "jaz.auto_connect";
const AUTO_CONNECT_PERIOD_MINUTES = 1;
const HEARTBEAT_INTERVAL_MS = 20000;

type ExtensionSettings = {
  bridge_url: string;
  auto_connect: boolean;
};

type RuntimeMessage = {
  type?: string;
  bridge_url?: unknown;
  auto_connect?: unknown;
};

type BridgeCall = {
  id: string;
  type: "call";
  action?: string;
  session?: string;
  tab_id?: number;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  amount?: number;
};

type BridgeMessage = Record<string, unknown>;

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let reconnectAttempt = 0;
let manualDisconnect = false;
let status: BridgeStatus = {
  connected: false,
  bridge_url: DEFAULT_BRIDGE_URL,
  last_error: "",
  last_connected_at: ""
};

chrome.runtime.onInstalled.addListener(() => {
  void setSidePanelBehavior();
  void ensureStoredSettingsAndAutoConnect().catch(recordError);
});

chrome.runtime.onStartup.addListener(() => {
  void setSidePanelBehavior();
  void startAutoConnectFromStorage().catch(recordError);
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_CONNECT_ALARM) void startAutoConnectFromStorage().catch(recordError);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  handleRuntimeMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: errorMessage(error) });
  });
  return true;
});

void setSidePanelBehavior();

void startAutoConnectFromStorage().catch(recordError);

async function setSidePanelBehavior(): Promise<void> {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<Record<string, unknown>> {
  if (!message || typeof message !== "object") return { ok: false, error: "invalid message" };
  switch (message.type) {
    case "status":
      return { ok: true, status, history: await actionHistory() };
    case "history":
      return { ok: true, history: await actionHistory() };
    case "clear_history":
      await storageSet({ [ACTION_HISTORY_KEY]: [] });
      return { ok: true, history: [] };
    case "connect":
      manualDisconnect = false;
      await connect(String(message.bridge_url || DEFAULT_BRIDGE_URL));
      return { ok: true, status };
    case "disconnect":
      manualDisconnect = true;
      disconnect("manual disconnect");
      return { ok: true, status };
    case "save_settings":
      const bridgeURL = savedBridgeURL(message.bridge_url);
      const settings = {
        bridge_url: bridgeURL,
        auto_connect: Boolean(message.auto_connect)
      };
      await storageSet(settings);
      if (settings.auto_connect) manualDisconnect = false;
      syncAutoConnectAlarm(settings.auto_connect);
      status.bridge_url = bridgeURL;
      return { ok: true, status };
    default:
      return { ok: false, error: `unknown message type ${message.type}` };
  }
}

async function connect(rawURL: unknown): Promise<void> {
  const bridgeURL = normalizeBridgeURL(rawURL);
  status.bridge_url = bridgeURL;
  if (socket && socket.url === bridgeURL && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  disconnect("reconnect");
  manualDisconnect = false;
  socket = new WebSocket(bridgeURL);
  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    status = {
      connected: true,
      bridge_url: bridgeURL,
      last_error: "",
      last_connected_at: new Date().toISOString()
    };
    send({
      type: "hello",
      protocol: PROTOCOL,
      extension_id: chrome.runtime.id,
      bridge_url: bridgeURL,
      user_agent: navigator.userAgent,
      capabilities: { actions: ACTIONS }
    });
    startHeartbeat();
  });
  socket.addEventListener("message", (event) => {
    handleBridgeMessage(event.data).catch((error) => {
      send({ type: "error", ok: false, error: errorMessage(error) });
    });
  });
  socket.addEventListener("close", (event) => {
    stopHeartbeat();
    status.connected = false;
    if (!manualDisconnect && event.reason !== "reconnect") {
      status.last_error = event.reason || `bridge disconnected (${event.code})`;
      scheduleReconnect();
    }
  });
  socket.addEventListener("error", () => {
    status.connected = false;
    status.last_error = "bridge connection failed";
  });
}

function disconnect(reason: string): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  stopHeartbeat();
  if (socket) {
    try {
      socket.close(1000, reason);
    } catch {
      // Ignore close races from MV3 service worker wakeups.
    }
  }
  socket = undefined;
  status.connected = false;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = self.setInterval(() => {
    send({ type: "heartbeat" });
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 4));
  reconnectTimer = self.setTimeout(() => {
    void startAutoConnectFromStorage().catch(recordError);
  }, delay);
}

async function ensureStoredSettingsAndAutoConnect(): Promise<void> {
  const items = await storageGet(defaultSettings());
  await storageSet({ bridge_url: items.bridge_url, auto_connect: items.auto_connect });
  await startAutoConnect(items);
}

async function startAutoConnectFromStorage(): Promise<void> {
  await startAutoConnect(await storageGet(defaultSettings()));
}

async function startAutoConnect(settings: ExtensionSettings): Promise<void> {
  status.bridge_url = settings.bridge_url;
  syncAutoConnectAlarm(settings.auto_connect);
  if (settings.auto_connect && !manualDisconnect) await connect(settings.bridge_url);
}

function syncAutoConnectAlarm(enabled: boolean): void {
  if (enabled) {
    chrome.alarms.create(AUTO_CONNECT_ALARM, { periodInMinutes: AUTO_CONNECT_PERIOD_MINUTES });
  } else {
    chrome.alarms.clear(AUTO_CONNECT_ALARM);
  }
}

async function handleBridgeMessage(raw: unknown): Promise<void> {
  let message: BridgeCall;
  try {
    message = JSON.parse(String(raw)) as BridgeCall;
  } catch {
    throw new Error("bridge sent invalid JSON");
  }
  if (!message || message.type !== "call" || !message.id) {
    throw new Error("bridge request must be a call with an id");
  }
  try {
    const output = await callBrowser(message, status);
    void recordAction(message, "ok", output.text || output.status || "done").catch(() => undefined);
    send({ id: message.id, type: "result", ok: true, output });
  } catch (error) {
    const messageText = errorMessage(error);
    void recordAction(message, "error", messageText).catch(() => undefined);
    send({ id: message.id, type: "result", ok: false, error: messageText });
  }
}

function send(message: BridgeMessage): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function savedBridgeURL(value: unknown): string {
  return String(value ?? DEFAULT_BRIDGE_URL) || DEFAULT_BRIDGE_URL;
}

function normalizeBridgeURL(value: unknown): string {
  const raw = String(value || DEFAULT_BRIDGE_URL).trim();
  if (!raw) return DEFAULT_BRIDGE_URL;
  const url = new URL(raw.includes("://") ? raw : `ws://${raw}`);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`unsupported bridge URL scheme ${url.protocol}`);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/browser/extension";
  return url.toString();
}

function defaultSettings(): ExtensionSettings {
  return { bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true };
}

function storageGet(defaults: ExtensionSettings): Promise<ExtensionSettings> {
  return chromePromise(chrome.storage.local.get.bind(chrome.storage.local), defaults) as Promise<ExtensionSettings>;
}

function storageSet(values: Record<string, unknown>): Promise<void> {
  return chromePromise(chrome.storage.local.set.bind(chrome.storage.local), values);
}

function recordError(error: unknown): void {
  status.connected = false;
  status.last_error = errorMessage(error);
}

async function recordAction(input: BridgeCall, result: "ok" | "error", summary: string): Promise<void> {
  const history = await actionHistory();
  const entry: ActionHistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    action: String(input.action || "unknown"),
    session: String(input.session || "default"),
    target: actionTarget(input),
    result,
    summary: oneLine(summary, 180)
  };
  await storageSet({ [ACTION_HISTORY_KEY]: [entry, ...history].slice(0, ACTION_HISTORY_LIMIT) });
}

async function actionHistory(): Promise<ActionHistoryEntry[]> {
  const stored = await chromePromise<Record<string, unknown>>(chrome.storage.local.get, { [ACTION_HISTORY_KEY]: [] });
  const raw = stored[ACTION_HISTORY_KEY];
  return Array.isArray(raw) ? raw.filter(isHistoryEntry).slice(0, ACTION_HISTORY_LIMIT) : [];
}

function isHistoryEntry(value: unknown): value is ActionHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.at === "string" &&
    typeof item.action === "string" &&
    typeof item.session === "string" &&
    typeof item.target === "string" &&
    typeof item.summary === "string" &&
    (item.result === "ok" || item.result === "error")
  );
}

function actionTarget(input: BridgeCall): string {
  const action = String(input.action || "");
  if (action === "navigate") return oneLine(input.url || "", 120);
  if (action === "press") return oneLine(input.key || "", 80);
  if (action === "type" || action === "fill" || action === "select") {
    const where = oneLine(input.selector || "", 80);
    const chars = typeof input.text === "string" ? input.text.length : 0;
    return where ? `${where} (${chars} chars)` : `${chars} chars`;
  }
  return oneLine(input.selector || input.text || "", 120);
}

function oneLine(value: unknown, limit: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trim()}…` : text;
}
