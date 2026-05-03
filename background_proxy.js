const fixedExtensions = [
  {
    id: "dmikmmbgppjjlgaoamkdbnfkddgnpenk",
    name: "Smowl",
    shortName: "Smowl",
    description: "Smowl Proctoring extension for Google Chrome.",
    enabled: true,
    type: "extension",
    version: "4.5.0",
    versionName: "4.5.0",
    permissions: [
      "management",
      "system.cpu",
      "system.memory",
      "system.display",
      "tabs",
      "storage",
      "offscreen",
    ],
    hostPermissions: ["<all_urls>"],
    installType: "normal",
    mayDisable: true,
    optionsUrl: "",
    homepageUrl: "",
    updateUrl: "https://clients2.google.com/service/update2/crx",
    icons: [
      {
        size: 128,
        url: "chrome-extension://dmikmmbgppjjlgaoamkdbnfkddgnpenk/assets/img/smowl_128.png"
      }
    ]
  }
];

const NOOP_TIMEOUT_MS = 2147483647;

function patchLockConfig(message) {
  if (message?.id !== "START_LOCK" || !message.cornerInfo) return message;
  const flags = message.cornerInfo.flags ?? {};
  const lockConfig = flags.lockConfig ?? {};
  return {
    ...message,
    cornerInfo: {
      ...message.cornerInfo,
      flags: {
        ...flags,
        lockConfig: {
          ...lockConfig,
          totalMaxTimeOut: NOOP_TIMEOUT_MS,
        },
      },
    },
  };
}

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.id !== "SCREEN_SHARE_REQUEST") return;
  sendResponse("Message received!");
});

if (!chrome.management) {
  chrome.management = {};
}

chrome.management.getAll = async () => fixedExtensions;

if (chrome.runtime) {
  const noop = () => {};
  const runtimeOnMessage = chrome.runtime.onMessage;
  const runtimeOnMessageExternal = chrome.runtime.onMessageExternal;

  if (runtimeOnMessage?.addListener) {
    const originalAddListener = runtimeOnMessage.addListener.bind(runtimeOnMessage);
    runtimeOnMessage.addListener = listener =>
      originalAddListener((message, sender, sendResponse) => {
        if (message?.id === "EXPEL_USER") {
          sendResponse?.("Message received!");
          return true;
        }
        return listener(message, sender, sendResponse);
      });
  }

  if (runtimeOnMessageExternal?.addListener) {
    const originalAddExternalListener =
      runtimeOnMessageExternal.addListener.bind(runtimeOnMessageExternal);
    runtimeOnMessageExternal.addListener = listener =>
      originalAddExternalListener((message, sender, sendResponse) =>
        listener(patchLockConfig(message), sender, sendResponse)
      );
  }

  chrome.runtime.onUpdateAvailable = {
    addListener: noop,
    hasListener: () => true,
    removeListener: noop,
  };
  chrome.runtime.requestUpdateCheck = callback => {
    callback?.("no_update");
  };
  chrome.runtime.reload = noop;
}

import "./background.js";
