import { ACTIONS, DEFAULT_BRIDGE_URL, callBrowser } from "./browser_actions.js";
import { chromePromise, errorMessage } from "./chrome_async.js";

const PROTOCOL = "jaz.browser.extension.v1";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

let socket;
let reconnectTimer;
let reconnectAttempt = 0;
let manualDisconnect = false;
let status = {
  connected: false,
  bridge_url: DEFAULT_BRIDGE_URL,
  last_error: "",
  last_connected_at: ""
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true }, (items) => {
    chrome.storage.local.set(items);
    if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true }, (items) => {
    if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleRuntimeMessage(message).then(sendResponse, (error) => {
    sendResponse({ ok: false, error: errorMessage(error) });
  });
  return true;
});

chrome.storage.local.get({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true }, (items) => {
  status.bridge_url = items.bridge_url;
  if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
});

async function handleRuntimeMessage(message) {
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
      const bridgeURL = normalizeBridgeURL(message.bridge_url);
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

async function connect(rawURL) {
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

function disconnect(reason) {
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

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempt, 4));
  reconnectTimer = setTimeout(() => {
    chrome.storage.local.get({ bridge_url: DEFAULT_BRIDGE_URL, auto_connect: true }, (items) => {
      if (items.auto_connect) void connect(items.bridge_url).catch(recordError);
    });
  }, delay);
}

async function handleBridgeMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
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

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function normalizeBridgeURL(value) {
  const raw = String(value || DEFAULT_BRIDGE_URL).trim();
  if (!raw) return DEFAULT_BRIDGE_URL;
  const url = new URL(raw.includes("://") ? raw : `ws://${raw}`);
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error(`unsupported bridge URL scheme ${url.protocol}`);
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/v1/browser/extension";
  return url.toString();
}

function storageSet(values) {
  return chromePromise(chrome.storage.local.set, values);
}

function recordError(error) {
  status.connected = false;
  status.last_error = errorMessage(error);
}
