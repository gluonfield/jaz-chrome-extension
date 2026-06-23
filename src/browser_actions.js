import { chromePromise, delay, errorMessage } from "./chrome_async.js";

export const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:5299/v1/browser/extension";

const DEFAULT_SESSION = "default";
const POPUP_WAIT_MS = 1200;

export const ACTIONS = [
  "status",
  "tabs",
  "navigate",
  "snapshot",
  "state",
  "screenshot",
  "click",
  "hover",
  "type",
  "fill",
  "select",
  "press",
  "scroll",
  "wait"
];

export async function callBrowser(input, bridgeStatus) {
  const action = String(input.action || "").trim().toLowerCase();
  if (!ACTIONS.includes(action)) throw new Error(`unsupported browser action ${action}`);
  if (action === "status") return browserStatus(bridgeStatus);
  if (action === "tabs") return tabs();
  const tab = await tabFor(input);
  if (action === "navigate") return navigate(tab, input);
  if (action === "screenshot") return screenshot(tab);
  return contentAction(tab, action, input);
}

async function browserStatus(bridgeStatus) {
  const [active] = await chromePromise(chrome.tabs.query, { active: true, currentWindow: true });
  const lines = [
    "Extension bridge connected.",
    `Bridge URL: ${bridgeStatus.bridge_url}`,
    active ? `Active tab: ${active.title || "(untitled)"} ${active.url || ""}` : "Active tab: none"
  ];
  return { status: "ok", text: lines.join("\n") };
}

async function tabs() {
  const allTabs = await chromePromise(chrome.tabs.query, {});
  const lines = allTabs.map((tab) => {
    const mark = tab.active ? "*" : " ";
    return `${mark} ${tab.id} ${tab.title || "(untitled)"} ${tab.url || ""}`;
  });
  return { status: "ok", text: lines.join("\n") || "No tabs." };
}

async function tabFor(input) {
  const explicit = Number(input.tab_id || 0);
  if (explicit > 0) return chromePromise(chrome.tabs.get, explicit);
  const session = String(input.session || DEFAULT_SESSION);
  const sessions = await getSessions();
  const existingID = Number(sessions[session] || 0);
  if (existingID > 0) {
    try {
      return await chromePromise(chrome.tabs.get, existingID);
    } catch {
      delete sessions[session];
      await setSessions(sessions);
    }
  }
  const [active] = await chromePromise(chrome.tabs.query, { active: true, currentWindow: true });
  if (active && active.id > 0) {
    sessions[session] = active.id;
    await setSessions(sessions);
    return active;
  }
  const created = await chromePromise(chrome.tabs.create, { active: true, url: "about:blank" });
  sessions[session] = created.id;
  await setSessions(sessions);
  return created;
}

async function navigate(tab, input) {
  const url = String(input.url || "").trim();
  if (!url) throw new Error("url is required for navigate");
  const targetURL = url.includes("://") ? url : `https://${url}`;
  await chromePromise(chrome.tabs.update, tab.id, { url: targetURL, active: true });
  await waitForTabComplete(tab.id);
  const updated = await chromePromise(chrome.tabs.get, tab.id);
  return {
    status: "ok",
    text: `Navigated to ${updated.url || targetURL}\nTitle: ${updated.title || ""}`
  };
}

async function screenshot(tab) {
  await activate(tab);
  const dataURL = await chromePromise(chrome.tabs.captureVisibleTab, tab.windowId, { format: "png" });
  const [, payload = ""] = String(dataURL).split(",", 2);
  return {
    status: "ok",
    text: `Screenshot captured from tab ${tab.id}.`,
    image_base64: payload,
    image_mime_type: "image/png"
  };
}

async function contentAction(tab, action, input) {
  await ensureContentScript(tab.id);
  const message = {
    type: "jaz_browser_action",
    action,
    selector: input.selector || "",
    text: input.text || "",
    key: input.key || "",
    amount: Number(input.amount || 0)
  };
  if (action === "snapshot") return snapshotFrames(tab.id, message);
  if (action === "state") return stateFrames(tab.id, message);
  const run = () => firstFrameAction(tab.id, action, message);
  if (action === "click") return withPossiblePopup(tab, input.session || DEFAULT_SESSION, run);
  return run();
}

async function snapshotFrames(tabID, message) {
  const frames = await framesFor(tabID);
  const blocks = [];
  for (const frame of frames) {
    try {
      const response = await sendFrame(tabID, frame.frameId, message);
      if (response?.ok && response.output?.text) blocks.push(`Frame ${frameLabel(frame)}\n${response.output.text}`);
    } catch (error) {
      if (frame.frameId === 0) throw error;
    }
  }
  if (!blocks.length) throw new Error("snapshot failed in every frame");
  return { status: "ok", text: blocks.join("\n\n") };
}

async function stateFrames(tabID, message) {
  const frames = await framesFor(tabID);
  const blocks = [];
  const combined = {
    url: "",
    title: "",
    ready_state: "",
    text: "",
    elements: []
  };
  for (const frame of frames) {
    try {
      const response = await sendFrame(tabID, frame.frameId, message);
      if (!response?.ok) throw new Error(response?.error || "state failed");
      const output = response.output || {};
      if (output.text) blocks.push(`Frame ${frameLabel(frame)}\n${output.text}`);
      if (!output.data) continue;
      if (frame.frameId === 0) {
        combined.url = output.data.url || "";
        combined.title = output.data.title || "";
        combined.ready_state = output.data.ready_state || "";
      }
      if (output.data.text) combined.text += `${combined.text ? "\n" : ""}${output.data.text}`;
      for (const element of output.data.elements || []) {
        combined.elements.push({ ...element, ref: `f${frame.frameId}:${element.ref}` });
      }
    } catch (error) {
      if (frame.frameId === 0) throw error;
    }
  }
  if (!combined.url) {
    const tab = await chromePromise(chrome.tabs.get, tabID);
    combined.url = tab.url || "";
    combined.title = tab.title || "";
  }
  if (!blocks.length && !combined.elements.length) throw new Error("state failed in every frame");
  return { status: "ok", text: blocks.join("\n\n"), data: combined };
}

async function firstFrameAction(tabID, action, message) {
  const routed = routeFrameSelector(message.selector);
  const frameMessage = routed ? { ...message, selector: routed.selector } : message;
  const frames = routed ? [{ frameId: routed.frameID, url: "" }] : searchesFrames(action, frameMessage) ? await framesFor(tabID) : [{ frameId: 0, url: "" }];
  const errors = [];
  for (const frame of frames) {
    try {
      const response = await sendFrame(tabID, frame.frameId, frameMessage);
      if (!response?.ok) throw new Error(response?.error || "content action failed");
      const output = response.output || { status: "ok" };
      if (frame.frameId !== 0 && output.text) output.text += `\nFrame: ${frameLabel(frame)}`;
      return output;
    } catch (error) {
      errors.push(`${frameLabel(frame)}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`${action} failed in ${frames.length} frame(s): ${errors.slice(0, 3).join("; ")}`);
}

function routeFrameSelector(selector) {
  const match = String(selector || "").trim().match(/^ref=f(\d+):(.+)$/);
  if (!match) return undefined;
  return { frameID: Number(match[1]), selector: `ref=${match[2]}` };
}

async function sendFrame(tabID, frameID, message) {
  return chromePromise(chrome.tabs.sendMessage, tabID, message, { frameId: frameID });
}

function searchesFrames(action, input) {
  if (["click", "hover", "fill", "select"].includes(action)) return true;
  if (["type", "scroll"].includes(action)) return Boolean(input.selector);
  if (action === "wait") return Boolean(input.selector || input.text);
  return false;
}

async function withPossiblePopup(tab, session, run) {
  const before = await tabIDSet();
  const output = await run();
  const opened = await waitForNewTab(before);
  if (!opened) return output;
  const sessions = await getSessions();
  sessions[String(session || DEFAULT_SESSION)] = opened.id;
  await setSessions(sessions);
  await activate(opened);
  output.text = [output.text || "Clicked.", `New tab selected: ${opened.title || "(untitled)"} ${opened.url || ""}`].join("\n");
  return output;
}

async function waitForNewTab(before) {
  const deadline = Date.now() + POPUP_WAIT_MS;
  while (Date.now() < deadline) {
    const tabs = await chromePromise(chrome.tabs.query, {});
    const opened = tabs.filter((tab) => tab.id > 0 && !before.has(tab.id)).sort((a, b) => b.id - a.id)[0];
    if (opened) return opened;
    await delay(100);
  }
  return undefined;
}

async function tabIDSet() {
  const tabs = await chromePromise(chrome.tabs.query, {});
  return new Set(tabs.map((tab) => tab.id).filter((id) => id > 0));
}

async function framesFor(tabID) {
  try {
    const frames = await chromePromise(chrome.webNavigation.getAllFrames, { tabId: tabID });
    const clean = (frames || []).filter((frame) => Number.isInteger(frame.frameId));
    clean.sort((a, b) => a.frameId - b.frameId);
    return clean.length ? clean : [{ frameId: 0, url: "" }];
  } catch {
    return [{ frameId: 0, url: "" }];
  }
}

function frameLabel(frame) {
  return frame.frameId === 0 ? "top" : `${frame.frameId} ${frame.url || ""}`.trim();
}

async function ensureContentScript(tabID) {
  try {
    await chromePromise(chrome.tabs.sendMessage, tabID, { type: "jaz_browser_ping" });
  } catch {
    await chromePromise(chrome.scripting.executeScript, {
      target: { tabId: tabID, allFrames: true },
      files: ["content.js"]
    });
  }
}

async function activate(tab) {
  if (tab.windowId) await chromePromise(chrome.windows.update, tab.windowId, { focused: true });
  await chromePromise(chrome.tabs.update, tab.id, { active: true });
}

async function waitForTabComplete(tabID) {
  try {
    const tab = await chromePromise(chrome.tabs.get, tabID);
    if (tab.status === "complete") return;
  } catch {
    // The listener below will time out if the tab disappeared.
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("timed out waiting for tab load"));
    }, 30000);
    const listener = (updatedID, changeInfo) => {
      if (updatedID === tabID && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getSessions() {
  const area = sessionStorageArea();
  const result = await chromePromise(area.get.bind(area), { session_tabs: {} });
  return result.session_tabs && typeof result.session_tabs === "object" ? result.session_tabs : {};
}

async function setSessions(sessionTabs) {
  const area = sessionStorageArea();
  await chromePromise(area.set.bind(area), { session_tabs: sessionTabs });
}

function sessionStorageArea() {
  return chrome.storage.session || chrome.storage.local;
}
