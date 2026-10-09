chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.set({ hotkey: "Ctrl+Shift+X" });
});

const CLIPKEY_POPUP_DISABLED_KEY = "clipkey_popup_disabled_after_ai_test";

function getLocalStorage(keys) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (value) => resolve(value || {}));
    } catch {
      resolve({});
    }
  });
}

async function isPopupDisabledAfterAiTest() {
  const stored = await getLocalStorage([CLIPKEY_POPUP_DISABLED_KEY]);
  return stored?.[CLIPKEY_POPUP_DISABLED_KEY] === true;
}

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs && tabs[0] && tabs[0].id;
    if (!tabId) return;
    chrome.tabs.sendMessage(tabId, message, () => {
      void chrome.runtime.lastError;
    });
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "show_popup_input") {
    isPopupDisabledAfterAiTest().then((disabled) => {
      if (!disabled) sendToActiveTab({ type: "clipkey_show_popup_input" });
    });
    return;
  }

  if (command === "answer_clipboard") {
    sendToActiveTab({ type: "clipkey_answer_clipboard" });
  }
});

chrome.action?.onClicked?.addListener(() => {
  isPopupDisabledAfterAiTest().then((disabled) => {
    if (!disabled) sendToActiveTab({ type: "clipkey_show_popup_input" });
  });
});
