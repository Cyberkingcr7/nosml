var _0x24486e = typeof _0x24486e === "undefined" ? null : _0x24486e;

(() => {
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
