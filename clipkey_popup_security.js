(() => {
  let ctrlShiftHEnabled = true;

  function isCtrlShiftH(event) {
    return (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      String(event.key || "").toLowerCase() === "h";
  }

  function isCtrlShiftAltX(event) {
    return (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.altKey &&
      String(event.key || "").toLowerCase() === "x";
  }

  function updateMask(input) {
    if (!input) return;

    const value = String(input.value || "").trim().toLowerCase();
    const shouldMask = value.startsWith("bnh");
    input.style.webkitTextSecurity = shouldMask ? "disc" : "";
    input.style.textSecurity = shouldMask ? "disc" : "";
  }

  function securePopupInput(root = document) {
    const input = root.querySelector?.("#clipkey-popup-input");
    if (!input || input.__clipkeyPopupSecurityBound) return;

    input.__clipkeyPopupSecurityBound = true;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("spellcheck", "false");
    input.addEventListener("input", () => updateMask(input));
    input.addEventListener("paste", () => setTimeout(() => updateMask(input), 0));
    updateMask(input);
  }

  window.addEventListener("keydown", (event) => {
    if (isCtrlShiftAltX(event)) {
      ctrlShiftHEnabled = !ctrlShiftHEnabled;
      console.log(`Ctrl+Shift+H popup: ${ctrlShiftHEnabled ? "ON" : "OFF"}`);
      return;
    }

    if (isCtrlShiftH(event) && !ctrlShiftHEnabled) {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  }, true);

  document.addEventListener("keydown", (event) => {
    if (isCtrlShiftH(event)) setTimeout(() => securePopupInput(document), 0);
  }, true);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) securePopupInput(node);
      }
    }
  });

  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  securePopupInput(document);
})();
