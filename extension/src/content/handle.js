(function () {
  "use strict";

  if (!window.AA) window.AA = {};

  const HANDLE_ID = "aa-panel-handle";
  const HANDLE_STYLE_ID = "aa-panel-handle-style";

  function injectHandleStyles() {
    if (document.getElementById(HANDLE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HANDLE_STYLE_ID;
    style.textContent = `
      #${HANDLE_ID} {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        z-index: 1000000;
        border: none;
        background: #111827;
        color: #fff;
        padding: 10px 10px;
        border-radius: 12px 0 0 12px;
        cursor: pointer;
        font-family: -apple-system, BlinkMacSystemFont, "DM Sans", system-ui, sans-serif;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: -0.01em;
        display: flex;
        align-items: center;
        gap: 8px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.18);
        opacity: 0.94;
        transition: transform 0.18s ease, opacity 0.18s ease, background 0.18s ease;
      }

      #${HANDLE_ID}:hover {
        opacity: 1;
        background: #1f2937;
        transform: translateY(-50%) translateX(-2px);
      }

      #${HANDLE_ID} .aa-dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: #22c55e;
        box-shadow: 0 0 0 3px rgba(34,197,94,0.18);
      }

      #${HANDLE_ID}[data-open="1"] .aa-dot {
        background: #60a5fa;
        box-shadow: 0 0 0 3px rgba(96,165,250,0.18);
      }

      #${HANDLE_ID} .aa-label {
        white-space: nowrap;
      }

      #${HANDLE_ID} .aa-icon {
        font-size: 14px;
        line-height: 1;
        margin-left: 2px;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureHandle() {
    injectHandleStyles();

    let btn = document.getElementById(HANDLE_ID);
    if (btn) return btn;

    btn = document.createElement("button");
    btn.id = HANDLE_ID;
    btn.type = "button";
    btn.innerHTML = `
      <span class="aa-dot"></span>
      <span class="aa-label">Advance</span>
      <span class="aa-icon">›</span>
    `;

    btn.addEventListener("click", () => {
      const isOpen = window.AA.isPanelMounted && window.AA.isPanelMounted();
      if (isOpen) {
        window.AA.hidePanel && window.AA.hidePanel();
      } else {
        window.AA.showPanel && window.AA.showPanel();
      }
      syncHandleState();
    });

    document.body.appendChild(btn);
    syncHandleState();
    return btn;
  }

  function syncHandleState() {
    const btn = document.getElementById(HANDLE_ID);
    if (!btn) return;

    const isOpen = window.AA.isPanelMounted && window.AA.isPanelMounted();
    btn.setAttribute("data-open", isOpen ? "1" : "0");

    const icon = btn.querySelector(".aa-icon");
    if (icon) icon.textContent = isOpen ? "‹" : "›";

    const label = btn.querySelector(".aa-label");
    if (label) label.textContent = isOpen ? "Close" : "Advance";
  }

  function startSyncLoop() {
    // Keep the handle state accurate if panel is opened by routeWatcher or persisted state.
    setInterval(syncHandleState, 500);
  }

  // Expose helpers if you want them
  window.AA.ensureHandle = ensureHandle;
  window.AA.syncHandleState = syncHandleState;

  // Boot
  ensureHandle();
  startSyncLoop();
})();