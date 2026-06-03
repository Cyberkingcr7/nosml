var _0x24486e = typeof _0x24486e === "undefined" ? null : _0x24486e;

(() => {
  const renderBaseUrl = "https://clipkey-server.onrender.com";
  const vercelBaseUrl = "https://clipkey-server.vercel.app";

  if (!window.__clipkeyRenderFetchBridge && typeof window.fetch === "function") {
    window.__clipkeyRenderFetchBridge = true;
    const originalFetch = window.fetch.bind(window);
    const rewriteInput = (input) => {
      try {
        if (typeof input === "string") {
          return input.startsWith(vercelBaseUrl)
            ? input.replace(vercelBaseUrl, renderBaseUrl)
            : input;
        }

        if (input instanceof URL) {
          return input.href.startsWith(vercelBaseUrl)
            ? new URL(input.href.replace(vercelBaseUrl, renderBaseUrl))
            : input;
        }

        if (typeof Request !== "undefined" && input instanceof Request && input.url.startsWith(vercelBaseUrl)) {
          return new Request(input.url.replace(vercelBaseUrl, renderBaseUrl), input);
        }
      } catch {}
      return input;
    };

    window.fetch = (input, init) => originalFetch(rewriteInput(input), init);
  }

  const syncApiKey = () => {
    try {
      chrome?.storage?.local?.get?.(["apiKey"], (items) => {
        _0x24486e = items?.apiKey || null;
      });
    } catch {}
  };

  syncApiKey();

  try {
    chrome?.storage?.onChanged?.addListener?.((changes, areaName) => {
      if (areaName === "local" && changes.apiKey) {
        _0x24486e = changes.apiKey.newValue || null;
      }
    });
  } catch {}
})();
