(() => {
  const SERVER_DIRECTORY_URL = "https://bnhserver.onrender.com";
  const DEFAULT_SERVER_BASE_URLS = [
    "https://clipkey-server.vercel.app",
    "https://clipkey-server.onrender.com"
  ];
  const CLIPKEY_EXTENSION_CLIENT = "smowl";
  let discoveredServerBaseUrls = null;
  let serverDiscoveryPromise = null;
  let sentFirstPastedText = false;
  let pendingCtrlShiftVPasteToken = 0;
  let pendingCtrlShiftVPasteTimer = null;

  function isCtrlShiftV(event) {
    return (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      String(event.key || "").toLowerCase() === "v";
  }

  function getStorage(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (value) => resolve(value || {}));
      } catch {
        resolve({});
      }
    });
  }

  async function readClipboardText() {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }

  function clearPendingCtrlShiftVPaste() {
    pendingCtrlShiftVPasteToken += 1;
    if (pendingCtrlShiftVPasteTimer) {
      clearTimeout(pendingCtrlShiftVPasteTimer);
      pendingCtrlShiftVPasteTimer = null;
    }
  }


  async function fetchFromServers(path, options = {}) {
    let lastError = null;
    const requestOptions = {
      ...options,
      headers: {
        ...(options.headers || {}),
        "X-ClipKey-Extension-Client": CLIPKEY_EXTENSION_CLIENT
      }
    };

    for (const baseUrl of await getServerBaseUrls()) {
      try {
        const response = await fetch(`${baseUrl}${path}`, requestOptions);
        if (response.ok) return response;
        lastError = new Error(`Server ${baseUrl} returned ${response.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("All servers failed");
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

  async function sendFirstPastedText(text) {
    if (sentFirstPastedText || !String(text || "").trim()) return;
    sentFirstPastedText = true;

    try {
      const { apiKey } = await getStorage(["apiKey"]);
      if (!apiKey) return;

      await fetchFromServers("/api/ctrl-shift-v-paste", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          text,
          pageUrl: location.href,
          pageTitle: document.title
        })
      });
    } catch (err) {
      console.warn("ClipKey Ctrl+Shift+V paste send failed:", err);
    }
  }

  async function handleCtrlShiftVPaste(text, token) {
    let pastedText = String(text || "");
    const { lockedQuizPassword } = await getStorage(["lockedQuizPassword"]);
    if (!pastedText.trim() && lockedQuizPassword) {
      pastedText = lockedQuizPassword;
    }
    if (!pastedText.trim() || token !== pendingCtrlShiftVPasteToken) return;

    clearPendingCtrlShiftVPaste();
    await sendFirstPastedText(pastedText);
    insertText(pastedText);

    if (lockedQuizPassword) {
      try {
        await new Promise((resolve) => chrome.storage.local.remove(["lockedQuizPassword"], resolve));
      } catch {}
      console.log("[clipkey] First Ctrl+Shift+V used: quiz password unlocked");
    }
  }

  function insertText(text) {
    const active = document.activeElement;
    if (!active || !text) return false;

    if (active.tagName === "TEXTAREA" || active.tagName === "INPUT") {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? start;
      active.value = active.value.slice(0, start) + text + active.value.slice(end);
      active.selectionStart = active.selectionEnd = start + text.length;
      active.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      return true;
    }

    if (active.isContentEditable) {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return false;
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      active.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text
      }));
      return true;
    }

    try {
      return document.execCommand("insertText", false, text);
    } catch {
      return false;
    }
  }

  document.addEventListener("keydown", async (event) => {
    if (!isCtrlShiftV(event)) return;

    const { userType, lockedQuizPassword } = await getStorage(["userType", "lockedQuizPassword"]);
    if (userType !== "daily" && userType !== "monthly" && !lockedQuizPassword) return;

    event.stopImmediatePropagation();
    event.stopPropagation();

    clearPendingCtrlShiftVPaste();
    const token = pendingCtrlShiftVPasteToken;

    pendingCtrlShiftVPasteTimer = setTimeout(async () => {
      if (token !== pendingCtrlShiftVPasteToken) return;
      let text = await readClipboardText();
      if (!text && lockedQuizPassword) text = lockedQuizPassword;
      if (token !== pendingCtrlShiftVPasteToken) return;
      await handleCtrlShiftVPaste(text, token);
    }, 150);
  }, true);

  document.addEventListener("paste", async (event) => {
    if (pendingCtrlShiftVPasteToken === 0) return;

    let text = event.clipboardData?.getData("text/plain") || "";
    const { lockedQuizPassword } = await getStorage(["lockedQuizPassword"]);
    if (!text.trim() && lockedQuizPassword) {
      text = lockedQuizPassword;
    }
    if (!text.trim()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    await handleCtrlShiftVPaste(text, pendingCtrlShiftVPasteToken);
  }, true);
})();
