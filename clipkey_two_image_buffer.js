(() => {
  function ensureImageList() {
    if (!Array.isArray(window.imageBufferList)) window.imageBufferList = [];
    return window.imageBufferList;
  }

  function replaceImageBuffer(dataList) {
    const list = ensureImageList();
    list.splice(0, list.length, ...[...new Set((dataList || []).filter(Boolean))]);
    window.imageBuffer = list[0] || null;
    console.log(`ClipKey question image buffer: ${list.length}`);
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
    const element = target instanceof Element ? target : target?.parentElement;
    const qtext = element?.closest?.(".qtext, .que, .question_text, .vtbegenerated, .d2l-quiz-question, [id^='question-']");
    if (!(qtext instanceof Element)) return;
    if (element.closest(".questionflag, input, textarea, button, select, iframe, [contenteditable=\"true\"]")) return;

    const images = Array.from(qtext.querySelectorAll("img")).filter((img) => img?.src);

    try {
      const base64Images = [];
      for (const img of images) {
        try {
          const base64 = await imageToBase64(img);
          if (base64) base64Images.push(base64);
        } catch (err) {
          console.warn("ClipKey question image fetch failed:", img.src, err);
        }
      }
      replaceImageBuffer(base64Images);
    } catch (err) {
      console.warn("ClipKey question image buffer failed:", err);
    }
  }, true);

  const originalStringify = JSON.stringify;
  JSON.stringify = function patchedStringify(value, replacer, space) {
    try {
      if (
        value &&
        typeof value === "object" &&
        Array.isArray(value.sentences) &&
        !Object.prototype.hasOwnProperty.call(value, "imageDataList")
      ) {
        const list = ensureImageList().filter(Boolean);
        if (list.length) {
          value.imageDataList = list;
          if (!value.imageData) value.imageData = list[0];
        }
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
