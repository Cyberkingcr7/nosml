(() => {
  const SERVER_BASE_URLS = [
    "https://clipkey-server.onrender.com",
    "https://clipkey-server.vercel.app"
  ];

  function isCtrlShiftQ(event) {
    return (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      !event.altKey &&
      String(event.key || "").toLowerCase() === "q";
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

  function isVisibleQuestion(question) {
    const rect = question.getBoundingClientRect();
    return rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
  }

  function findCurrentQuestion() {
    const active = document.activeElement;
    const activeQuestion = active?.closest?.(".que");
    if (activeQuestion) return activeQuestion;

    let best = null;
    let bestScore = Infinity;
    const viewportCenterY = window.innerHeight / 2;
    const viewportCenterX = window.innerWidth / 2;

    document.querySelectorAll(".que").forEach((question) => {
      if (!isVisibleQuestion(question)) return;
      if (question.classList.contains("description") || question.classList.contains("informationitem")) return;

      const rect = question.getBoundingClientRect();
      const centerY = rect.top + rect.height / 2;
      const centerX = rect.left + rect.width / 2;
      const score = Math.abs(centerY - viewportCenterY) + Math.abs(centerX - viewportCenterX) * 0.25;

      if (score < bestScore) {
        best = question;
        bestScore = score;
      }
    });

    return best;
  }

  function buildQuestionStructureMeta(question, qtext) {
    if (!question || !qtext) return null;

    return {
      questionIndex: Array.from(document.querySelectorAll(".que")).indexOf(question),
      pageUrl: location.href,
      pageTitle: document.title,
      questionHtml: String(qtext.innerHTML || "").replace(/\s+/g, " ").trim().slice(0, 4000),
      nodeSummary: Array.from(qtext.querySelectorAll("*")).slice(0, 40).map((node) => ({
        tag: node.tagName?.toLowerCase() || "",
        className: typeof node.className === "string" ? node.className.slice(0, 120) : "",
        textSample: String(node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
      }))
    };
  }

  function getInstructionText(question) {
    const chunks = [];
    document.querySelectorAll(".que.description.informationitem .qtext").forEach((node) => {
      if (node.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const text = String(node.innerText || "").trim();
        if (text) chunks.push(text);
      }
    });
    return chunks.join("\n");
  }

  function dataUrlToBase64(dataUrl) {
    const text = String(dataUrl || "");
    const commaIndex = text.indexOf(",");
    return commaIndex >= 0 ? text.slice(commaIndex + 1) : text;
  }

  async function imageToBase64(img) {
    if (!img?.src) return null;

    try {
      const response = await fetch(img.src);
      const blob = await response.blob();
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(dataUrlToBase64(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  function findAnswerTarget(question) {
    const tinyFrame = question.querySelector("iframe.tox-edit-area__iframe");
    if (tinyFrame?.contentDocument?.body) return { type: "tinymce-frame", node: tinyFrame };

    const textarea = question.querySelector("textarea");
    if (textarea) return { type: "textarea", node: textarea };

    const input = question.querySelector("input[type='text'], input:not([type])");
    if (input) return { type: "input", node: input };

    const editable = question.querySelector("[contenteditable='true']");
    if (editable) return { type: "editable", node: editable };

    return null;
  }

  function insertAnswer(question, answer) {
    const target = findAnswerTarget(question);
    if (!target || !answer) return false;

    if (target.type === "tinymce-frame") {
      const body = target.node.contentDocument.body;
      body.innerHTML = answer;
      body.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertHTML",
        data: answer
      }));

      const textarea = question.querySelector("textarea[id]");
      if (textarea) {
        textarea.value = answer;
        textarea.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertHTML",
          data: answer
        }));
        textarea.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }

    if (target.type === "textarea" || target.type === "input") {
      target.node.value = answer;
      target.node.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: answer
      }));
      target.node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (target.type === "editable") {
      target.node.innerHTML = answer;
      target.node.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertHTML",
        data: answer
      }));
      return true;
    }

    return false;
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  async function answerQuestion(question) {
    const { apiKey } = await getStorage(["apiKey"]);
    if (!apiKey) return;

    const qtext = question.querySelector(".qtext") || question;
    const questionText = String(qtext.innerText || "").trim();
    const instructionText = getInstructionText(question);
    const sentences = [instructionText, questionText].map((text) => text.trim()).filter(Boolean);
    const metadata = { questionStructure: buildQuestionStructureMeta(question, qtext) };
    const image = qtext.querySelector("img");

    let answer = "";
    if (image?.src) {
      const imageData = await imageToBase64(image);
      const body = {
        apiKey,
        sentences,
        metadata
      };

      if (imageData) body.imageData = imageData;
      else body.imageUrl = image.src;

      const response = await fetchFromServers("/api/extension/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json().catch(() => ({}));
      answer = data.answer || "";
    } else {
      const response = await fetchFromServers("/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey,
          text: sentences.join(" "),
          metadata
        })
      });
      const data = await response.json().catch(() => ({}));
      answer = data?.result?.data || "";
    }

    if (!answer) return;

    const inserted = insertAnswer(question, answer);
    if (!inserted) await copyToClipboard(answer);
  }

  document.addEventListener("keydown", async (event) => {
    if (!isCtrlShiftQ(event)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    if (window.__clipkeyCtrlShiftQBusy) return;
    window.__clipkeyCtrlShiftQBusy = true;

    try {
      const question = findCurrentQuestion();
      if (question) await answerQuestion(question);
    } catch (err) {
      console.warn("ClipKey Ctrl+Shift+Q failed:", err);
    } finally {
      window.__clipkeyCtrlShiftQBusy = false;
    }
  }, true);
})();
