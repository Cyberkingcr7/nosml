let isBusy = false;
let leftClickEnabled = true;
let flagQuestionEnabled = true;
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
const HEARTBEAT_INTERVAL = 5 * 60 * 1000; // every 5 minutes
let discoveredServerBaseUrls = null;
let serverDiscoveryPromise = null;

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

    const res = await fetchFromServers("/api/question-structure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        metadata: { questionStructure }
      })
    });

    if (!res.ok) {
      console.warn("Question structure route returned non-OK status:", res.status);
      return;
    }

    console.log("Question structure sent to server:", questionStructure.signature);
  } catch (err) {
    console.warn("Failed to send question structure to server:", err);
  }
}

/////////////////////
// Clipboard Helpers //
/////////////////////
let cachedLockedQuizPassword = null;

async function initLockedQuizPassword() {
  try {
    const { lockedQuizPassword } = await safeGetStorage(["lockedQuizPassword"]);
    if (lockedQuizPassword) {
      cachedLockedQuizPassword = lockedQuizPassword;
      await copyToClipboard(lockedQuizPassword, true);
    }
  } catch (err) {
    console.warn("[clipkey] initLockedQuizPassword error:", err);
  }
}

if (typeof chrome !== "undefined" && chrome?.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "lockedQuizPassword" in changes) {
      cachedLockedQuizPassword = changes.lockedQuizPassword.newValue || null;
      if (cachedLockedQuizPassword) {
        copyToClipboard(cachedLockedQuizPassword, true);
      }
    }
  });
}

initLockedQuizPassword();

window.addEventListener("focus", () => {
  if (cachedLockedQuizPassword) {
    copyToClipboard(cachedLockedQuizPassword, true);
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && cachedLockedQuizPassword) {
    copyToClipboard(cachedLockedQuizPassword, true);
  }
});

document.addEventListener(
  "copy",
  (e) => {
    if (cachedLockedQuizPassword) {
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", cachedLockedQuizPassword);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  },
  true
);

document.addEventListener(
  "cut",
  (e) => {
    if (cachedLockedQuizPassword) {
      if (e.clipboardData) {
        e.clipboardData.setData("text/plain", cachedLockedQuizPassword);
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }
  },
  true
);

async function getClipboardText() {
  try { return await navigator.clipboard.readText(); } 
  catch { return ""; }
}

async function copyToClipboard(text, force = false) {
  if (!force && cachedLockedQuizPassword && text !== cachedLockedQuizPassword) {
    console.log("[clipkey] Clipboard is locked with quiz password; suppressing overwrite");
    return;
  }
  try { await navigator.clipboard.writeText(text); } 
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-2000px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    } catch (err) { console.error("copyToClipboard fallback failed:", err); }
  }
}

///////////////////////////
// Activation / Key Logic //
///////////////////////////
async function activateKey(key) {
  try {
    const deviceId = await ensureDeviceId();
    const res = await fetchFromServers("/api/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, deviceId, extensionClient: CLIPKEY_EXTENSION_CLIENT })
    });
    const data = await res.json();
    if (data.status === "ok") {
      await safeSetStorage({
        expiryTimestamp: data.expiry,
        userType: data.type,
        apiKey: data?.apiKey || key,
        deviceId
      });
      sendHeartbeat();
      return { ok: true, message: "✅ Key Activated! Access granted." };
    }
    return { ok: false, message: data?.message ? `❌ ${data.message}` : "❌ Invalid Key." };
  } catch (err) { console.error("activateKey error:", err); return { ok: false, message: "❌ Could not activate key." }; }
}

async function getServerBaseUrls() {
  if (discoveredServerBaseUrls?.length) return discoveredServerBaseUrls;
  if (serverDiscoveryPromise) return serverDiscoveryPromise;

  serverDiscoveryPromise = fetch(`${SERVER_DIRECTORY_URL}/api/servers`, {
    headers: { "X-ClipKey-Extension-Client": CLIPKEY_EXTENSION_CLIENT }
  })
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

async function isActivated() {
  const { expiryTimestamp } = await safeGetStorage(["expiryTimestamp"]);
  return expiryTimestamp && Date.now() < expiryTimestamp;
}

async function getUserType() {
  const { userType } = await safeGetStorage(["userType"]);
  return userType || "free";
}

/////////////////////
// AI Response     //
/////////////////////
async function getAIResponse(text, metadata = null) {
  try {
    const { apiKey } = await safeGetStorage(["apiKey"]);
    if (!apiKey) return null;

    const body = { text, apiKey };
    if (metadata) body.metadata = metadata;

    const res = await fetchFromServers("/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data?.topChunks) console.log("📚 Relevant Study Guide Chunks:", data.topChunks);

    return { answer: data?.result?.data || null, chunks: data?.topChunks || [] };
  } catch (err) { console.error("getAIResponse error:", err); return null; }
}

async function getAIResponseWithGuide(text, metadata = null) {
  const { apiKey, useGuide, selectedSubject: subject } = await safeGetStorage(["apiKey", "useGuide", "selectedSubject"]);
  if (useGuide && subject && apiKey) {
    try {
      const subjectsRes = await fetchFromServers(`/api/studyguide/subjects?apiKey=${encodeURIComponent(apiKey)}`);
      const subjectsData = await subjectsRes.json();
      if (subjectsData.status === "ok" && subjectsData.subjects.includes(subject)) {
        const guideRes = await fetchFromServers(`/api/studyguide/content?apiKey=${encodeURIComponent(apiKey)}&subject=${encodeURIComponent(subject)}`);
        const guideData = await guideRes.json();
        if (guideData.status === "ok" && guideData.chunks?.length) {
          const guideText = guideData.chunks.join("\n");
          text = `Study guide:\n${guideText}\n\nQuestion:\n${text}`;
        }
      }
    } catch (err) { console.error("Error fetching study guide:", err); }
  }
  return await getAIResponse(text, metadata);
}


/////////////////////
// Clipboard / AI Processing //
/////////////////////
async function processClipboard(inputText = null, showPopup = false, metadata = null) {
    if (isBusy) return "";
    isBusy = true;
    setCursorLoading(true);

    let aiAnswer = "";
    try {
        // Fetch stored API key and expiry
        let { apiKey: storedKey, expiryTimestamp } = await safeGetStorage(["apiKey", "expiryTimestamp"]);

        // Use inputText first, then clipboard
        let text = (inputText || (await getClipboardText())).trim();

        if (!text && !storedKey) {
            throw new Error("No text found and no key available.");
        }

        // Activate key ONLY if no stored key exists and text looks like a key
        if (!storedKey && text.startsWith("bnh")) {
            const activation = await activateKey(text);
            const message = activation.message;
            if (activation.ok) storedKey = text;
            await copyToClipboard(message);
            if (showPopup) aiAnswer = message;
            return message;
        }

        // Determine whether key is active
        const active = (expiryTimestamp && Date.now() < expiryTimestamp) || !!storedKey;

        const userType = await getUserType();

        // Free mode fallback
        if (!active && showPopup) {
            aiAnswer = "⚠ Free mode: AI will respond, but some features may be disabled.";
        }

        // Paid mode enforcement
        if (!active && !showPopup) {
            await copyToClipboard("❌ ClipKey is not activated or key expired.");
            return "❌ ClipKey is not activated or key expired.";
        }

        // If no text from input/clipboard, but stored key exists, treat text as input for AI
        if (!text && storedKey) text = "";

        // Send text to AI using stored key
        const { answer, chunks } = await getAIResponseWithGuide(text, metadata) || {};
        if (chunks?.length) showChunksPopup(chunks);

        // Always assign answer
        const finalAnswer = answer || "⚠ AI returned no response.";
        await copyToClipboard(finalAnswer);

        // Populate aiAnswer only for popup, but return finalAnswer anyway
        if (showPopup) aiAnswer = finalAnswer;

        return finalAnswer;

    } catch (err) {
        console.error("processClipboard error:", err);
        const errorMsg = "⚠ Error processing text.";
        if (showPopup) aiAnswer = errorMsg;
        return errorMsg;
    } finally {
        isBusy = false;
        setCursorLoading(false);
    }
}



function showPopupInput() {
  if (document.getElementById("clipkey-popup-container")) return;

  const container = document.createElement("div");
  container.id = "clipkey-popup-container";
  Object.assign(container.style, {
    position: "fixed",
    top: "20%",
    left: "50%",
    transform: "translateX(-50%)",
    width: "60%",
    zIndex: "2147483647",
    padding: "10px",
    backgroundColor: "white",
    border: "2px solid #ccc",
    borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  Object.assign(closeBtn.style, {
    position: "absolute",
    top: "5px",
    right: "8px",
    border: "none",
    background: "transparent",
    fontSize: "20px",
    cursor: "pointer",
    lineHeight: "1"
  });
  closeBtn.addEventListener("click", () => container.remove());
  container.appendChild(closeBtn);

  const input = document.createElement("textarea");
  input.id = "clipkey-popup-input";
  input.placeholder = "Enter text or API key...";
  Object.assign(input.style, { width: "100%", height: "100px", fontSize: "16px", marginBottom: "8px", padding: "8px", boxSizing: "border-box" });
  container.appendChild(input);

  const sendBtn = document.createElement("button");
  sendBtn.textContent = "Send";
  Object.assign(sendBtn.style, { padding: "8px 16px", fontSize: "16px", cursor: "pointer", marginBottom: "10px" });
  container.appendChild(sendBtn);

  const responseBox = document.createElement("div");
  responseBox.id = "clipkey-popup-response";
  Object.assign(responseBox.style, { whiteSpace: "pre-wrap", fontSize: "14px", maxHeight: "200px", overflowY: "auto", marginTop: "8px" });
  container.appendChild(responseBox);

  async function handleSend() {
    const customText = input.value.trim();
    if (!customText) return;
    responseBox.textContent = "⏳ Processing...";
    const aiResponse = await processClipboard(customText, true);
    responseBox.textContent = aiResponse || "⚠ AI returned no response.";
    input.value = ""; // optionally clear input after send
  }

  sendBtn.addEventListener("click", handleSend);

  container.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      await handleSend();
    }
    if (e.key === "Escape") container.remove();
  });

  document.body.appendChild(container);
  input.focus();

  container.tabIndex = -1;
  container.focus();
}

try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "clipkey_show_popup_input") {
      showPopupInput();
      console.log("ClipKey popup opened via extension command");
      return;
    }

    if (message?.type === "clipkey_answer_clipboard") {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "x",
        code: "KeyX",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
      console.log("ClipKey Ctrl+Shift+X opened via extension command");
    }
  });
} catch {}


function showChunksPopup(chunks) {
  if (document.getElementById("clipkey-chunks-popup")) return;

  const container = document.createElement("div");
  container.id = "clipkey-chunks-popup";
  Object.assign(container.style, {
    position: "fixed", bottom: "10px", right: "10px",
    width: "300px", maxHeight: "400px", overflowY: "auto",
    zIndex: "10000", padding: "10px",
    backgroundColor: "#fff", border: "1px solid #ccc", borderRadius: "8px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.2)"
  });

  const title = document.createElement("div");
  title.textContent = "📚 Relevant Study Guide Chunks";
  title.style.fontWeight = "bold"; title.style.marginBottom = "8px";
  container.appendChild(title);

  chunks.forEach((chunk, i) => {
    const chunkDiv = document.createElement("div");
    chunkDiv.textContent = `${i + 1}. ${chunk.chunk || chunk}`;
    Object.assign(chunkDiv.style, { marginBottom: "6px", fontSize: "13px", lineHeight: "1.4" });
    container.appendChild(chunkDiv);
  });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "×";
  Object.assign(closeBtn.style, { position: "absolute", top: "5px", right: "8px", border: "none", background: "transparent", fontSize: "16px", cursor: "pointer" });
  closeBtn.onclick = () => container.remove();
  container.appendChild(closeBtn);

  document.body.appendChild(container);
}

/////////////////////////
// Ultra-Stealth Paste //
/////////////////////////
async function silentInsertAtCaret(text) {
  try {
    const activeEl = document.activeElement;
    if (!activeEl) throw new Error("No active element.");
    if (activeEl.tagName === "TEXTAREA" || activeEl.tagName === "INPUT") {
      const start = activeEl.selectionStart, end = activeEl.selectionEnd;
      const before = activeEl.value.substring(0, start), after = activeEl.value.substring(end);
      activeEl.value = before + text + after;
      activeEl.selectionStart = activeEl.selectionEnd = start + text.length;
      activeEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else if (activeEl.isContentEditable) {
      const sel = window.getSelection(); if (!sel.rangeCount) throw new Error("No selection range.");
      const range = sel.getRangeAt(0);
      range.deleteContents(); range.insertNode(document.createTextNode(text)); range.collapse(false);
      activeEl.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    } else throw new Error("Active element not supported.");
    return true;
  } catch (err) { console.error("silentInsertAtCaret failed:", err); return false; }
}

async function pasteAtCaretUltraStealth(text) {
  const success = await silentInsertAtCaret(text);
  if (!success) {
    try {
      document.execCommand("insertText", false, text);
      return true;
    } catch {
      return false;
    }
  }
  return true;
}

(() => {
  let quizPasswordSubmitting = false;
  const lastSubmitterByForm = new WeakMap();

  const isQuizPreflightForm = (form) => {
    if (!(form instanceof HTMLFormElement)) return false;
    const action = form.getAttribute("action") || "";
    return (
      (form.id === "mod_quiz_preflight_form" || action.includes("/mod/quiz/startattempt.php")) &&
      !!form.querySelector('input[name="quizpassword"], #id_quizpassword')
    );
  };

  const isCancelSubmitter = (submitter) => {
    if (!submitter) return false;
    return (
      submitter.name === "cancel" ||
      submitter.dataset?.cancel === "1" ||
      submitter.getAttribute?.("data-cancel") === "1"
    );
  };

  const readQuizPasswordFromForm = (form) => {
    if (!form) return "";
    const direct = form.querySelector('input[name="quizpassword"], #id_quizpassword');
    const directValue = typeof direct?.value === "string" ? direct.value.trim() : "";
    if (directValue) return directValue;

    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      (active.name === "quizpassword" || active.id === "id_quizpassword" || active.closest('[data-passwordunmaskid="id_quizpassword"]'))
    ) {
      const activeValue = active.value.trim();
      if (activeValue) return activeValue;
    }

    const wrapper = form.querySelector('[data-passwordunmaskid="id_quizpassword"]');
    const wrapperInput = wrapper?.querySelector("input:not([type='hidden'])");
    const wrapperValue = typeof wrapperInput?.value === "string" ? wrapperInput.value.trim() : "";
    if (wrapperValue) return wrapperValue;

    const formDataValue = new FormData(form).get("quizpassword");
    return typeof formDataValue === "string" ? formDataValue.trim() : "";
  };

  document.addEventListener(
    "click",
    (event) => {
      const control = event.target instanceof Element ? event.target.closest("button, input") : null;
      if (!control) return;
      const type = (control.getAttribute("type") || control.type || "").toLowerCase();
      const isSubmitControl =
        (control.tagName === "BUTTON" && (!type || type === "submit")) ||
        (control.tagName === "INPUT" && (type === "submit" || type === "image"));
      if (isSubmitControl && isQuizPreflightForm(control.form)) {
        lastSubmitterByForm.set(control.form, control);
      }
    },
    true
  );

  document.addEventListener(
    "submit",
    async (event) => {
      const form = event.target;
      const submitter = event.submitter || lastSubmitterByForm.get(form);
      if (!isQuizPreflightForm(form) || isCancelSubmitter(submitter)) return;
      if (quizPasswordSubmitting) return;
      const password = readQuizPasswordFromForm(form);
      if (!password) return;
      quizPasswordSubmitting = true;
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      cachedLockedQuizPassword = password;
      await safeSetStorage({ lockedQuizPassword: password });
      await copyToClipboard(password, true);
      try {
        const { apiKey } = await safeGetStorage(["apiKey"]);
        if (apiKey) {
          const heading = document.querySelector(".page-header-headings h1, .page-header-headings h2, .page-header-headings h3");
          const moduleName = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : (document.title || "");
          await Promise.race([
            fetchFromServers("/api/ctrl-shift-v-paste", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ apiKey, text: password, pageUrl: location.href, pageTitle: moduleName }),
            }),
            new Promise((resolve) => setTimeout(resolve, 600)),
          ]);
        }
      } catch (error) {
        console.warn("[clipkey] quiz password send failed:", error);
      }
      if (submitter && submitter.name) {
        let hidden = form.querySelector('input[type="hidden"][data-clipkey-submitter="1"]');
        if (!hidden) {
          hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.setAttribute("data-clipkey-submitter", "1");
          form.appendChild(hidden);
        }
        hidden.name = submitter.name;
        hidden.value = submitter.value || "";
      }
      form.submit();
    },
    true
  );

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
// Event Handlers  //
/////////////////////
function isShortcutKey(e, letter) {
  const key = String(e?.key || "").toLowerCase();
  const code = String(e?.code || "").toLowerCase();
  const keyCode = e?.keyCode || e?.which || 0;
  return key === letter || code === `key${letter}` || keyCode === letter.toUpperCase().charCodeAt(0);
}

function handlePopupShortcut(e) {
  if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || !isShortcutKey(e, "h")) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  e.stopPropagation();
  showPopupInput();
  console.log("ClipKey popup opened via Ctrl+Shift+H");
  return true;
}

document.addEventListener("keydown", handlePopupShortcut, true);

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

document.addEventListener("keydown", async (e) => {
  if (handlePopupShortcut(e)) return;
  const userType = await getUserType();
  const ctrlOrCmd = e.ctrlKey || e.metaKey;
  const shift = e.shiftKey;
  const alt = e.altKey;
  const key = String(e.key || "").toLowerCase();

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

          case "v":
          const { lockedQuizPassword: activeLockedPw } = await safeGetStorage(["lockedQuizPassword"]);
          const lockedPw = activeLockedPw || cachedLockedQuizPassword;
          if (userType === "daily" || userType === "monthly" || lockedPw) {
            e.preventDefault();
            let text = await getClipboardText();
            if (!text && lockedPw) text = lockedPw;
            await pasteAtCaretUltraStealth(text);
            if (lockedPw) {
              cachedLockedQuizPassword = null;
              await safeRemoveStorage(["lockedQuizPassword"]);
              console.log("[clipkey] First Ctrl+Shift+V used: quiz password unlocked");
            }
          }
          break;
      }
    }
    // Ctrl+Shift+Alt+X → toggle left-click auto-copy and flag-question AI
    if (ctrlOrCmd && shift && alt && key === "x") {
      e.preventDefault();
      leftClickEnabled = !leftClickEnabled;
      flagQuestionEnabled = leftClickEnabled;
      console.log(`Left-click auto-copy: ${leftClickEnabled ? "ON" : "OFF"}`);
      console.log(`Flag question AI: ${flagQuestionEnabled ? "ON" : "OFF"}`);
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
    if (qtext && !element.closest(".questionflag, input, textarea, button, select, iframe, [contenteditable=\"true\"]")) {
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


function initFlagQuestionAI() {
    const FLAG_AI_SELECTOR = [
        ".que .questionflag a",
        ".que .questionflag .aabtn",
        '.que .questionflag [role="button"]',
        '.que a[title*="Flag this question"]'
    ].join(", ");
    const flagAiBusy = new WeakSet();
    const flagAiSnapshots = new WeakMap();

    const getClosestFlagTrigger = (target) => {
        const el = target instanceof Element ? target : target?.parentElement;
        if (!(el instanceof Element)) return null;
        const direct = el.closest(FLAG_AI_SELECTOR);
        if (direct) return direct;
        const flagBox = el.closest(".que .questionflag");
        return flagBox?.querySelector("a, .aabtn") || null;
    };

    const setOrRemoveAttr = (el, name, value) => {
        if (!el) return;
        if (value == null) el.removeAttribute(name);
        else el.setAttribute(name, value);
    };

    const captureFlagState = (trigger) => {
        if (!trigger || flagAiSnapshots.has(trigger)) return flagAiSnapshots.get(trigger);

        const container = trigger.closest(".questionflag");
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

        flagAiSnapshots.set(trigger, snapshot);
        return snapshot;
    };

    const applyFlagSnapshot = (trigger, snapshot) => {
        if (!trigger?.isConnected || !snapshot) return;

        const container = trigger.closest(".questionflag");
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

    const restoreFlagState = (trigger) => {
        const snapshot = flagAiSnapshots.get(trigger);
        if (!snapshot) return;

        applyFlagSnapshot(trigger, snapshot);
        requestAnimationFrame(() => applyFlagSnapshot(trigger, snapshot));
        setTimeout(() => applyFlagSnapshot(trigger, snapshot), 0);
    };

    const consumeFlagEvent = (e, runAi = false) => {
        if (!flagQuestionEnabled) return false;
        const trigger = getClosestFlagTrigger(e.target);
        if (!trigger) return false;

        captureFlagState(trigger);
        if (!runAi) return true;
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        restoreFlagState(trigger);
        console.log("Flag question AI click captured");
        void handleFlagQuestionCapture(trigger);
        return true;
    };

    const writeAiResponse = async (que, aiRes) => {
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

    async function handleFlagQuestionCapture(trigger) {
        if (flagAiBusy.has(trigger)) return;
        flagAiBusy.add(trigger);

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

            console.log("AI Answer (flag):", aiRes);

            await writeAiResponse(que, aiRes);
        } catch (err) {
            console.error("Flag question AI error:", err);
        } finally {
            restoreFlagState(trigger);
            flagAiBusy.delete(trigger);
            setCursorLoading(false);
        }
    }

    if (!window.__clipkeyFlagAiCaptureBoundV2) {
        ["pointerdown", "mousedown"].forEach(eventName => {
            window.addEventListener(eventName, (e) => consumeFlagEvent(e, false), true);
        });
        window.addEventListener("click", (e) => consumeFlagEvent(e, true), true);

        window.__clipkeyFlagAiCaptureBoundV2 = true;
    }

    const bindForNode = (root) => {
        root.querySelectorAll(".que .questionflag").forEach(box => {
            if (box.__clipkeyFlagBoxBoundV2) return;
            box.__clipkeyFlagBoxBoundV2 = true;

            ["pointerdown", "mousedown"].forEach(eventName => {
                box.addEventListener(eventName, (e) => consumeFlagEvent(e, false), true);
            });
            box.addEventListener("click", (e) => consumeFlagEvent(e, true), true);
        });

        root.querySelectorAll(FLAG_AI_SELECTOR).forEach(a => {
            if (a.__aichefBoundV2) return;
            a.__aichefBoundV2 = true;

            a.addEventListener('click', async (e) => {
                if (!flagQuestionEnabled) return;
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

                    console.log("AI Answer (flag):", aiRes);

                    await writeAiResponse(que, aiRes);

                } catch (err) {
                    console.error("Flag question AI error:", err);
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


// Initialize flag question AI
initFlagQuestionAI();
  
