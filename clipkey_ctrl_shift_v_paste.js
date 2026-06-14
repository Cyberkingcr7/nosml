(() => {
  const SERVER_BASE_URLS = [
    "https://clipkey-server.onrender.com",
    "https://clipkey-server.vercel.app"
  ];
  let sentFirstPastedText = false;

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


  async function fetchFromServers(path, options = {}) {
    let lastError = null;

    for (const baseUrl of SERVER_BASE_URLS) {
      try {
        const response = await fetch(`${baseUrl}${path}`, options);
        if (response.ok) return response;
        lastError = new Error(`Server ${baseUrl} returned ${response.status}`);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("All servers failed");
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

    const { userType } = await getStorage(["userType"]);
    if (userType !== "daily" && userType !== "monthly") return;

    event.preventDefault();
    event.stopPropagation();
     const text = await readClipboardText();
  sendFirstPastedText(text);
  insertText(text);
  }, true);
})();
