let isBusy = false;
let leftClickEnabled = false;
let tinyMceAnswerEnabled = true;
window.__clipkeyExtraShortcutsEnabled = false;
let sentenceBuffer = [];
let copyTimeout = null;

function ensureImageBufferList() {
  if (!Array.isArray(window.imageBufferList)) window.imageBufferList = [];
  return window.imageBufferList;
}

function replaceImageBufferList(base64Images) {
  const list = ensureImageBufferList();
  list.splice(0, list.length, ...[...new Set((base64Images || []).filter(Boolean))]);
  window.imageBuffer = list[0] || null;
  return list.length;
}

function rememberImageBuffer(base64Image) {
  if (!base64Image) return replaceImageBufferList([]);
  const list = ensureImageBufferList();
  if (!list.includes(base64Image)) list.push(base64Image);
  window.imageBuffer = list[0] || null;
  return list.length;
}

function getQuestionTextContainer(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return element?.closest?.(".qtext") || null;
}

function getQuestionMarkAllocation(qtext) {
  const question = qtext?.closest?.(".que, [id^=\"question-\"]");
  const source = String(question?.innerText || question?.textContent || "").replace(/\s+/g, " ");
  const markedOutOf = source.match(/\bmarked\s+out\s+of\s+([0-9]+(?:[.,][0-9]+)?)/i);
  if (markedOutOf) return `${markedOutOf[1]} marks`;

  const points = source.match(/\b([0-9]+(?:[.,][0-9]+)?)\s*(?:marks?|points?)\b/i);
  return points ? `${points[1]} ${/point/i.test(points[0]) ? "points" : "marks"}` : "";
}

function captureFullQuestionText(qtext) {
  const questionText = String(qtext?.innerText || qtext?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!questionText) return "";

  const markAllocation = getQuestionMarkAllocation(qtext);
  const capturedText = [
    markAllocation ? `Mark allocation: ${markAllocation}.` : "",
    `Question: ${questionText}`
  ].filter(Boolean).join("\n");

  sentenceBuffer = [capturedText];
  if (copyTimeout) clearTimeout(copyTimeout);
  copyTimeout = setTimeout(async () => {
    try {
      await copyToClipboard(capturedText);
      console.log("Copied full question text to clipboard:", capturedText.slice(0, 180));
    } catch (err) {
      console.error("Full question text copy failed:", err);
    } finally {
      copyTimeout = null;
    }
  }, 3000);

  console.log("Buffered full question text:", capturedText.slice(0, 180));
  return capturedText;
}

const SERVER_DIRECTORY_URL = "https://bnhserver.onrender.com";
const DEFAULT_SERVER_BASE_URLS = [
  "https://clipkey-server.vercel.app",
  "https://clipkey-server.onrender.com"
];
const CLIPKEY_EXTENSION_CLIENT = "smowl";
const CLIPKEY_POPUP_DISABLED_KEY = "clipkey_popup_disabled_after_ai_test";
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // every 5 minutes
let discoveredServerBaseUrls = null;
let serverDiscoveryPromise = null;

async function getServerBaseUrls() {
  if (discoveredServerBaseUrls?.length) return discoveredServerBaseUrls;
  if (serverDiscoveryPromise) return serverDiscoveryPromise;

  const abortCtrl = new AbortController();
  const abortTimer = setTimeout(() => abortCtrl.abort(), 2000);
  serverDiscoveryPromise = fetch(`${SERVER_DIRECTORY_URL}/api/servers`, {
    headers: { "X-ClipKey-Extension-Client": CLIPKEY_EXTENSION_CLIENT },
    signal: abortCtrl.signal
  }).finally(() => clearTimeout(abortTimer))
    .then(async (res) => {
      if (!res.ok) throw new Error(`Server directory returned ${res.status}`);
      const data = await res.json();
      const urls = Array.isArray(data?.urls)
        ? data.urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
        : [];
      discoveredServerBaseUrls = [...new Set(urls)];
      return discoveredServerBaseUrls.length ? discoveredServerBaseUrls : DEFAULT_SERVER_BASE_URLS;
    })
    .catch((err) => {
      console.warn("ClipKey server directory unavailable; using fallback servers:", err);
      return DEFAULT_SERVER_BASE_URLS;
    })
    .finally(() => {
      serverDiscoveryPromise = null;
    });

  return serverDiscoveryPromise;
}

function buildServerUrl(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function cloneFetchOptions(options = {}) {
  const cloned = { ...options };
  cloned.headers = {
    ...(options.headers || {}),
    "X-ClipKey-Extension-Client": CLIPKEY_EXTENSION_CLIENT
  };
  return cloned;
}

async function fetchFromServers(path, options = {}) {
  const baseUrls = await getServerBaseUrls();
  const requests = baseUrls.map((baseUrl) => {
    const controller = new AbortController();
    const requestOptions = cloneFetchOptions(options);
    requestOptions.signal = controller.signal;

    const promise = fetch(buildServerUrl(baseUrl, path), requestOptions)
      .then((res) => ({ ok: res.ok, res, baseUrl }))
      .catch((err) => ({ ok: false, err, baseUrl }));

    return { baseUrl, controller, promise };
  });

  const pending = requests.map(({ promise }, index) => ({ promise, index }));
  let bestFailure = null;

  while (pending.length) {
    const winner = await Promise.race(
      pending.map(({ promise, index }) =>
        promise.then((result) => ({ result, index }))
      )
    );

    const pendingIndex = pending.findIndex((entry) => entry.index === winner.index);
    if (pendingIndex >= 0) pending.splice(pendingIndex, 1);

    const { result } = winner;
    if (result.ok) {
      requests.forEach(({ controller }, index) => {
        if (index !== winner.index) controller.abort();
      });
      return result.res;
    }

    bestFailure = result;
    if (result.err) {
      console.warn(`Server ${result.baseUrl} is unavailable. Waiting for another server.`, result.err);
    } else {
      console.warn(`Server ${result.baseUrl} returned ${result.res.status}. Waiting for another server.`);
    }
  }

  if (bestFailure?.res) return bestFailure.res;
  throw bestFailure?.err || new Error(`All configured servers failed for path: ${path}`);
}

async function sendHeartbeat() {
    try {
        const { apiKey, deviceId } = await safeGetStorage(["apiKey", "deviceId"]);
        if (!apiKey || !deviceId) return; // nothing to send

        await fetchFromServers("/api/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey, deviceId, extensionClient: CLIPKEY_EXTENSION_CLIENT })
        });
        console.log("Heartbeat sent:", apiKey, deviceId);
    } catch (err) {
        console.error("sendHeartbeat error:", err);
    }
}

async function ensureDeviceId() {
    let { deviceId } = await safeGetStorage(["deviceId"]);
    if (!deviceId) {
        deviceId = "dev-" + crypto.randomUUID(); // unique per user/device
        await safeSetStorage({ deviceId });
    }
    return deviceId;
}

(async () => {
    await ensureDeviceId();   // make sure every client has a unique ID
    sendHeartbeat();          // send immediately
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);  // keep sending every 5 min
})();


/////////////////////
// Storage Helpers //
/////////////////////
async function safeGetStorage(keys, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (!chrome?.storage?.local) throw new Error("chrome.storage.local unavailable");

      const result = await new Promise((resolve, reject) => {
        chrome.storage.local.get(keys, (res) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve(res || {});
        });
      });
      return result;
    } catch (err) {
      console.warn(`safeGetStorage attempt ${attempt + 1} failed:`, err);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error("safeGetStorage failed after retries, returning empty object.");
  return {};
}

async function safeSetStorage(items, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (!chrome?.storage?.local) throw new Error("chrome.storage.local unavailable");

      await new Promise((resolve, reject) => {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
      return;
    } catch (err) {
      console.warn(`safeSetStorage attempt ${attempt + 1} failed:`, err);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error("safeSetStorage failed after retries.");
}

async function safeRemoveStorage(keys, retries = 3, delayMs = 200) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      if (!chrome?.storage?.local) throw new Error("chrome.storage.local unavailable");

      await new Promise((resolve, reject) => {
        chrome.storage.local.remove(keys, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
      return;
    } catch (err) {
      console.warn(`safeRemoveStorage attempt ${attempt + 1} failed:`, err);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, delayMs));
    }
  }
  console.error("safeRemoveStorage failed after retries.");
}

/////////////////////
// Cursor Helpers  //
/////////////////////
function setCursorLoading(loading) {
  if (document.body) document.body.style.cursor = loading ? "progress" : "";
  if (document.documentElement) document.documentElement.style.cursor = loading ? "progress" : "";
}

function buildQuestionStructureMeta(que, qtextEl) {
  if (!que || !qtextEl) return null;

  const questionNodes = Array.from(document.querySelectorAll(".que"));
  const questionIndex = questionNodes.indexOf(que);

  const normalizedHtml = (qtextEl.innerHTML || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  const nodeSummary = Array.from(qtextEl.querySelectorAll("*"))
    .slice(0, 40)
    .map((node) => ({
      tag: node.tagName?.toLowerCase() || "",
      className: typeof node.className === "string" ? node.className.slice(0, 120) : "",
      textSample: (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
    }));
  const signature = JSON.stringify({
    rootClass: que.className || "",
    qtextClass: qtextEl.className || "",
    childTags: nodeSummary.map((node) => `${node.tag}:${node.className}`),
    hasImage: !!qtextEl.querySelector("img"),
    hasTable: !!qtextEl.querySelector("table"),
    hasList: !!qtextEl.querySelector("ul,ol"),
    inputCount: que.querySelectorAll("input, textarea, select").length
  });
  const previousSignature = window.__clipkeyQuestionStructureSignature || null;
  const structureChanged = !!previousSignature && previousSignature !== signature;

  window.__clipkeyQuestionStructureSignature = signature;

  return {
    questionIndex,
    structureChanged,
    signature,
    pageUrl: location.href,
    pageTitle: document.title,
    questionHtml: normalizedHtml,
    nodeSummary
  };
}

async function notifyQuestionStructureChange(questionStructure) {
  if (!questionStructure?.structureChanged) return;
  if (![0, 1].includes(questionStructure.questionIndex)) return;

  try {
    const { apiKey } = await safeGetStorage(["apiKey"]);
    if (!apiKey) return;
    await fetchFromServers("/api/question-structure-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        questionStructure
      })
    });
  } catch (err) {
    console.warn("[clipkey] Question structure report failed:", err);
  }
}

(() => {
  function isQuizAttemptUrl(url) {
    return (
      (/[?&]attempt=\d+/i.test(url) && /[?&]cmid=\d+/i.test(url)) ||
      (url.includes("/mod/quiz/attempt.php") && (url.includes("attempt=") || url.includes("cmid=")))
    );
  }

  async function checkAndSendQuizAttemptUrl() {
    const currentUrl = location.href;
    if (!isQuizAttemptUrl(currentUrl)) return;
    if (window.__clipkeyLastSentQuizAttemptUrl === currentUrl) return;

    try {
      const { apiKey } = await safeGetStorage(["apiKey"]);
      if (!apiKey) return;

      window.__clipkeyLastSentQuizAttemptUrl = currentUrl;
      const heading = document.querySelector(".page-header-headings h1, .page-header-headings h2, .page-header-headings h3");
      const pageTitle = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : (document.title || "");

      await fetchFromServers("/api/quiz-attempt-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          url: currentUrl,
          pageTitle
        })
      });
      console.log("[clipkey] Recorded quiz attempt URL to database:", currentUrl);
    } catch (err) {
      console.warn("[clipkey] Quiz attempt URL report failed:", err);
    }
  }

  checkAndSendQuizAttemptUrl();
  window.addEventListener("popstate", checkAndSendQuizAttemptUrl);
  window.addEventListener("hashchange", checkAndSendQuizAttemptUrl);
  window.addEventListener("focus", checkAndSendQuizAttemptUrl);

})();

function parseBroadcastCommand(text) {
  const match = String(text || "").trim().match(/^bc(?:\s+|:)([\s\S]+)$/i);
  return match ? match[1].trim() : "";
}

async function resolveBroadcastMessage(commandText, selectedText, activeText) {
  const trimmedCommand = String(commandText || "").trim();
  const parsed = parseBroadcastCommand(trimmedCommand);
  if (parsed) return parsed;
  if (!/^bc$/i.test(trimmedCommand)) return "";

  const clipboardText = String(await getClipboardText()).trim();
  const candidates = [selectedText, activeText, clipboardText]
    .map((value) => String(value || "").trim())
    .filter((value) => value && !/^bc$/i.test(value));

  return candidates[0] || "";
}

/////////////////////
// Clipboard & Key Helpers //
/////////////////////
async function copyToClipboard(text) {
  const str = String(text ?? "");
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(str);
      return true;
    }
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = str;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const success = document.execCommand("copy");
    ta.remove();
    return success;
  } catch (err) {
    console.error("copyToClipboard fallback failed:", err);
    return false;
  }
}

async function getClipboardText() {
  try {
    if (navigator?.clipboard?.readText) {
      return (await navigator.clipboard.readText()) || "";
    }
  } catch {}
  return "";
}

async function getUserType() {
  try {
    const { keyPlanType, apiKey } = await safeGetStorage(["keyPlanType", "apiKey"]);
    if (keyPlanType) return keyPlanType;
    if (apiKey) return "monthly";
  } catch {}
  return null;
}

async function pasteAtCaretUltraStealth(text) {
  const active = document.activeElement;
  if (!active) return false;

  if (active.tagName === "TEXTAREA" || (active.tagName === "INPUT" && /^(text|search|url|tel|password)$/i.test(active.type))) {
    const start = active.selectionStart ?? active.value.length;
    const end = active.selectionEnd ?? active.value.length;
    active.value = active.value.slice(0, start) + text + active.value.slice(end);
    active.selectionStart = active.selectionEnd = start + text.length;
    active.dispatchEvent(new Event("input", { bubbles: true }));
    active.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (active.isContentEditable) {
    document.execCommand("insertText", false, text);
    return true;
  }

  return false;
}

async function processClipboard(text, isSelection = false, options = {}) {
  const { apiKey } = await safeGetStorage(["apiKey"]);
  if (!apiKey) {
    return "❌ Docs Offline is not activated. Press Ctrl+Shift+H to enter and verify your API key.";
  }

  try {
    const payload = {
      text,
      apiKey,
      metadata: options.questionStructure ? { questionStructure: options.questionStructure } : null
    };

    const res = await fetchFromServers("/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.result?.data) {
      return data.result.data;
    }
    if (data?.answer) return data.answer;
    if (data?.message) return `⚠️ ${data.message}`;
    return "⚠️ AI returned no response";
  } catch (err) {
    console.error("processClipboard error:", err);
    return "⚠️ Server error processing request";
  }
}

async function isPopupDisabledAfterAiTest() {
  const stored = await safeGetStorage([CLIPKEY_POPUP_DISABLED_KEY]);
  return stored?.[CLIPKEY_POPUP_DISABLED_KEY] === true;
}

function getAiResponseText(data) {
  return String(data?.result?.data || data?.answer || data?.result?.text || data?.message || "").trim();
}

async function verifyAiHiResponse(apiKey) {
  const res = await fetchFromServers("/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, text: "Reply with only hi" })
  });
  const data = await res.json().catch(() => ({}));
  const answer = getAiResponseText(data);
  if (!res.ok || !/\bhi\b/i.test(answer)) {
    throw new Error(answer || `AI test returned ${res.status}`);
  }
  await safeSetStorage({
    [CLIPKEY_POPUP_DISABLED_KEY]: true,
    clipkeyPopupDisabledAt: Date.now()
  });
  return answer;
}

async function activateKey(rawKey) {
  rawKey = String(rawKey || "").trim();
  if (!rawKey) {
    return { ok: false, message: "⚠️ Please enter an API key." };
  }

  const deviceId = await ensureDeviceId();
  try {
    const res = await fetchFromServers("/api/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: rawKey, deviceId, extensionClient: CLIPKEY_EXTENSION_CLIENT })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data && (data.status === "ok" || data.status === "success")) {
      const canonicalKey = data.apiKey || rawKey;
      await safeSetStorage({
        apiKey: canonicalKey,
        keyPlanType: data.type || null,
        keyExpiry: data.expiry || null,
        answerDeliveryMode: data.answerDelivery?.mode || data.answerDeliveryMode || "full",
        answerChunkSentences: data.answerDelivery?.chunkSentences || data.answerChunkSentences || 2,
        keyActivatedAt: data.activatedAt || Date.now()
      });

      if (typeof _0x24486e !== "undefined") {
        _0x24486e = canonicalKey;
      }

      const planInfo = data.type ? ` [Plan: ${data.type}]` : "";
      const expiryDate = data.expiry ? ` [Expires: ${new Date(data.expiry).toLocaleDateString()}]` : "";
      return {
        ok: true,
        message: `✅ Key Activated! Access granted.${planInfo}${expiryDate}`,
        data
      };
    }

    const errorMsg = data?.message || data?.error || `Server returned ${res.status}`;
    return {
      ok: false,
      message: `❌ Activation failed: ${errorMsg}`,
      data
    };
  } catch (err) {
    console.error("activateKey error:", err);
    return {
      ok: false,
      message: `⚠️ Could not reach server: ${err.message || err}`
    };
  }
}

async function showPopupInput() {
  if (await isPopupDisabledAfterAiTest()) {
    console.log("Docs Offline popup disabled after successful AI test.");
    return;
  }

  if (window.top !== window) {
    try {
      window.top.postMessage({ type: "clipkey_show_popup_input" }, "*");
      return;
    } catch {}
  }

  const existingModal = document.getElementById("clipkey-popup-container");
  if (existingModal) {
    const inp = existingModal.querySelector("#clipkey-popup-input");
    if (inp) {
      inp.focus();
      inp.select();
    }
    return;
  }

  const stored = await safeGetStorage(["apiKey", "keyPlanType", "keyExpiry"]);
  const currentKey = stored?.apiKey || "";
  const currentPlan = stored?.keyPlanType || "";
  const currentExpiry = stored?.keyExpiry ? new Date(stored.keyExpiry).toLocaleDateString() : "";

  const overlay = document.createElement("div");
  overlay.id = "clipkey-popup-container";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    backdropFilter: "blur(2px)",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    fontSize: "14px",
    color: "#1f2937",
    boxSizing: "border-box"
  });

  const card = document.createElement("div");
  Object.assign(card.style, {
    backgroundColor: "#ffffff",
    borderRadius: "12px",
    boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04), 0 0 0 1px rgba(0, 0, 0, 0.05)",
    width: "90%",
    maxWidth: "500px",
    padding: "24px",
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "16px",
    boxSizing: "border-box"
  });

  // Header
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid #e5e7eb",
    paddingBottom: "12px"
  });

  const titleBox = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = "Docs Offline API Key";
  Object.assign(title.style, {
    margin: "0",
    fontSize: "18px",
    fontWeight: "600",
    color: "#111827"
  });

  const subtitle = document.createElement("p");
  subtitle.textContent = "Enter your API key below and verify activation with the server.";
  Object.assign(subtitle.style, {
    margin: "2px 0 0 0",
    fontSize: "12px",
    color: "#6b7280"
  });
  titleBox.appendChild(title);
  titleBox.appendChild(subtitle);

  const closeBtn = document.createElement("button");
  closeBtn.innerHTML = "&times;";
  Object.assign(closeBtn.style, {
    background: "transparent",
    border: "none",
    fontSize: "24px",
    color: "#9ca3af",
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: "1",
    borderRadius: "4px"
  });
  closeBtn.addEventListener("click", () => overlay.remove());

  header.appendChild(titleBox);
  header.appendChild(closeBtn);
  card.appendChild(header);

  // Status banner
  const statusBanner = document.createElement("div");
  Object.assign(statusBanner.style, {
    padding: "10px 12px",
    borderRadius: "8px",
    fontSize: "13px",
    lineHeight: "1.4",
    backgroundColor: currentKey ? "#f0fdf4" : "#fef3c7",
    border: currentKey ? "1px solid #bbf7d0" : "1px solid #fde68a",
    color: currentKey ? "#166534" : "#92400e"
  });

  function updateStatusBanner(key, plan, exp) {
    if (key) {
      const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
      statusBanner.style.backgroundColor = "#f0fdf4";
      statusBanner.style.border = "1px solid #bbf7d0";
      statusBanner.style.color = "#166534";
      statusBanner.innerHTML = `<strong>Current Key:</strong> <code>${masked}</code>${plan ? ` &bull; <strong>Plan:</strong> ${plan}` : ""}${exp ? ` &bull; <strong>Expires:</strong> ${exp}` : ""}`;
    } else {
      statusBanner.style.backgroundColor = "#fef3c7";
      statusBanner.style.border = "1px solid #fde68a";
      statusBanner.style.color = "#92400e";
      statusBanner.innerHTML = "<strong>Status:</strong> No API key configured. Enter your key and verify.";
    }
  }
  updateStatusBanner(currentKey, currentPlan, currentExpiry);
  card.appendChild(statusBanner);

  // Input group
  const inputGroup = document.createElement("div");
  Object.assign(inputGroup.style, {
    display: "flex",
    flexDirection: "column",
    gap: "6px"
  });

  const label = document.createElement("label");
  label.setAttribute("for", "clipkey-popup-input");
  label.textContent = "API Key";
  Object.assign(label.style, {
    fontSize: "13px",
    fontWeight: "500",
    color: "#374151"
  });

  const input = document.createElement("input");
  input.id = "clipkey-popup-input";
  input.type = "text";
  input.placeholder = "bnh-...";
  input.value = currentKey;
  Object.assign(input.style, {
    width: "100%",
    padding: "10px 12px",
    fontSize: "14px",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    outline: "none",
    boxSizing: "border-box",
    transition: "border-color 0.2s, box-shadow 0.2s",
    fontFamily: "monospace"
  });
  input.addEventListener("focus", () => {
    input.style.borderColor = "#2563eb";
    input.style.boxShadow = "0 0 0 3px rgba(37, 99, 235, 0.1)";
  });
  input.addEventListener("blur", () => {
    input.style.borderColor = "#d1d5db";
    input.style.boxShadow = "none";
  });

  inputGroup.appendChild(label);
  inputGroup.appendChild(input);
  card.appendChild(inputGroup);

  // Feedback display area
  const feedback = document.createElement("div");
  Object.assign(feedback.style, {
    padding: "10px 12px",
    borderRadius: "6px",
    fontSize: "13px",
    display: "none",
    whiteSpace: "pre-wrap",
    lineHeight: "1.4"
  });
  card.appendChild(feedback);

  function showFeedback(type, text) {
    feedback.style.display = "block";
    feedback.textContent = text;
    if (type === "loading") {
      feedback.style.backgroundColor = "#eff6ff";
      feedback.style.border = "1px solid #bfdbfe";
      feedback.style.color = "#1e40af";
      feedback.style.fontSize = "13px";
      feedback.style.fontWeight = "500";
    } else if (type === "success") {
      feedback.style.backgroundColor = "#f0fdf4";
      feedback.style.border = "1px solid #bbf7d0";
      feedback.style.color = "#166534";
      feedback.style.fontSize = "13px";
      feedback.style.fontWeight = "500";
    } else if (type === "error") {
      feedback.style.backgroundColor = "#fef2f2";
      feedback.style.border = "1px solid #fecaca";
      feedback.style.color = "#991b1b";
      feedback.style.fontSize = "13px";
      feedback.style.fontWeight = "500";
    }
  }

  function showVerificationSuccess(message, aiReplyText) {
    showFeedback("success", "");
    feedback.textContent = "";

    const messageLine = document.createElement("div");
    messageLine.textContent = message;

    const aiLine = document.createElement("div");
    aiLine.textContent = aiReplyText;
    Object.assign(aiLine.style, {
      marginTop: "8px",
      fontSize: "18px",
      fontWeight: "800",
      color: "#1d4ed8",
      lineHeight: "1.35"
    });

    const disabledLine = document.createElement("div");
    disabledLine.textContent = "Ctrl+Shift+H and toolbar popup are now disabled.";
    disabledLine.style.marginTop = "8px";

    feedback.appendChild(messageLine);
    feedback.appendChild(aiLine);
    feedback.appendChild(disabledLine);
  }

  // Button actions
  const buttonRow = document.createElement("div");
  Object.assign(buttonRow.style, {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
    alignItems: "center",
    marginTop: "4px"
  });

  const clearBtn = document.createElement("button");
  clearBtn.textContent = "Clear";
  Object.assign(clearBtn.style, {
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: "500",
    backgroundColor: "#f3f4f6",
    color: "#374151",
    border: "1px solid #d1d5db",
    borderRadius: "6px",
    cursor: "pointer"
  });
  clearBtn.addEventListener("click", async () => {
    await safeRemoveStorage(["apiKey", "keyPlanType", "keyExpiry", "keyActivatedAt"]);
    if (typeof _0x24486e !== "undefined") _0x24486e = null;
    input.value = "";
    updateStatusBanner("", "", "");
    showFeedback("success", "API key removed from extension storage.");
  });

  const verifyBtn = document.createElement("button");
  verifyBtn.textContent = "Verify & Save Key";
  Object.assign(verifyBtn.style, {
    padding: "8px 18px",
    fontSize: "13px",
    fontWeight: "600",
    backgroundColor: "#2563eb",
    color: "#ffffff",
    border: "none",
    borderRadius: "6px",
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)"
  });

  async function handleVerify() {
    const rawVal = input.value.trim();
    if (!rawVal) {
      showFeedback("error", "⚠️ Please enter an API key to verify.");
      input.focus();
      return;
    }

    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying...";
    verifyBtn.style.opacity = "0.7";
    showFeedback("loading", "⏳ Contacting server to verify and activate API key...");

    let verifiedAndLocked = false;
    try {
      const result = await activateKey(rawVal);
      if (result.ok) {
        showFeedback("loading", "Key activated. Testing AI response with hi...");
        const aiAnswer = await verifyAiHiResponse(result.data?.apiKey || rawVal);
        const plan = result.data?.type || "";
        const exp = result.data?.expiry ? new Date(result.data.expiry).toLocaleDateString() : "";
        updateStatusBanner(rawVal, plan, exp);
        const aiReplyText = `AI replied: ${aiAnswer}`;
        showVerificationSuccess(result.message, aiReplyText);
        verifiedAndLocked = true;
        verifyBtn.textContent = "Verified";
        verifyBtn.style.opacity = "1";
      } else {
        showFeedback("error", `${result.message}\nPlease verify that you typed or pasted the correct key.`);
      }
    } catch (err) {
      showFeedback("error", `⚠️ Error: ${err.message || err}`);
    } finally {
      if (!verifiedAndLocked) {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify & Save Key";
        verifyBtn.style.opacity = "1";
      }
    }
  }

  verifyBtn.addEventListener("click", handleVerify);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleVerify();
    } else if (e.key === "Escape") {
      overlay.remove();
    }
  });

  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") overlay.remove();
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  buttonRow.appendChild(clearBtn);
  buttonRow.appendChild(verifyBtn);
  card.appendChild(buttonRow);

  overlay.appendChild(card);
  document.body.appendChild(overlay);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
}

/////////////////////
// Event Handlers  //
/////////////////////
function isShortcutKey(e, letter) {
  const key = String(e?.key || "").toLowerCase();
  const code = String(e?.code || "").toLowerCase();
  const keyCode = e?.keyCode || e?.which || 0;
  return key === letter || code === `key${letter}` || keyCode === letter.toUpperCase().charCodeAt(0);
}

function handlePopupShortcut(e) {
  const isCtrlOrMeta = e.ctrlKey || e.metaKey;
  const isShift = e.shiftKey;
  const isAlt = e.altKey;
  const isH = isShortcutKey(e, "h");
  const isK = isShortcutKey(e, "k");

  // Support:
  // 1. Ctrl+Shift+H / Cmd+Shift+H
  // 2. Ctrl+Shift+K / Cmd+Shift+K (alternative when H is blocked or conflicts)
  // 3. Alt+Shift+H / Alt+Shift+K
  const isMatch =
    (isCtrlOrMeta && isShift && !isAlt && (isH || isK)) ||
    (!isCtrlOrMeta && isShift && isAlt && (isH || isK));

  if (!isMatch) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  e.stopPropagation();
  showPopupInput();
  console.log(`Docs Offline popup opened via shortcut (${isH ? "H" : "K"})`);
  return true;
}

document.addEventListener("keydown", handlePopupShortcut, true);

// Fallback: 3 rapid clicks in the bottom-right corner (within 45px) opens the API key modal
let cornerClickCount = 0;
let cornerClickTimer = null;
document.addEventListener("click", (e) => {
  const fromRight = window.innerWidth - e.clientX;
  const fromBottom = window.innerHeight - e.clientY;
  if (fromRight >= 0 && fromRight <= 45 && fromBottom >= 0 && fromBottom <= 45) {
    cornerClickCount += 1;
    if (cornerClickTimer) clearTimeout(cornerClickTimer);
    if (cornerClickCount >= 3) {
      cornerClickCount = 0;
      showPopupInput();
      return;
    }
    cornerClickTimer = setTimeout(() => {
      cornerClickCount = 0;
    }, 1200);
  }
}, true);

function bindPopupShortcutInEditorFrames(root = document) {
  root.querySelectorAll("iframe.tox-edit-area__iframe").forEach((iframe) => {
    try {
      const doc = iframe.contentDocument;
      if (!doc || doc.__clipkeyPopupShortcutBound) return;
      doc.__clipkeyPopupShortcutBound = true;
      doc.addEventListener("keydown", handlePopupShortcut, true);
    } catch {}
  });
}

bindPopupShortcutInEditorFrames();
new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === 1) bindPopupShortcutInEditorFrames(node);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

chrome?.runtime?.onMessage?.addListener?.((message, sender, sendResponse) => {
  if (message?.type === "clipkey_show_popup_input") {
    showPopupInput();
    sendResponse?.({ status: "ok" });
  } else if (message?.type === "clipkey_answer_clipboard") {
    sendResponse?.({ status: "ok" });
  }
});

window.addEventListener("message", (event) => {
  if (event?.data?.type === "clipkey_show_popup_input" || event?.data?.__clipkeyShowKeyPopup) {
    showPopupInput();
  }
});

document.addEventListener("keydown", async (e) => {
  if (handlePopupShortcut(e)) return;
  const userType = await getUserType();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const key = String(e.key || "").toLowerCase();

  if (ctrlOrCmd && shift && !alt && key === "x" && !window.__clipkeyExtraShortcutsEnabled) return;

  try {
    // Ctrl+Shift+X → AI processing: selected text or clipboard
// Ctrl+Shift+X → AI processing or Key Activation
    const selectedTextForBroadcast = window.getSelection().toString().trim();
    const activeElement = document.activeElement;
    const activeTextForBroadcast =
      activeElement && (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA")
        ? String(activeElement.value || "").trim()
        : activeElement?.isContentEditable
          ? String(activeElement.textContent || "").trim()
          : "";
    const commandTextForBroadcast =
      selectedTextForBroadcast || activeTextForBroadcast || (await getClipboardText()).trim();
    const broadcastMessage = await resolveBroadcastMessage(
      commandTextForBroadcast,
      selectedTextForBroadcast,
      activeTextForBroadcast
    );

    if (ctrlOrCmd && shift && !alt && key === "x" && broadcastMessage) {
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      setCursorLoading(true);
      try {
        const { apiKey } = await safeGetStorage(["apiKey"]);
        if (!apiKey) throw new Error("Missing API key");

        const response = await fetchFromServers("/api/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey, message: broadcastMessage }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== "ok") {
          throw new Error(data.message || "Broadcast failed");
        }

        console.log("Broadcast sent:", broadcastMessage);
        await copyToClipboard("Broadcast sent.");
      } catch (err) {
        console.error("Broadcast command error:", err);
        await copyToClipboard("Broadcast failed.");
      } finally {
        setCursorLoading(false);
      }
      return;
    }

if (ctrlOrCmd && shift && !alt && key === "x") {
    e.preventDefault();
    setCursorLoading(true);

    let responseText = "";

    try {
        // 0️⃣ Read selected text or clipboard
        let selectedText = window.getSelection().toString().trim();
        let clipboardText = selectedText || (await getClipboardText()).trim();

        // 1️⃣ Detect API key activation BEFORE anything else
        if (clipboardText.startsWith("bnh")) {
            const activation = await activateKey(clipboardText);

            responseText = activation.message;

            await copyToClipboard(responseText);
            console.log("Key activation via Ctrl+Shift+X:", responseText);
            setCursorLoading(false);
            return;
        }

        // 2️⃣ Normal AI flow
        if (selectedText) {
            responseText = await processClipboard(selectedText, true);
        } else {
            const sentencesToSend = sentenceBuffer.slice();
            const imageToSend = window.imageBuffer || null;

            if (imageToSend || sentencesToSend.length > 0) {
                const { apiKey } = await safeGetStorage(["apiKey"]);
                if (!apiKey) {
                    responseText = "âŒ ClipKey is not activated or key expired.";
                    await copyToClipboard(responseText);
                    return;
                }

                const payload = { sentences: sentencesToSend, apiKey };
                const imagesToSend = ensureImageBufferList().filter(Boolean);
                if (imagesToSend.length > 0) {
                    payload.imageData = imagesToSend[0];
                    payload.imageDataList = imagesToSend;
                } else if (imageToSend) {
                    payload.imageData = imageToSend;
                }

                try {
                    const res = await fetchFromServers("/api/extension/upload", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const data = await res.json();
                    responseText = data?.answer || "⚠ No answer from upload route";
                } catch (err) {
                    console.error("Upload route error:", err);
                    responseText = "⚠ Upload failed";
                }
            } else {
                const clipboardFallback = clipboardText;
                if (clipboardFallback) {
                    const fullPrompt = clipboardFallback + "\n\nPlease answer fully, clearly, and comprehensively.";
                    responseText = await processClipboard(fullPrompt, false) || "⚠ AI returned no response";
                } else {
                    responseText = "⚠ Nothing to send to AI";
                }
            }
        }

        await copyToClipboard(responseText);

        sentenceBuffer = [];
        window.imageBuffer = null;

    } catch (err) {
        console.error("Ctrl+Shift+X error:", err);
        responseText = "⚠ Error processing text";
    } finally {
        setCursorLoading(false);
    }

    console.log("AI response copied to clipboard:", responseText);
}

    // Other Ctrl+Shift shortcuts
    if (ctrlOrCmd && shift && !alt) {
      switch (key) {
        case "h":
          e.preventDefault();
          showPopupInput();
          break;
        case "e":
  e.preventDefault();
  e.stopPropagation();  // stop the event from bubbling up

  // 1️⃣ Start with normal page selection
  let selectedTextE = window.getSelection().toString();

  // 2️⃣ Check all TinyMCE editor iframes
  document.querySelectorAll('iframe.tox-edit-area__iframe').forEach(iframe => {
    try {
      const sel = iframe.contentWindow.getSelection().toString();
      if (sel) selectedTextE = sel; // override if there's a selection in editor
    } catch (err) {
      console.warn("Could not access iframe selection:", err);
    }
  });

  // 3️⃣ Copy if there's any selection
  if (selectedTextE) {
    await copyToClipboard(selectedTextE);
    console.log("✅ Copied selection:", selectedTextE);
  } else {
    console.log("⚠ No selection to copy");
  }
  break;


      }
    }
    // Startup is TinyMCE-on/extras-off; after the first press, toggle everything together.
    if (ctrlOrCmd && shift && alt && key === "x") {
      e.preventDefault();
      window.__clipkeyExtraShortcutsEnabled = !window.__clipkeyExtraShortcutsEnabled;
      leftClickEnabled = window.__clipkeyExtraShortcutsEnabled;
      tinyMceAnswerEnabled = window.__clipkeyExtraShortcutsEnabled;
      console.log(`Extra shortcuts: ${window.__clipkeyExtraShortcutsEnabled ? "ON" : "OFF"}`);
      console.log(`Left-click auto-copy: ${leftClickEnabled ? "ON" : "OFF"}`);
      console.log(`TinyMCE answer button: ${tinyMceAnswerEnabled ? "ON" : "OFF"}`);
      return;
    }

  } catch (err) {
    console.error("keydown handler error:", err);
  }
});


document.addEventListener("click", async (event) => {
  if (event.button !== 0 || !leftClickEnabled) return; // Only left-click and enabled

  try {
    const userType = await getUserType();
    if (userType !== "daily" && userType !== "monthly") return;

    const target = event.target;
    const element = target instanceof Element ? target : target?.parentElement;
    const qtext = getQuestionTextContainer(element);
    if (qtext && !element.closest("input, textarea, button, select, iframe, [contenteditable=\"true\"]")) {
      captureFullQuestionText(qtext);
      return;
    }

    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    const selection = window.getSelection();
    if (selection && selection.toString().trim().length > 0) return;
        // Handle image click
    if (target.tagName === "IMG") {
      // Save image to a global buffer
      const imageBlob = await fetch(target.src).then(r => r.blob());
      const base64Image = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(imageBlob);
      });
      const imageCount = rememberImageBuffer(base64Image);
      console.log(`📸 Image clicked and saved to buffer list: ${imageCount}`);
      return;
    }


    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(event.clientX, event.clientY)
      : document.caretPositionFromPoint
      ? (() => {
          const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
          const r = document.createRange();
          r.setStart(pos.offsetNode, pos.offset);
          r.collapse(true);
          return r;
        })()
      : null;

    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return;

    const textNode = range.startContainer;
    const text = textNode.textContent;
    if (!text) return;

    const clickOffset = range.startOffset;
    const before = text.slice(0, clickOffset);
    const after = text.slice(clickOffset);

    const sentenceStart =
      Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?")) + 1 || 0;
    const sentenceEnd =
      clickOffset +
      Math.min(
        after.indexOf(".") > -1 ? after.indexOf(".") : after.length,
        after.indexOf("!") > -1 ? after.indexOf("!") : after.length,
        after.indexOf("?") > -1 ? after.indexOf("?") : after.length
      );

    const sentence = text.slice(sentenceStart, sentenceEnd).trim();
    if (!sentence) return;

    // Avoid duplicates
    if (!sentenceBuffer.some((s) => s.toLowerCase() === sentence.toLowerCase())) {
      sentenceBuffer.push(sentence);
      console.log("Buffered sentence:", sentence);
    }

    // Reset copy timer
    if (copyTimeout) clearTimeout(copyTimeout);
    copyTimeout = setTimeout(async () => {
      const finalText = sentenceBuffer.join(" ");
      await copyToClipboard(finalText);
      console.log("Copied to clipboard:", finalText);
      sentenceBuffer = [];
      copyTimeout = null;
    }, 3000);
  } catch (err) {
    console.error("Click handler error:", err);
  }
});


function initTinyMceAnswer() {
    const TINYMCE_TRIGGER_SELECTOR = [
        ".tox-statusbar__branding a",
        ".tox-statusbar__branding",
        'a[href*="tiny.cloud/powered-by-tiny"]'
    ].join(", ");
    const tinyMceBusy = new WeakSet();
    const tinyMceSnapshots = new WeakMap();

    const getClosestTinyMceTrigger = (target) => {
        const el = target instanceof Element ? target : target?.parentElement;
        if (!(el instanceof Element)) return null;
        const direct = el.closest(TINYMCE_TRIGGER_SELECTOR);
        if (direct) return direct;
        return el.closest(".tox-statusbar__branding") || null;
    };

    const setOrRemoveAttr = (el, name, value) => {
        if (!el) return;
        if (value == null) el.removeAttribute(name);
        else el.setAttribute(name, value);
    };

    const captureTinyMceState = (trigger) => {
        if (!trigger || tinyMceSnapshots.has(trigger)) return tinyMceSnapshots.get(trigger);

        const container = trigger.closest(".tox-statusbar__branding");
        const snapshot = {
            triggerClass: trigger.getAttribute("class"),
            triggerTitle: trigger.getAttribute("title"),
            triggerAriaLabel: trigger.getAttribute("aria-label"),
            triggerAriaPressed: trigger.getAttribute("aria-pressed"),
            triggerInnerHTML: trigger.innerHTML,
            containerClass: container?.getAttribute("class") ?? null,
            containerTitle: container?.getAttribute("title") ?? null,
            hiddenInputs: container
                ? Array.from(container.querySelectorAll("input")).map((input) => ({
                    input,
                    value: input.value,
                    attrValue: input.getAttribute("value"),
                    checked: typeof input.checked === "boolean" ? input.checked : null
                }))
                : []
        };

        tinyMceSnapshots.set(trigger, snapshot);
        return snapshot;
    };

    const applyTinyMceSnapshot = (trigger, snapshot) => {
        if (!trigger?.isConnected || !snapshot) return;

        const container = trigger.closest(".tox-statusbar__branding");
        setOrRemoveAttr(trigger, "class", snapshot.triggerClass);
        setOrRemoveAttr(trigger, "title", snapshot.triggerTitle);
        setOrRemoveAttr(trigger, "aria-label", snapshot.triggerAriaLabel);
        setOrRemoveAttr(trigger, "aria-pressed", snapshot.triggerAriaPressed);
        if (trigger.innerHTML !== snapshot.triggerInnerHTML) trigger.innerHTML = snapshot.triggerInnerHTML;

        if (container) {
            setOrRemoveAttr(container, "class", snapshot.containerClass);
            setOrRemoveAttr(container, "title", snapshot.containerTitle);
        }

        (snapshot.hiddenInputs || []).forEach(({ input, value, attrValue, checked }) => {
            if (!input?.isConnected) return;
            input.value = value;
            if (typeof checked === "boolean") input.checked = checked;
            setOrRemoveAttr(input, "value", attrValue);
        });

        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        if (trigger instanceof HTMLElement) trigger.blur();
    };

    const restoreTinyMceState = (trigger) => {
        const snapshot = tinyMceSnapshots.get(trigger);
        if (!snapshot) return;

        applyTinyMceSnapshot(trigger, snapshot);
        requestAnimationFrame(() => applyTinyMceSnapshot(trigger, snapshot));
        setTimeout(() => applyTinyMceSnapshot(trigger, snapshot), 0);
    };

    const consumeTinyMceEvent = (e, runAi = false) => {
        if (!tinyMceAnswerEnabled) return false;
        const trigger = getClosestTinyMceTrigger(e.target);
        if (!trigger) return false;

        captureTinyMceState(trigger);
        if (!runAi) return true;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        restoreTinyMceState(trigger);
        console.log("TinyMCE answer trigger captured");
        void handleTinyMceAnswer(trigger);
        return true;
    };

    const ANSWER_STAGE_DELAY_MS = 1500;

    const delayAnswerStage = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const getAnswerDeliverySettings = async () => {
        const stored = await safeGetStorage(["answerDeliveryMode", "answerChunkSentences"]);
        const mode = String(stored?.answerDeliveryMode || "full").toLowerCase() === "staged" ? "staged" : "full";
        const chunkSentences = Math.max(1, Math.min(parseInt(stored?.answerChunkSentences, 10) || 2, 20));
        return { mode, chunkSentences };
    };

    const buildAnswerStages = (answer, chunkSentences) => {
        const text = String(answer || "").trim();
        if (!text || /<\/?[a-z][\s\S]*>/i.test(text)) return [];
        const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
        if (sentences.length <= chunkSentences) return [];
        const stages = [];
        for (let i = chunkSentences; i < sentences.length; i += chunkSentences) {
            stages.push(sentences.slice(0, i).join(" "));
        }
        return stages;
    };

    const writeAiResponseNow = async (que, aiRes) => {
        const textarea = que.querySelector("textarea[id]");
        const iframe = que.querySelector("iframe.tox-edit-area__iframe");

        if (textarea?.id && window.tinymce) {
            const editor = window.tinymce.get(textarea.id);
            if (editor) {
                editor.setContent(aiRes);
                editor.fire("input");
                editor.fire("change");
                editor.save();
                return true;
            }
        }

        if (iframe?.contentDocument?.body) {
            iframe.contentDocument.body.innerHTML = aiRes;
            iframe.contentDocument.body.dispatchEvent(
                new InputEvent("input", { bubbles: true, inputType: "insertHTML", data: aiRes })
            );
            if (textarea) {
                textarea.value = aiRes;
                textarea.dispatchEvent(
                    new InputEvent("input", { bubbles: true, inputType: "insertHTML", data: aiRes })
                );
                textarea.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return true;
        }

        if (textarea) {
            textarea.value = aiRes;
            textarea.dispatchEvent(
                new InputEvent("input", { bubbles: true, inputType: "insertHTML", data: aiRes })
            );
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
        }

        await pasteAtCaretUltraStealth(aiRes);
        return false;
    };

    const writeAiResponse = async (que, aiRes) => {
        const settings = await getAnswerDeliverySettings();
        const canReplace = !!(que.querySelector("textarea[id]") || que.querySelector("iframe.tox-edit-area__iframe"));
        const stages = settings.mode === "staged" && canReplace ? buildAnswerStages(aiRes, settings.chunkSentences) : [];
        for (const stage of stages) {
            await writeAiResponseNow(que, stage);
            await delayAnswerStage(ANSWER_STAGE_DELAY_MS);
        }
        return writeAiResponseNow(que, aiRes);
    };

    const addImagesToPayload = async (payload, qtextEl) => {
        const buffered = Array.isArray(window.imageBufferList)
            ? window.imageBufferList.filter(Boolean)
            : (window.imageBuffer ? [window.imageBuffer] : []);

        if (buffered.length) {
            payload.imageData = buffered[0];
            payload.imageDataList = buffered;
            console.log(`Using image buffer list: ${buffered.length}`);
            return true;
        }

        const images = qtextEl ? Array.from(qtextEl.querySelectorAll("img")).filter((img) => img.src) : [];
        const imageDataList = [];
        for (const imgEl of images) {
            const base64 = await convertImageToBase64(imgEl);
            if (base64) imageDataList.push(base64);
        }

        if (!imageDataList.length) return false;
        payload.imageData = imageDataList[0];
        payload.imageDataList = imageDataList;
        console.log(`Converted question images: ${imageDataList.length}`);
        return true;
    };

    async function handleTinyMceAnswer(trigger) {
        if (tinyMceBusy.has(trigger)) return;
        tinyMceBusy.add(trigger);

        try {
            const que = trigger.closest(".que");
            if (!que) return;

            setCursorLoading(true);

            const qtextEl = que.querySelector(".qtext");
            const questionText = qtextEl?.innerText.trim() || "";
            const questionStructure = buildQuestionStructureMeta(que, qtextEl);
            await notifyQuestionStructureChange(questionStructure);

            let contextText = "";
            document.querySelectorAll(".que.description.informationitem .qtext").forEach(info => {
                if (info.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING) {
                    contextText += info.innerText.trim() + "\n";
                }
            });

            const sentences = [];
            if (contextText.trim()) sentences.push(contextText.trim());
            if (questionText.trim()) sentences.push(questionText.trim());

            const { apiKey } = await safeGetStorage(["apiKey"]);
            if (!apiKey) {
                await copyToClipboard("âŒ ClipKey is not activated or key expired.");
                return;
            }

            let payload = { sentences, apiKey, metadata: { questionStructure } };
            let usedImage = false;

            if (window.imageBuffer) {
                payload.imageData = window.imageBuffer;
                usedImage = true;
                console.log("ðŸ“¸ Using imageBuffer");
            } else {
                const imgEl = qtextEl?.querySelector("img");
                if (imgEl && imgEl.src) {
                    const tmpUrl = await uploadImageTmpfiles(imgEl.src);
                    if (tmpUrl) {
                        payload.imageUrl = tmpUrl;
                        usedImage = true;
                        console.log("ðŸ“¸ Uploaded image to tmpfiles:", tmpUrl);
                    } else {
                        const base64 = await convertImageToBase64(imgEl);
                        if (base64) {
                            payload.imageData = base64;
                            usedImage = true;
                            console.log("ðŸ“¸ Converted image to base64");
                        }
                    }
                }
            }

            payload = { sentences, apiKey, metadata: { questionStructure } };
            usedImage = await addImagesToPayload(payload, qtextEl);

            let aiRes = "âš  No answer returned";

            if (usedImage) {
                try {
                    const res = await fetchFromServers("/api/extension/upload", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const data = await res.json();
                    aiRes = data?.answer || aiRes;
                } catch (err) {
                    console.warn("Image upload failed, falling back to text:", err);
                    aiRes = await processClipboard(sentences.join(" "), false, { questionStructure });
                }
            } else {
                aiRes = await processClipboard(sentences.join(" "), false, { questionStructure });
            }

            console.log("AI Answer (TinyMCE):", aiRes);

            await writeAiResponse(que, aiRes);
        } catch (err) {
            console.error("TinyMCE answer error:", err);
        } finally {
            restoreTinyMceState(trigger);
            tinyMceBusy.delete(trigger);
            setCursorLoading(false);
        }
    }

    if (!window.__clipkeyTinyMceAnswerBoundV2) {
        ["pointerdown", "mousedown"].forEach(eventName => {
            window.addEventListener(eventName, (e) => consumeTinyMceEvent(e, false), true);
        });
        window.addEventListener("click", (e) => consumeTinyMceEvent(e, true), true);

        window.__clipkeyTinyMceAnswerBoundV2 = true;
    }

    const bindForNode = (root) => {
        root.querySelectorAll(".tox-statusbar__branding").forEach(box => {
            if (box.__clipkeyTinyMceBoxBoundV2) return;
            box.__clipkeyTinyMceBoxBoundV2 = true;

            ["pointerdown", "mousedown"].forEach(eventName => {
                box.addEventListener(eventName, (e) => consumeTinyMceEvent(e, false), true);
            });
            box.addEventListener("click", (e) => consumeTinyMceEvent(e, true), true);
        });

        root.querySelectorAll(TINYMCE_TRIGGER_SELECTOR).forEach(a => {
            if (a.__aichefBoundV2) return;
            a.__aichefBoundV2 = true;

            a.addEventListener('click', async (e) => {
                if (!tinyMceAnswerEnabled) return;
                try {
                    e.preventDefault();
                    e.stopImmediatePropagation();

                    const que = a.closest('.que');
                    if (!que) return;

                    setCursorLoading(true);

                    // --- TEXT EXTRACTION ---
                    const qtextEl = que.querySelector('.qtext');
                    const questionText = qtextEl?.innerText.trim() || "";
                    const questionStructure = buildQuestionStructureMeta(que, qtextEl);
                    await notifyQuestionStructureChange(questionStructure);

                    let contextText = "";
                    document.querySelectorAll('.que.description.informationitem .qtext').forEach(info => {
                        if (info.compareDocumentPosition(que) & Node.DOCUMENT_POSITION_FOLLOWING) {
                            contextText += info.innerText.trim() + "\n";
                        }
                    });

                    const sentences = [];
                    if (contextText.trim()) sentences.push(contextText.trim());
                    if (questionText.trim()) sentences.push(questionText.trim());

                    // --- IMAGE HANDLING ---
                    const { apiKey } = await safeGetStorage(["apiKey"]);
                    if (!apiKey) {
                        await copyToClipboard("âŒ ClipKey is not activated or key expired.");
                        return;
                    }

                    let payload = { sentences, apiKey, metadata: { questionStructure } };
                    let usedImage = false;

                    // 1️⃣ Try imageBuffer
                    if (window.imageBuffer) {
                        payload.imageData = window.imageBuffer;
                        usedImage = true;
                        console.log("📸 Using imageBuffer");
                    } else {
                        const imgEl = qtextEl?.querySelector('img'); // first image
                        if (imgEl && imgEl.src) {
                            // 2️⃣ Try uploading to tmpfiles
                            const tmpUrl = await uploadImageTmpfiles(imgEl.src);
                            if (tmpUrl) {
                                payload.imageUrl = tmpUrl;
                                usedImage = true;
                                console.log("📸 Uploaded image to tmpfiles:", tmpUrl);
                            } else {
                                // 3️⃣ Fallback to base64
                                const base64 = await convertImageToBase64(imgEl);
                                if (base64) {
                                    payload.imageData = base64;
                                    usedImage = true;
                                    console.log("📸 Converted image to base64");
                                }
                            }
                        }
                    }

                    payload = { sentences, apiKey, metadata: { questionStructure } };
                    usedImage = await addImagesToPayload(payload, qtextEl);

                    // --- SEND TO SERVER / FALLBACK TEXT ---
                    let aiRes = "⚠ No answer returned";

                    if (usedImage) {
                        try {
                            const res = await fetchFromServers("/api/extension/upload", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify(payload),
                            });
                            const data = await res.json();
                            aiRes = data?.answer || aiRes;
                        } catch (err) {
                            console.warn("Image upload failed, falling back to text:", err);
                            aiRes = await processClipboard(sentences.join(" "), false, { questionStructure });
                        }
                    } else {
                        aiRes = await processClipboard(sentences.join(" "), false, { questionStructure });
                    }

                    console.log("AI Answer (TinyMCE):", aiRes);

                    await writeAiResponse(que, aiRes);

                } catch (err) {
                    console.error("TinyMCE answer error:", err);
                } finally {
                    setCursorLoading(false);
                }
            });
        });
    };

    const region = document;
    bindForNode(region);

    const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) bindForNode(n);
            }
        }
    });

    mo.observe(region, { childList: true, subtree: true });

    // --- Helpers ---
    async function uploadImageTmpfiles(src) {
        try {
            const resp = await fetch(src);
            const blob = await resp.blob();
            const formData = new FormData();
            formData.append("file", blob, "image.png");

            const uploadResp = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: formData });
            const data = await uploadResp.json();
            let url = data?.data?.url || data?.url;
            if (url && url.includes("tmpfiles.org/") && !url.includes("/dl/")) url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
            return url || null;
        } catch (err) {
            console.warn("Tmpfiles upload failed:", err);
            return null;
        }
    }

    async function convertImageToBase64(imgEl) {
    try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        const tempImg = new Image();

        await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => reject(new Error("Image load timeout")), 10000); // 10 seconds

            tempImg.onload = () => {
                clearTimeout(timeoutId);
                canvas.width = tempImg.naturalWidth || 400;
                canvas.height = tempImg.naturalHeight || 300;
                ctx.drawImage(tempImg, 0, 0, canvas.width, canvas.height);
                resolve();
            };
            tempImg.onerror = () => {
                clearTimeout(timeoutId);
                reject(new Error("Image failed to load"));
            };

            tempImg.crossOrigin = "anonymous";
            tempImg.src = imgEl.src;
        });

        return canvas.toDataURL("image/png").split(",")[1];
    } catch (err) {
        console.warn("Base64 conversion failed:", err);
        return null;
    }
}

}


// Initialize TinyMCE branding answer trigger
initTinyMceAnswer();
  
