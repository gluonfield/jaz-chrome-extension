const DEFAULT_SCROLL = 800;
const DEFAULT_WAIT_MS = 7000;
const MAX_WAIT_MS = 60000;
const WAIT_POLL_MS = 100;
const SNAPSHOT_LIMIT = 100;
const refMap = new Map<string, Element>();

type ContentActionInput = {
  type?: string;
  action?: string;
  selector?: string;
  text?: string;
  key?: string;
  amount?: number;
};

type ContentOutput = {
  status: string;
  text?: string;
  data?: SemanticState;
};

type SemanticElement = {
  ref: string;
  tag: string;
  role: string;
  name: string;
  text: string;
  href: string;
  selector: string;
};

type SemanticState = {
  url: string;
  title: string;
  ready_state: string;
  text: string;
  elements: SemanticElement[];
};

chrome.runtime.onMessage.addListener((message: ContentActionInput, _sender, sendResponse) => {
  if (!message || message.type === "jaz_browser_ping") {
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "jaz_browser_action") return false;
  handleAction(message)
    .then((output) => sendResponse({ ok: true, output }))
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});

async function handleAction(input: ContentActionInput): Promise<ContentOutput> {
  const action = String(input.action || "").trim().toLowerCase();
  switch (action) {
    case "snapshot":
      return snapshot();
    case "state":
      return semanticState();
    case "click":
      return click(input.selector);
    case "hover":
      return hover(input.selector);
    case "type":
      return typeText(input.selector, input.text);
    case "fill":
      return fill(input.selector, input.text);
    case "select":
      return selectOption(input.selector, input.text);
    case "press":
      return press(input.key);
    case "scroll":
      return scroll(input.selector, input.text, input.amount);
    case "wait":
      return waitForState(input.selector, input.text, input.amount);
    default:
      throw new Error(`unsupported content action ${action}`);
  }
}

function snapshot(): ContentOutput {
  const lines = [
    `URL: ${location.href}`,
    `Title: ${document.title || ""}`,
    `Ready state: ${document.readyState}`,
    `Viewport: ${innerWidth}x${innerHeight}`
  ];
  const active = describeElement(document.activeElement);
  if (active) lines.push(`Focused: ${active}`);
  addSection(lines, "Headings", visibleElements("h1,h2,h3,[role=heading]").map(describeElement));
  addSection(lines, "Controls", visibleElements(controlSelector()).map(describeElement));
  addSection(lines, "Links", visibleElements("a[href],[role=link]").map(describeElement));
  const text = visiblePageText();
  if (text) {
    lines.push("Visible text:");
    lines.push(text);
  }
  return { status: "ok", text: lines.join("\n") };
}

function semanticState(): ContentOutput {
  refMap.clear();
  const elements = visibleElements(`${controlSelector()},a[href],label,summary,[role=menuitem],[role=option]`);
  const data: SemanticState = {
    url: location.href,
    title: document.title || "",
    ready_state: document.readyState,
    text: visiblePageText(),
    elements: elements.map((element, index) => {
      const ref = `e${index + 1}`;
      refMap.set(ref, element);
      return {
        ref,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || implicitRole(element),
        name: accessibleName(element),
        text: trimLength(elementText(element), 180),
        href: element instanceof HTMLAnchorElement ? element.href : "",
        selector: elementSelector(element)
      };
    })
  };
  return { status: "ok", text: formatSemanticState(data), data };
}

function formatSemanticState(data: SemanticState): string {
  const lines = [
    `URL: ${data.url}`,
    `Title: ${data.title}`,
    `Ready state: ${data.ready_state}`
  ];
  if (data.elements.length) {
    lines.push("Targets:");
    data.elements.slice(0, SNAPSHOT_LIMIT).forEach((element) => {
      const label = [element.ref, element.tag, element.role && `role=${element.role}`, element.name && JSON.stringify(element.name), element.href]
        .filter(Boolean)
        .join(" ");
      lines.push(`- ${label}`);
    });
  }
  if (data.text) {
    lines.push("Visible text:");
    lines.push(trimLength(data.text, 1800));
  }
  return lines.join("\n");
}

async function click(selector: unknown): Promise<ContentOutput> {
  const element = await target(selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  focusIfPossible(element);
  const point = center(element);
  dispatchMouse(element, "mouseover", point);
  dispatchMouse(element, "mousemove", point);
  dispatchMouse(element, "mousedown", point);
  dispatchMouse(element, "mouseup", point);
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    dispatchMouse(element, "click", point);
  }
  return { status: "ok", text: `Clicked ${describeElement(element)}` };
}

async function hover(selector: unknown): Promise<ContentOutput> {
  const element = await target(selector);
  element.scrollIntoView({ block: "center", inline: "center" });
  const point = center(element);
  dispatchMouse(element, "mouseover", point);
  dispatchMouse(element, "mousemove", point);
  return { status: "ok", text: `Hovered ${describeElement(element)}` };
}

async function typeText(selector: unknown, text: unknown): Promise<ContentOutput> {
  const element = selector ? await target(selector) : document.activeElement;
  if (!element) throw new Error("no focused element for type");
  focusEditable(element);
  insertText(element, String(text || ""), false);
  return { status: "ok", text: `Typed into ${describeElement(element)}` };
}

async function fill(selector: unknown, text: unknown): Promise<ContentOutput> {
  const element = await target(selector);
  focusEditable(element);
  insertText(element, String(text || ""), true);
  return { status: "ok", text: `Filled ${describeElement(element)}` };
}

async function selectOption(selector: unknown, value: unknown): Promise<ContentOutput> {
  const element = await target(selector);
  if (!(element instanceof HTMLSelectElement)) throw new Error("target is not a select element");
  const wanted = String(value || "");
  const option = Array.from(element.options).find((item) => item.value === wanted || normalizeSpaces(item.textContent) === normalizeSpaces(wanted));
  if (!option) throw new Error(`select option not found: ${wanted}`);
  element.value = option.value;
  dispatchInput(element);
  return { status: "ok", text: `Selected ${normalizeSpaces(option.textContent)}` };
}

function press(key: unknown): ContentOutput {
  const normalized = String(key || "").trim();
  if (!normalized) throw new Error("key is required");
  const element = document.activeElement || document.body;
  const init = { key: normalized, code: normalized, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new KeyboardEvent("keydown", init));
  if (normalized === "Enter") maybeSubmit(element);
  if (normalized === "Backspace") deleteBackward(element);
  element.dispatchEvent(new KeyboardEvent("keyup", init));
  return { status: "ok", text: `Pressed ${normalized}` };
}

async function scroll(selector: unknown, direction: unknown, amount: unknown): Promise<ContentOutput> {
  const element = selector ? await target(selector) : document.scrollingElement || document.documentElement;
  let delta = Number(amount || 0);
  if (!delta) delta = DEFAULT_SCROLL;
  const dir = String(direction || "").toLowerCase();
  const horizontal = dir === "left" || dir === "right";
  if (dir === "up" || dir === "left") delta = -Math.abs(delta);
  element.scrollBy({ top: horizontal ? 0 : delta, left: horizontal ? delta : 0, behavior: "auto" });
  return { status: "ok", text: `Scrolled ${horizontal ? "x" : "y"}=${delta}px` };
}

async function waitForState(selector: unknown, text: unknown, amount: unknown): Promise<ContentOutput> {
  const query = String(selector || "").trim();
  const wantedText = String(text || "").trim();
  const timeout = timeoutMs(amount);
  if (!query && !wantedText) {
    await waitFor(() => document.readyState === "interactive" || document.readyState === "complete", timeout);
    return { status: "ok", text: "Page is ready." };
  }
  let found;
  await waitFor(() => {
    found = query ? findTarget(query) : undefined;
    const textReady = !wantedText || normalizeText(visiblePageText()).includes(normalizeText(wantedText));
    return (!query || Boolean(found)) && textReady;
  }, timeout);
  return { status: "ok", text: `Wait condition satisfied${found ? `: ${describeElement(found)}` : "."}` };
}

function target(selector: unknown, timeout = DEFAULT_WAIT_MS): Promise<Element> {
  const query = String(selector || "").trim();
  if (!query) throw new Error("selector is required");
  let element: Element | undefined;
  return waitFor(() => {
    element = findTarget(query);
    return Boolean(element);
  }, timeout).then(() => {
    if (!element) throw new Error("selector not found");
    return element;
  });
}

function findTarget(query: string): Element | undefined {
  if (query.startsWith("ref=")) {
    const element = refMap.get(query.slice(4));
    if (element && element.isConnected) return element;
  }
  if (query.startsWith("text=")) return findByText(query.slice(5));
  if (query.startsWith("role=")) return findByRole(query.slice(5));
  if (query.startsWith("label=")) return findByText(query.slice(6));
  try {
    return deepQuerySelector(query);
  } catch {
    return findByText(query);
  }
}

function findByText(needle: string): Element | undefined {
  const normalizedNeedle = normalizeText(needle);
  if (!normalizedNeedle) return undefined;
  return visibleElements(`${controlSelector()},a[href],button,[role],label,summary`)
    .find((element) => normalizeText(accessibleName(element)).includes(normalizedNeedle));
}

function findByRole(role: string): Element | undefined {
  const wanted = normalizeText(role);
  return visibleElements("[role],button,a[href],input,select,textarea")
    .find((element) => normalizeText(element.getAttribute("role") || implicitRole(element)) === wanted);
}

function deepQuerySelector(selector: string, root: Document | ShadowRoot = document): Element | undefined {
  const direct = root.querySelector(selector);
  if (direct) return direct;
  for (const host of root.querySelectorAll("*")) {
    if (!host.shadowRoot) continue;
    const found = deepQuerySelector(selector, host.shadowRoot);
    if (found) return found;
  }
  return undefined;
}

function deepQuerySelectorAll(selector: string, root: Document | ShadowRoot = document, out: Element[] = []): Element[] {
  out.push(...root.querySelectorAll(selector));
  for (const host of root.querySelectorAll("*")) {
    if (host.shadowRoot) deepQuerySelectorAll(selector, host.shadowRoot, out);
  }
  return out;
}

function visibleElements(selector: string): Element[] {
  return deepQuerySelectorAll(selector).filter(isVisible).slice(0, SNAPSHOT_LIMIT);
}

function controlSelector(): string {
  return "button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[contenteditable=true],[aria-label]";
}

function isVisible(element: Element): boolean {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
}

function describeElement(element: Element | null): string {
  if (!(element instanceof Element)) return "";
  const role = element.getAttribute("role") || implicitRole(element);
  const name = accessibleName(element);
  const pieces = [element.tagName.toLowerCase()];
  if (role) pieces.push(`role=${role}`);
  if (element.id) pieces.push(`#${element.id}`);
  if (name) pieces.push(JSON.stringify(name));
  const href = element instanceof HTMLAnchorElement ? element.href : "";
  if (href) pieces.push(href);
  return pieces.join(" ");
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute("aria-label");
  if (aria) return normalizeSpaces(aria);
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = element.getRootNode();
    const labels = labelledBy.split(/\s+/)
      .map((id) => rootElementByID(root, id) || document.getElementById(id))
      .filter((item): item is Element => Boolean(item))
      .map((item) => item.textContent);
    if (labels.length) return normalizeSpaces(labels.join(" "));
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const label = element.labels && element.labels[0] ? element.labels[0].textContent : "";
    return normalizeSpaces(label || element.placeholder || element.value || element.name || element.type);
  }
  if (element instanceof HTMLSelectElement) {
    const label = element.labels && element.labels[0] ? element.labels[0].textContent : "";
    return normalizeSpaces(label || element.name);
  }
  if (element instanceof HTMLImageElement) return normalizeSpaces(element.alt);
  return normalizeSpaces(element.textContent || element.getAttribute("title") || "");
}

function implicitRole(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = String(element.getAttribute("type") || "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (["checkbox", "radio", "range"].includes(type)) return type === "range" ? "slider" : type;
    return "textbox";
  }
  return "";
}

function visiblePageText(): string {
  const chunks = [document.body ? document.body.innerText || document.body.textContent || "" : ""];
  for (const host of deepQuerySelectorAll("*")) {
    if (host.shadowRoot) chunks.push(host.shadowRoot.textContent || "");
  }
  const text = normalizeSpaces(chunks.join(" "));
  return text.length > 5000 ? text.slice(0, 5000) + "\n[truncated]" : text;
}

function elementText(element: Element): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLElement) return element.innerText || element.textContent || "";
  return element.textContent || "";
}

function rootElementByID(root: Node, id: string): Element | null {
  if (root instanceof Document || root instanceof ShadowRoot) return root.getElementById(id);
  return null;
}

function elementSelector(element: Element): string {
  if (!(element instanceof Element)) return "";
  if (element.id) return `#${CSS.escape(element.id)}`;
  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute("name");
  if (name) return `${tag}[name=${JSON.stringify(name)}]`;
  return tag;
}

function addSection(lines: string[], title: string, values: string[]): void {
  const clean = values.filter(Boolean).slice(0, SNAPSHOT_LIMIT);
  if (!clean.length) return;
  lines.push(`${title}:`);
  clean.forEach((value) => lines.push(`- ${value}`));
}

function focusEditable(element: Element): void {
  if (!(element instanceof HTMLElement || element instanceof SVGElement)) throw new Error("target is not focusable");
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus({ preventScroll: true });
}

function focusIfPossible(element: Element): void {
  if (element instanceof HTMLElement || element instanceof SVGElement) element.focus({ preventScroll: true });
}

function insertText(element: Element, text: string, replace: boolean): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (replace) {
      element.value = text;
      element.setSelectionRange(text.length, text.length);
    } else {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      element.value = element.value.slice(0, start) + text + element.value.slice(end);
      const cursor = start + text.length;
      element.setSelectionRange(cursor, cursor);
    }
    dispatchInput(element);
    return;
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    if (replace) element.textContent = "";
    document.execCommand("insertText", false, text);
    dispatchInput(element);
    return;
  }
  throw new Error("target is not editable");
}

function deleteBackward(element: Element): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    if (start !== end) {
      element.value = element.value.slice(0, start) + element.value.slice(end);
      element.setSelectionRange(start, start);
    } else if (start > 0) {
      element.value = element.value.slice(0, start - 1) + element.value.slice(start);
      element.setSelectionRange(start - 1, start - 1);
    }
    dispatchInput(element);
  }
}

function maybeSubmit(element: Element): void {
  const form = element instanceof Element ? element.closest("form") : null;
  if (form && typeof form.requestSubmit === "function") form.requestSubmit();
}

function dispatchInput(element: Element): void {
  element.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

function dispatchMouse(element: Element, type: string, point: { x: number; y: number }): void {
  element.dispatchEvent(new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.x,
    clientY: point.y
  }));
}

function center(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function waitFor(check: () => boolean, timeout: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (check()) {
          resolve();
          return;
        }
      } catch {
      }
      if (Date.now() - started >= timeout) {
        reject(new Error(`timed out after ${timeout}ms`));
        return;
      }
      setTimeout(tick, WAIT_POLL_MS);
    };
    tick();
  });
}

function timeoutMs(value: unknown): number {
  const raw = Number(value || 0);
  if (!raw) return DEFAULT_WAIT_MS;
  return Math.max(1, Math.min(MAX_WAIT_MS, raw));
}

function normalizeText(value: unknown): string {
  return normalizeSpaces(value).toLowerCase();
}

function normalizeSpaces(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimLength(value: unknown, limit: number): string {
  const clean = normalizeSpaces(value);
  return clean.length > limit ? clean.slice(0, limit).trim() : clean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
