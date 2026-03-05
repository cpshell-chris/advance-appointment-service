// src/background/background.js
"use strict";

const CLOUD_RUN_BASE =
  "https://advance-appointment-service-361478515851.us-east4.run.app";

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

  sendResponse({ ok: false, status: 0, error: "Unknown message type" });
  return false;
});