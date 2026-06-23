import { ACTIONS, DEFAULT_BRIDGE_URL, PROTOCOL, callBrowser, type BridgeStatus } from "./browser_actions.js";
import { chromePromise, errorMessage } from "./chrome_async.js";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

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
  chrome.storage.local.get(defaultSettings(), (items: ExtensionSettings) => {
    chrome.storage.local.set(items);
    if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void setSidePanelBehavior();
  chrome.storage.local.get(defaultSettings(), (items: ExtensionSettings) => {
    if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (chrome.sidePanel?.open && tab.windowId !== undefined) void chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  handleRuntimeMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: errorMessage(error) });
  });
  return true;
});

void setSidePanelBehavior();

chrome.storage.local.get(defaultSettings(), (items: ExtensionSettings) => {
  status.bridge_url = items.bridge_url;
  if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
});

async function setSidePanelBehavior(): Promise<void> {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
}

async function handleRuntimeMessage(message: RuntimeMessage): Promise<Record<string, unknown>> {
  if (!message || typeof message !== "object") return { ok: false, error: "invalid message" };
  switch (message.type) {
    case "status":
      return { ok: true, status };
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
      await storageSet({
        bridge_url: bridgeURL,
        auto_connect: Boolean(message.auto_connect)
      });
      status.bridge_url = bridgeURL;
      return { ok: true, status };
    default:
      return { ok: false, error: `unknown message type ${message.type}` };
  }
}

async function connect(rawURL: unknown): Promise<void> {
  const bridgeURL = normalizeBridgeURL(rawURL);
  status.bridge_url = bridgeURL;
  if (socket && socket.readyState === WebSocket.OPEN && socket.url === bridgeURL) return;
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
  });
  socket.addEventListener("message", (event) => {
    handleBridgeMessage(event.data).catch((error) => {
      send({ type: "error", ok: false, error: errorMessage(error) });
    });
  });
  socket.addEventListener("close", () => {
    status.connected = false;
    if (!manualDisconnect) scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    status.connected = false;
    status.last_error = "bridge connection failed";
  });
}

function disconnect(reason: string): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
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

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 4));
  reconnectTimer = self.setTimeout(() => {
    chrome.storage.local.get(defaultSettings(), (items: ExtensionSettings) => {
      if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
    });
  }, delay);
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
    send({ id: message.id, type: "result", ok: true, output });
  } catch (error) {
    send({ id: message.id, type: "result", ok: false, error: errorMessage(error) });
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

function storageSet(values: ExtensionSettings): Promise<void> {
  return chromePromise(chrome.storage.local.set, values);
}

function recordError(error: unknown): void {
  status.connected = false;
  status.last_error = errorMessage(error);
}
