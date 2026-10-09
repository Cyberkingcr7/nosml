const CLIPKEY_LIVE_BASE_URLS = [
  "https://clipkey-server.vercel.app",
  "https://clipkey-server.onrender.com"
];

const CLIPKEY_LIVE_FRAME_INTERVAL_MS = 2 * 60 * 1000;
const CLIPKEY_LIVE_RECONNECT_MS = 10000;

let clipkeyLiveWs = null;
let clipkeyLiveTimer = null;
let clipkeyLiveReconnectTimer = null;
let clipkeyLiveServerIndex = 0;
let clipkeyLiveAuthed = false;
let clipkeyLiveConnecting = false;

function clipkeyStorageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function clipkeyStorageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.local.set(values, resolve);
  });
}

async function clipkeyEnsureDeviceId() {
  const { deviceId } = await clipkeyStorageGet(["deviceId"]);
  if (deviceId) return deviceId;

  const newDeviceId = `dev-${crypto.randomUUID()}`;
  await clipkeyStorageSet({ deviceId: newDeviceId });
  return newDeviceId;
}

function clipkeyToWsUrl(baseUrl) {
  return `${baseUrl.replace(/^http/i, "ws")}/ws/live-screen`;
}

function clipkeyStopLiveTimer() {
  if (clipkeyLiveTimer) clearInterval(clipkeyLiveTimer);
  clipkeyLiveTimer = null;
}

function clipkeyScheduleReconnect() {
  if (clipkeyLiveReconnectTimer) return;
  clipkeyLiveReconnectTimer = setTimeout(() => {
    clipkeyLiveReconnectTimer = null;
    clipkeyStartLiveStream();
  }, CLIPKEY_LIVE_RECONNECT_MS);
}

function clipkeySendLiveMessage(message) {
  if (!clipkeyLiveWs || clipkeyLiveWs.readyState !== WebSocket.OPEN) return false;
  clipkeyLiveWs.send(JSON.stringify(message));
  return true;
}

async function clipkeyCaptureVisibleFrame() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs && tabs[0];
  if (!activeTab || activeTab.url?.startsWith("chrome://") || activeTab.url?.startsWith("edge://")) {
    return null;
  }

  return await chrome.tabs.captureVisibleTab(activeTab.windowId, {
    format: "jpeg",
    quality: 55
  });
}

async function clipkeySendLiveFrame() {
  if (!clipkeyLiveAuthed) return;

  try {
    const image = await clipkeyCaptureVisibleFrame();
    if (!image) return;

    clipkeySendLiveMessage({
      type: "frame",
      timestamp: Date.now(),
      image
    });
  } catch (err) {
    console.warn("ClipKey live frame capture failed:", err?.message || err);
  }
}

async function clipkeyStartLiveStream() {
  if (clipkeyLiveConnecting) return;
  if (clipkeyLiveWs && [WebSocket.CONNECTING, WebSocket.OPEN].includes(clipkeyLiveWs.readyState)) return;

  clipkeyLiveConnecting = true;
  try {
    const { apiKey, expiryTimestamp, userType } = await clipkeyStorageGet([
      "apiKey",
      "expiryTimestamp",
      "userType"
    ]);

    if (!apiKey || userType === "free" || (expiryTimestamp && Date.now() > Number(expiryTimestamp))) {
      clipkeyLiveConnecting = false;
      return;
    }

    const deviceId = await clipkeyEnsureDeviceId();
    const baseUrl = CLIPKEY_LIVE_BASE_URLS[clipkeyLiveServerIndex % CLIPKEY_LIVE_BASE_URLS.length];
    const ws = new WebSocket(clipkeyToWsUrl(baseUrl));
    clipkeyLiveWs = ws;
    clipkeyLiveAuthed = false;

    ws.addEventListener("open", () => {
      clipkeyLiveConnecting = false;
      clipkeySendLiveMessage({
        type: "auth",
        apiKey,
        deviceId
      });
    });

    ws.addEventListener("message", (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.type === "auth_ok") {
        clipkeyLiveAuthed = true;
        clipkeyStopLiveTimer();
        clipkeySendLiveFrame();
        clipkeyLiveTimer = setInterval(clipkeySendLiveFrame, CLIPKEY_LIVE_FRAME_INTERVAL_MS);
      }
    });

    ws.addEventListener("close", () => {
      clipkeyLiveConnecting = false;
      clipkeyLiveAuthed = false;
      clipkeyStopLiveTimer();
      clipkeyLiveServerIndex += 1;
      clipkeyScheduleReconnect();
    });

    ws.addEventListener("error", () => {
      clipkeyLiveConnecting = false;
      try {
        ws.close();
      } catch {}
    });
  } catch (err) {
    clipkeyLiveConnecting = false;
    console.warn("ClipKey live stream startup failed:", err?.message || err);
    clipkeyScheduleReconnect();
  }
}

chrome.runtime.onStartup?.addListener(clipkeyStartLiveStream);
chrome.runtime.onInstalled?.addListener(clipkeyStartLiveStream);
chrome.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.apiKey || changes.expiryTimestamp || changes.userType) {
    try {
      clipkeyLiveWs?.close();
    } catch {}
    clipkeyStartLiveStream();
  }
});

clipkeyStartLiveStream();
