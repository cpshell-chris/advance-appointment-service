/*
 * panel.js
 *
 * Screen 2 "Schedule" helper for Tekmetric side panel.
 *
 * What it does:
 * - Finds all time buttons in the TIME grid.
 * - Displays a small "X booked" label under each time.
 * - Pulls existing appointment counts for the selected date from:
 *   GET /appointments/slot-counts?shopId=...&date=YYYY-MM-DD
 *
 * Notes:
 * - Set window.ADVANCE_APPOINTMENT_SERVICE_URL if your API is hosted elsewhere.
 * - The script auto-refreshes when time buttons are re-rendered by Tekmetric.
 */

(() => {
  "use strict";

  const API_BASE =
    window.ADVANCE_APPOINTMENT_SERVICE_URL ||
    "https://advance-appointment-service.onrender.com";

  const REFRESH_DEBOUNCE_MS = 250;
  const BOOKED_CLASS = "aa-booked-count";
  const WRAP_CLASS = "aa-time-content";

  let refreshTimer = null;
  let lastSignature = "";

  function injectStyles() {
    if (document.getElementById("aa-booked-count-styles")) return;

    const style = document.createElement("style");
    style.id = "aa-booked-count-styles";
    style.textContent = `
      .${WRAP_CLASS} {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        line-height: 1.1;
      }

      .${BOOKED_CLASS} {
        margin-top: 3px;
        font-size: 10px;
        font-weight: 500;
        opacity: 0.75;
        white-space: nowrap;
      }

      button[aria-pressed="true"] .${BOOKED_CLASS},
      button[class*="selected"] .${BOOKED_CLASS} {
        opacity: 0.95;
      }
    `;

    document.head.appendChild(style);
  }

  function parseDateFromPanelText() {
    const container = document.querySelector("[data-testid='appointment-details'], .appointment-details, aside, [role='complementary']");
    if (!container) return null;

    const text = container.textContent || "";
    const match = text.match(/([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})/);
    if (!match) return null;

    const date = new Date(match[1]);
    if (Number.isNaN(date.getTime())) return null;

    return toDateKey(date);
  }

  function toDateKey(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  }

  function getShopIdFromUrl() {
    const byPath = window.location.pathname.match(/\/admin\/shop\/(\d+)\//);
    if (byPath) return byPath[1];

    const params = new URLSearchParams(window.location.search);
    return params.get("shop") || params.get("shopId") || null;
  }

  function normalizeTimeLabel(label) {
    if (!label) return null;

    const trimmed = label.replace(/\s+/g, " ").trim().toUpperCase();
    const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*([AP]M)$/);
    if (!match) return null;

    let hour = Number(match[1]);
    const minute = Number(match[2] || "0");
    const period = match[3];

    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

    if (hour === 12 && period === "AM") hour = 0;
    else if (hour !== 12 && period === "PM") hour += 12;

    const d = new Date();
    d.setHours(hour, minute, 0, 0);

    let outHour = d.getHours();
    const outMinute = d.getMinutes();
    const outPeriod = outHour >= 12 ? "PM" : "AM";

    outHour %= 12;
    if (outHour === 0) outHour = 12;

    return `${outHour}:${String(outMinute).padStart(2, "0")} ${outPeriod}`;
  }

  function getTimeButtons() {
    const candidates = Array.from(document.querySelectorAll("button"));

    return candidates.filter((btn) => {
      const text = (btn.textContent || "").trim();
      return /\d{1,2}:\d{2}\s*[AP]M/i.test(text);
    });
  }

  function getPrimaryTimeText(button) {
    const text = (button.textContent || "").split("booked")[0].trim();
    const match = text.match(/\d{1,2}:\d{2}\s*[AP]M/i);
    return match ? normalizeTimeLabel(match[0]) : null;
  }

  function setButtonBookedCount(button, count) {
    const timeLabel = getPrimaryTimeText(button);
    if (!timeLabel) return;

    let wrap = button.querySelector(`.${WRAP_CLASS}`);
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = WRAP_CLASS;

      const timeEl = document.createElement("span");
      timeEl.className = "aa-time-label";
      timeEl.textContent = timeLabel;

      const bookedEl = document.createElement("span");
      bookedEl.className = BOOKED_CLASS;

      wrap.appendChild(timeEl);
      wrap.appendChild(bookedEl);

      button.textContent = "";
      button.appendChild(wrap);
    }

    const bookedEl = wrap.querySelector(`.${BOOKED_CLASS}`);
    if (!bookedEl) return;

    const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
    bookedEl.textContent = `${safeCount} booked`;
  }

  async function fetchSlotCounts(shopId, date) {
    const url = new URL(`${API_BASE}/appointments/slot-counts`);
    url.searchParams.set("shopId", shopId);
    url.searchParams.set("date", date);

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch slot counts (${response.status})`);
    }

    const payload = await response.json();
    return payload?.slotCounts && typeof payload.slotCounts === "object"
      ? payload.slotCounts
      : {};
  }

  async function refreshBookedCounts() {
    const shopId = getShopIdFromUrl();
    const date = parseDateFromPanelText();
    const buttons = getTimeButtons();

    if (!shopId || !date || buttons.length === 0) return;

    const signature = `${shopId}|${date}|${buttons.length}`;
    if (signature === lastSignature) {
      return;
    }

    lastSignature = signature;

    try {
      const slotCounts = await fetchSlotCounts(shopId, date);

      for (const button of buttons) {
        const time = getPrimaryTimeText(button);
        if (!time) continue;

        const count = slotCounts[time] || 0;
        setButtonBookedCount(button, count);
      }
    } catch (err) {
      console.error("[Advance Appointment] Could not load slot counts", err);

      for (const button of buttons) {
        setButtonBookedCount(button, 0);
      }
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => {
      refreshBookedCounts().catch((err) => {
        console.error("[Advance Appointment] refresh error", err);
      });
    }, REFRESH_DEBOUNCE_MS);
  }

  function observePanelChanges() {
    const observer = new MutationObserver(() => {
      lastSignature = "";
      scheduleRefresh();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function init() {
    injectStyles();
    observePanelChanges();
    scheduleRefresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
