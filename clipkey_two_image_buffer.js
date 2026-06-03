(() => {
  const MAX_IMAGES = 2;

  function ensureImageList() {
    if (!Array.isArray(window.imageBufferList)) window.imageBufferList = [];
    return window.imageBufferList;
  }

  function rememberImage(data) {
    if (!data) return;
    const list = ensureImageList();
    const existingIndex = list.indexOf(data);
    if (existingIndex >= 0) list.splice(existingIndex, 1);
    list.push(data);
    while (list.length > MAX_IMAGES) list.shift();
    window.imageBuffer = list[list.length - 1] || null;
    console.log(`ClipKey image buffer: ${list.length}/${MAX_IMAGES}`);
  }

  function dataUrlToBase64(dataUrl) {
    const text = String(dataUrl || "");
    const commaIndex = text.indexOf(",");
    return commaIndex >= 0 ? text.slice(commaIndex + 1) : text;
  }

  async function imageToBase64(img) {
    if (!img?.src) return null;
    const response = await fetch(img.src);
    const blob = await response.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(dataUrlToBase64(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  window.addEventListener("click", async (event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;

    try {
      const base64 = await imageToBase64(target);
      rememberImage(base64);
    } catch (err) {
      console.warn("ClipKey two-image buffer failed:", err);
    }
  }, true);

  const originalStringify = JSON.stringify;
  JSON.stringify = function patchedStringify(value, replacer, space) {
    try {
      if (
        value &&
        typeof value === "object" &&
        Array.isArray(value.sentences) &&
        Object.prototype.hasOwnProperty.call(value, "imageData") &&
        !Object.prototype.hasOwnProperty.call(value, "imageDataList")
      ) {
        const list = ensureImageList().filter(Boolean).slice(-MAX_IMAGES);
        if (list.length) value.imageDataList = list;
      }
    } catch {}

    return originalStringify.call(this, value, replacer, space);
  };

  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      String(event.key || "").toLowerCase() === "x"
    ) {
      setTimeout(() => {
        window.imageBufferList = [];
      }, 5000);
    }
  }, true);
})();
