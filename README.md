# Jaz Chrome Extension

Chrome MV3 side-panel extension for letting Jaz browser workers operate the user's real signed-in browser.

## Build

```sh
npm test
npm run build
```

Load `dist/` in Chrome using `chrome://extensions`, Developer mode, Load unpacked.
Click the Jaz extension icon to open the side panel.

## Contract

`src/browser-extension-contract.json` is the compatibility contract with Jaz. The
extension validator checks the exported protocol, default bridge path, and action
list against it.

## Bridge Protocol

The extension connects to a local WebSocket bridge, defaulting to:

```txt
ws://127.0.0.1:5299/v1/browser/extension
```

For a local desktop Jaz backend, do not add a key. Jaz accepts the default URL
only from loopback Chrome-extension WebSocket origins. The side panel stores the
endpoint in Chrome local storage as typed.

For a remote backend or old Jaz build that still requires explicit auth, set the
side-panel endpoint to an authenticated `wss://` or `ws://` bridge URL:

```txt
wss://jaz.example.com/v1/browser/extension?key=<backend-key>
```

On connect it sends:

```json
{
  "type": "hello",
  "protocol": "jaz.browser.extension.v1",
  "extension_id": "...",
  "bridge_url": "ws://127.0.0.1:5299/v1/browser/extension",
  "user_agent": "...",
  "capabilities": {
    "actions": ["status", "tabs", "navigate", "snapshot", "state", "screenshot", "click", "hover", "type", "fill", "select", "press", "scroll", "wait"]
  }
}
```

Bridge requests use:

```json
{
  "id": "request-id",
  "type": "call",
  "session": "browser-worker-session-id",
  "action": "snapshot",
  "selector": "optional CSS selector or text=...",
  "url": "optional URL",
  "text": "optional text",
  "key": "optional key",
  "amount": 800
}
```

`state` returns compact page state with frame-aware refs such as `ref=f0:e1`. For `wait`, `selector` and `text` are conditions and `amount` is the timeout in milliseconds.

Responses use:

```json
{
  "id": "request-id",
  "type": "result",
  "ok": true,
  "output": {
    "status": "ok",
    "text": "..."
  }
}
```

Errors use the same `id` with `ok:false` and an `error` string.
