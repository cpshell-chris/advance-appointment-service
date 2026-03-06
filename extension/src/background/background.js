// src/background/background.js
"use strict";

const CLOUD_RUN_BASE =
  "https://advance-appointment-service-361478515851.us-east4.run.app";

  let lastSidePanelTabId = null;

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    return u.origin === new URL(CLOUD_RUN_BASE).origin;
  } catch {
    return false;
  }
}

async function safeReadBody(res) {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) {
    try {
      return await res.json();
    } catch {
      // fall through
    }
  }
  try {
    return await res.text();
  } catch {
    return null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setOptions({ path: "src/sidepanel/sidepanel.html", enabled: true })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.__aa !== true) return;

  // Proxy Cloud Run fetch for content scripts (panel.js)
  if (message.type === "CLOUDRUN_FETCH") {
    (async () => {
      try {
        const {
          url,
          method = "GET",
          headers = {},
          body = null,
          timeoutMs = 25000
        } = message.payload || {};

        if (!url || typeof url !== "string" || !isAllowedUrl(url)) {
          sendResponse({
            ok: false,
            status: 0,
            error: "Blocked request: URL is missing or not allowed."
          });
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let fetchBody = body;
        const fetchHeaders = { ...headers };

        if (body && typeof body === "object" && !(body instanceof ArrayBuffer)) {
          fetchBody = JSON.stringify(body);
          if (!fetchHeaders["Content-Type"] && !fetchHeaders["content-type"]) {
            fetchHeaders["Content-Type"] = "application/json";
          }
        }

        const res = await fetch(url, {
          method,
          headers: fetchHeaders,
          body: fetchBody ? fetchBody : undefined,
          signal: controller.signal
        });

        clearTimeout(timer);

        const data = await safeReadBody(res);

        sendResponse({
          ok: res.ok,
          status: res.status,
          data
        });
      } catch (err) {
        sendResponse({
          ok: false,
          status: 0,
          error:
            err && err.name === "AbortError"
              ? "Request timed out"
              : (err?.message || "Fetch failed")
        });
      }
    })();

    return true;
  }

    // Close Chrome side panel (requested by sidepanel UI)
if (message.type === "CLOSE_SIDE_PANEL") {
  (async () => {
    try {
      const tabId = sender?.tab?.id || lastSidePanelTabId;
      if (!tabId) {
        sendResponse({ ok: false, error: "No tabId available to close side panel" });
        return;
      }

      await chrome.sidePanel.close({ tabId });
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || "Failed to close side panel" });
    }
  })();

  return true;
}
  // Open the Chrome side panel for the current tab (must be user-gesture initiated)
  if (message.type === "OPEN_SIDE_PANEL") {
    const tabId = sender && sender.tab && sender.tab.id;
    lastSidePanelTabId = tabId;

    if (!tabId) {
      sendResponse({ ok: false, status: 0, error: "No sender tab to open side panel for." });
      return false;
    }

    chrome.sidePanel.open({ tabId }).then(
      () => sendResponse({ ok: true, status: 200 }),
      (err) =>
        sendResponse({
          ok: false,
          status: 0,
          error: err?.message || String(err || "Failed to open side panel")
        })
    );

    return true; // async response
  }
  sendResponse({ ok: false, status: 0, error: "Unknown message type" });
  return false;
});