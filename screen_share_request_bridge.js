let creatingOffscreenDocument = null;

async function ensureScreenShareOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL("assets/offscreen.html");
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length) return;
  if (creatingOffscreenDocument) {
    await creatingOffscreenDocument;
    return;
  }

  creatingOffscreenDocument = chrome.offscreen.createDocument({
    url: "assets/offscreen.html",
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC"],
    justification: "Open the screen sharing prompt requested by the monitoring page.",
  }).catch(async (error) => {
    const message = String(error?.message || error || "");
    if (!/single offscreen document/i.test(message)) throw error;

    const retryContexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    if (!retryContexts.length) throw error;
  });

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = null;
  }
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.id !== "SCREEN_SHARE_REQUEST") return false;

  (async () => {
    try {
      await ensureScreenShareOffscreenDocument();
      await chrome.runtime.sendMessage({
        id: "SHOW_SCREEN_SHARE_PROMPT",
        target: "offscreen",
      }).catch(() => null);
      sendResponse("Message received!");
    } catch {
      sendResponse("Message received!");
    }
  })();

  return true;
});
