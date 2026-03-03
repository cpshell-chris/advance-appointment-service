/*
 * panel.js
 *
 * Non-invasive enhancement for Tekmetric Schedule (Screen 2):
 * shows "X booked" beneath each time option.
 *
 * Backend dependency:
 *   GET /appointments/slot-counts?shopId=<id>&date=YYYY-MM-DD
 *
 * Response shape:
 *   { success: true, date: "YYYY-MM-DD", slotCounts: { "8:00 AM": 1, ... } }
 */

(() => {
  "use strict";

  const API_BASE =
    window.ADVANCE_APPOINTMENT_SERVICE_URL ||
    "https://advance-appointment-service.onrender.com";

  const CLS_BOOKED = "aa-booked-count";
  const ATTR_ENHANCED = "data-aa-booked-enhanced";
  const ATTR_TIME_LABEL = "data-aa-time-label";
  const REFRESH_DELAY_MS = 200;

  let observer;
  let refreshTimer;
  let lastFetchKey = "";
  let cachedCounts = {};

  function ensureStyles() {
    if (document.getElementById("aa-booked-count-style")) return;

    const style = document.createElement("style");
    style.id = "aa-booked-count-style";
    style.textContent = `
      button[${ATTR_ENHANCED}="1"] {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        line-height: 1.1;
      }

      .${CLS_BOOKED} {
        margin-top: 2px;
        font-size: 10px;
        font-weight: 500;
        opacity: 0.78;
        white-space: nowrap;
        pointer-events: none;
      }

      button[aria-pressed="true"] .${CLS_BOOKED},
      button[class*="selected"] .${CLS_BOOKED} {
        opacity: 0.96;
      }
    `;

    document.head.appendChild(style);
  }

  function toDateKey(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function getShopId() {
    const pathMatch = window.location.pathname.match(/\/admin\/shop\/(\d+)\//);
    if (pathMatch) return pathMatch[1];

    const qs = new URLSearchParams(window.location.search);
    return qs.get("shopId") || qs.get("shop") || null;
  }

  function getDisplayedDate() {
    // Looks for "Jun 30, 2026" in the appointment panel text.
    const panel =
      document.querySelector("[data-testid='appointment-details']") ||
      document.querySelector("aside") ||
      document.querySelector("[role='complementary']");

    if (!panel) return null;

    const text = panel.textContent || "";
    const match = text.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
    if (!match) return null;

    return toDateKey(match[1]);
  }

  function normalizeTimeLabel(raw) {
    if (!raw) return null;

    const text = raw.replace(/\s+/g, " ").trim().toUpperCase();
    const m = text.match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/);
    if (!m) return null;

    let hour = Number(m[1]);
    const min = Number(m[2]);
    const ampm = m[3];

    if (!Number.isFinite(hour) || !Number.isFinite(min)) return null;

    if (hour === 12 && ampm === "AM") hour = 0;
    if (hour !== 12 && ampm === "PM") hour += 12;

    const d = new Date();
    d.setHours(hour, min, 0, 0);

    let outH = d.getHours();
    const outM = d.getMinutes();
    const outA = outH >= 12 ? "PM" : "AM";

    outH %= 12;
    if (outH === 0) outH = 12;

    return `${outH}:${String(outM).padStart(2, "0")} ${outA}`;
  }

  function findTimeLabelInText(text) {
    if (!text) return null;
    const m = text.match(/\b\d{1,2}:\d{2}\s*[AP]M\b/i);
    return m ? normalizeTimeLabel(m[0]) : null;
  }

  function getTimeButtons() {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons
      .map((button) => {
        const timeLabel = findTimeLabelInText(button.textContent || "");
        if (!timeLabel) return null;
        return { button, timeLabel };
      })
      .filter(Boolean);
  }

  function ensureBookedNode(button, timeLabel) {
    button.setAttribute(ATTR_ENHANCED, "1");
    button.setAttribute(ATTR_TIME_LABEL, timeLabel);

    let node = button.querySelector(`.${CLS_BOOKED}`);
    if (!node) {
      node = document.createElement("span");
      node.className = CLS_BOOKED;
      node.textContent = "0 booked";
      button.appendChild(node);
    }

    return node;
  }

  function renderCounts(slotCounts) {
    const entries = getTimeButtons();

    for (const { button, timeLabel } of entries) {
      const countNode = ensureBookedNode(button, timeLabel);
      const count = Number(slotCounts?.[timeLabel] ?? 0);
      countNode.textContent = `${Number.isFinite(count) ? count : 0} booked`;
    }
  }

  async function fetchSlotCounts(shopId, date) {
    const url = new URL(`${API_BASE}/appointments/slot-counts`);
    url.searchParams.set("shopId", shopId);
    url.searchParams.set("date", date);

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`slot-counts request failed (${res.status})`);
    }

    const body = await res.json();
    if (!body || typeof body !== "object") return {};
    return body.slotCounts && typeof body.slotCounts === "object"
      ? body.slotCounts
      : {};
  }

  async function refresh() {
    const shopId = getShopId();
    const date = getDisplayedDate();
    const hasTimeButtons = getTimeButtons().length > 0;

    if (!hasTimeButtons) return;

    if (!shopId || !date) {
      // We still render with fallback 0 booked so UI stays consistent.
      renderCounts({});
      return;
    }

    const fetchKey = `${shopId}|${date}`;

    if (fetchKey !== lastFetchKey) {
      lastFetchKey = fetchKey;
      try {
        cachedCounts = await fetchSlotCounts(shopId, date);
      } catch (err) {
        console.error("[AA] Could not fetch slot counts", err);
        cachedCounts = {};
      }
    }

    renderCounts(cachedCounts);
  }

  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refresh().catch((err) => console.error("[AA] refresh failed", err));
    }, REFRESH_DELAY_MS);
  }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      // If date/time selection changes we should allow refetch.
      lastFetchKey = "";
      scheduleRefresh();
    });

    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true
    });
  }

  function init() {
    ensureStyles();
    startObserver();
    scheduleRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
