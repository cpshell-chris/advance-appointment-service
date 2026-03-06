// src/panel/panel.js
(function () {
  "use strict";

  // This file now ONLY injects a helper button into Tekmetric.
  // Clicking it sets aaContext and asks the background to open the Chrome side panel.

  const RO_ID_QUERY_PARAM = "aaRoId";
  const HELPER_BTN_ID = "aa-open-sidepanel-btn";
  const HELPER_STYLE_ID = "aa-open-sidepanel-style";

  function getRoIdFromUrl() {
    const match = window.location.pathname.match(/repair-orders\/(\d+)/);
    return match ? match[1] : null;
  }

  function getRoIdFromSchedulerQuery() {
    const params = new URLSearchParams(window.location.search);
    const roId = params.get(RO_ID_QUERY_PARAM);
    return roId && /^\d+$/.test(roId) ? roId : null;
  }

  function getCurrentRoId() {
    return getRoIdFromUrl() || getRoIdFromSchedulerQuery();
  }

  function injectHelperStyles() {
    if (document.getElementById(HELPER_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = HELPER_STYLE_ID;
    style.textContent = `

      @keyframes aaPulse {
  0% {
    box-shadow:
      0 0 0 2px rgba(249,115,22,0.10),
      0 10px 24px rgba(17,24,39,0.08);
    filter: brightness(1);
  }
  50% {
    box-shadow:
      0 0 0 4px rgba(249,115,22,0.18),
      0 14px 34px rgba(17,24,39,0.14);
    filter: brightness(1.03);
  }
  100% {
    box-shadow:
      0 0 0 2px rgba(249,115,22,0.10),
      0 10px 24px rgba(17,24,39,0.08);
    filter: brightness(1);
  }
}

      #${HELPER_BTN_ID}{
  width: 100%;
  margin-top: 0;
  padding: 9px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.2;
  border: 1px solid rgba(249,115,22,0.55);
  cursor: pointer;
  font-weight: 700;
  letter-spacing: 0.01em;

  color: #111827;
  background: rgba(249,115,22,0.12);

  animation: aaPulse 1.8s ease-in-out infinite;

  box-shadow:
    0 0 0 2px rgba(249,115,22,0.10),
    0 10px 24px rgba(17,24,39,0.08);

  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}
        

      #${HELPER_BTN_ID}:hover{
        transform: translateY(-1px);
        border-color: rgba(249,115,22,0.75);
        box-shadow:
          0 0 0 3px rgba(249,115,22,0.16),
          0 14px 30px rgba(17,24,39,0.12);
      }
          #${HELPER_BTN_ID}.aa-no-pulse{
  animation: none !important;
}

      #${HELPER_BTN_ID}:active{ transform: translateY(0px); }
    `;
    document.head.appendChild(style);
  }

  function findRepairOrderSummaryCard() {
    // Prefer heading text "Repair Order Summary"
    const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,div,span,p")).filter(
      (el) => (el.textContent || "").trim() === "Repair Order Summary"
    );

    for (const el of headings) {
      const container =
        el.closest(".MuiPaper-root") ||
        el.closest("[class*='MuiPaper']") ||
        el.closest("section") ||
        el.closest("div");
      if (container) return container;
    }

    // Fallback: green button "View & Share Invoice"
    const btns = Array.from(document.querySelectorAll("button, a")).filter((b) => {
      const t = (b.textContent || "").trim();
      return t === "View & Share Invoice" || t === "View & Share Payment" || t === "View & Share";
    });

    for (const b of btns) {
      const container =
        b.closest(".MuiPaper-root") ||
        b.closest("[class*='MuiPaper']") ||
        b.closest("section") ||
        b.closest("div");
      if (container) return container;
    }

    return null;
  }

  function isExtensionAlive() {
  try {
    return !!(chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

async function openSidePanelWithContext(roId) {
  // If this content script instance is stale (extension reloaded), do nothing.
  if (!isExtensionAlive()) return;

  // Always restart wizard at screen 1 whenever helper button is clicked
  try {
    await chrome.storage.local.remove(["aaPanelState"]);
  } catch {}

  // Write context for the side panel to read
  try {
    await chrome.storage.local.set({
      aaContext: { roId: String(roId), origin: window.location.origin }
    });
  } catch {}

  try {
    chrome.runtime.sendMessage(
      { __aa: true, type: "OPEN_SIDE_PANEL", payload: { roId: String(roId) } },
      () => {
        // swallow lastError (can happen if extension reloaded mid-flight)
        void chrome.runtime.lastError;
      }
    );
  } catch {
    // ignore (context invalidated mid-call)
  }
}

  function ensureHelperButton() {
    const roId = getCurrentRoId();
    if (!roId) return;

    injectHelperStyles();

    const card = findRepairOrderSummaryCard();
    if (!card) return;

    const existing = document.getElementById(HELPER_BTN_ID);
    if (existing) existing.remove();

    const btn = document.createElement("button");
    btn.id = HELPER_BTN_ID;
    btn.type = "button";
    btn.textContent = "Advance Appointment Scheduler";

    btn.addEventListener("click", () => {
      const currentRoId = getCurrentRoId();
      if (!currentRoId) return;
      void openSidePanelWithContext(currentRoId);
    });

    // Try to insert directly below "View & Share Invoice" button
    const greenBtn = Array.from(card.querySelectorAll("button, a")).find((b) => {
      const t = (b.textContent || "").trim();
      return t === "View & Share Invoice" || t === "View & Share Payment" || t === "View & Share";
    });

    function syncToGreenButtonSize() {
  if (!greenBtn || !(greenBtn instanceof HTMLElement)) return;

  const cs = window.getComputedStyle(greenBtn);
  // Match exact vertical size + corner radius
  btn.style.width = cs.width;
  btn.style.height = cs.height;
  btn.style.borderRadius = cs.borderRadius;

  // If the green button has a specific font size/weight, match it too
  btn.style.fontSize = cs.fontSize;
  btn.style.fontWeight = cs.fontWeight;
  btn.style.letterSpacing = cs.letterSpacing;

  // Ensure our internal padding doesn't fight the forced height
  btn.style.paddingTop = "0";
  btn.style.paddingBottom = "0";
  btn.style.display = "inline-flex";
  btn.style.alignItems = "center";
  btn.style.justifyContent = "center";
}

if (!window.__aaGreenBtnResizeBound) {
  window.__aaGreenBtnResizeBound = true;
  window.addEventListener("resize", syncToGreenButtonSize, { passive: true });
}



    const wrap = document.createElement("div");
wrap.style.padding = "10px 0 12px";
wrap.style.display = "flex";
wrap.style.justifyContent = "center";
wrap.style.boxSizing = "border-box";
wrap.appendChild(btn);

if (greenBtn && greenBtn.parentElement) {
  greenBtn.parentElement.insertAdjacentElement("afterend", wrap);
} else {
  card.appendChild(wrap);
}

syncToGreenButtonSize();

  }

  let observer = null;

  function startObserver() {
    if (observer) return;

    observer = new MutationObserver(() => {
      if (!document.getElementById(HELPER_BTN_ID)) ensureHelperButton();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setPulseEnabled(enabled) {
  const btn = document.getElementById(HELPER_BTN_ID);
  if (!btn) return;
  btn.classList.toggle("aa-no-pulse", !enabled);
}

function startSidePanelOpenWatcher() {
  // Initial state
  chrome.storage.local.get(["aaSidePanelOpen"], (res) => {
    setPulseEnabled(!res?.aaSidePanelOpen);
  });

  // React to changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes.aaSidePanelOpen) return;
    setPulseEnabled(!changes.aaSidePanelOpen.newValue);
  });
}

  ensureHelperButton();
  startObserver();
  startSidePanelOpenWatcher();
})();