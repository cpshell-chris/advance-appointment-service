(function () {
  "use strict";

  if (!window.AA) window.AA = {};

  let panelMounted = false;

  const PANEL_ID = "aa-fixed-panel";
  const STYLE_ID = "aa-fixed-style";
  const PANEL_WIDTH = 360;

  const CLOUD_RUN_URL =
    "https://advance-appointment-service-361478515851.us-east4.run.app";
  const PANEL_OPEN_STORAGE_KEY = "aaPanelOpen";
  const PANEL_STATE_STORAGE_KEY = "aaPanelState";
  const RO_ID_QUERY_PARAM = "aaRoId";

  const SHOP_CONFIG = {
    defaultMonths: 6,
    defaultMiles: 6000,
    minMonths: 3,
    maxMonths: 12,
    minMiles: 3000,
    maxMiles: 15000,
    mileStep: 1000
  };

  function getMilesForMonthInterval(monthInterval) {
    return monthInterval * 1000;
  }

  function getDefaultPanelState() {
    return {
      screen: 1,
      sourceRoId: null,
      roData: null,
      monthInterval: SHOP_CONFIG.defaultMonths,
      mileInterval: SHOP_CONFIG.defaultMiles,
      appointment: {
        date: null,
        mileage: null,
        type: "dropoff"
      },
      appointmentCounts: {},
      appointmentCountWeekKey: null,
      appointmentCountsLoading: false,
      repeatServices: [],
      declinedServices: [],
      customerNotes: ""
    };
  }

  let panelState = getDefaultPanelState();

  function serializePanelState() {
    return {
      ...panelState,
      appointment: {
        ...panelState.appointment,
        date: panelState.appointment.date
          ? new Date(panelState.appointment.date).toISOString()
          : null
      }
    };
  }

  function hydratePanelState(rawState) {
    const next = getDefaultPanelState();
    if (!rawState || typeof rawState !== "object") return next;

    next.screen = Number(rawState.screen) || 1;
    next.sourceRoId = rawState.sourceRoId ? String(rawState.sourceRoId) : null;
    next.roData = rawState.roData ?? null;
    next.monthInterval = Number(rawState.monthInterval) || SHOP_CONFIG.defaultMonths;
    next.mileInterval = Number(rawState.mileInterval) || SHOP_CONFIG.defaultMiles;
    next.appointment = {
      date: rawState.appointment?.date ? new Date(rawState.appointment.date) : null,
      mileage: Number.isFinite(rawState.appointment?.mileage)
        ? rawState.appointment.mileage
        : null,
      type: rawState.appointment?.type === "wait" ? "wait" : "dropoff"
    };
    next.appointmentCounts = rawState.appointmentCounts ?? {};
    next.appointmentCountWeekKey = rawState.appointmentCountWeekKey ?? null;
    next.appointmentCountsLoading = false;
    next.repeatServices = Array.isArray(rawState.repeatServices)
      ? rawState.repeatServices
      : [];
    next.declinedServices = Array.isArray(rawState.declinedServices)
      ? rawState.declinedServices
      : [];
    next.customerNotes = typeof rawState.customerNotes === "string" ? rawState.customerNotes : "";
    return next;
  }

  function persistPanelState() {
    try {
      window.localStorage.setItem(PANEL_STATE_STORAGE_KEY, JSON.stringify(serializePanelState()));
    } catch {}
  }

  function restorePanelState() {
    try {
      const raw = window.localStorage.getItem(PANEL_STATE_STORAGE_KEY);
      if (!raw) return;
      panelState = hydratePanelState(JSON.parse(raw));
    } catch {}
  }

  function clearPersistedPanelState() {
    try {
      window.localStorage.removeItem(PANEL_STATE_STORAGE_KEY);
    } catch {}
  }

  /* ============================
     URL / DATA HELPERS
  ============================ */

  function getRoIdFromUrl() {
    const match = window.location.pathname.match(/repair-orders\/(\d+)/);
    return match ? match[1] : null;
  }

  function getRoIdFromSchedulerQuery() {
    const params = new URLSearchParams(window.location.search);
    const roId = params.get(RO_ID_QUERY_PARAM);
    return roId && /^\d+$/.test(roId) ? roId : null;
  }

  async function fetchRoData(roId) {
    const response = await fetch(`${CLOUD_RUN_URL}/ro/${roId}`);
    if (!response.ok) throw new Error("Failed to fetch RO data");
    return response.json();
  }

  function getDateKey(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async function fetchAppointmentCounts(shopId, startDate, endDate) {
    const params = new URLSearchParams({
      shopId: String(shopId),
      startDate: getDateKey(startDate),
      endDate: getDateKey(endDate)
    });
    try {
      const response = await fetch(
        `${CLOUD_RUN_URL}/appointments/counts?${params.toString()}`
      );
      if (!response.ok) return {};
      const result = await response.json();
      if (!result.success || !result.counts) return {};
      return result.counts;
    } catch {
      return {};
    }
  }

  /* ============================
     DATE HELPERS
  ============================ */

  function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function formatDate(date) {
    return new Date(date).toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function formatShortDate(date) {
    return new Date(date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function formatTime(date) {
    return new Date(date).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit"
    });
  }

  function formatMiles(miles) {
    return Number(miles).toLocaleString();
  }

  function recalculateSmartValues() {
    const baseDate = addMonths(new Date(), panelState.monthInterval);
    const currentMileage = panelState.roData?.mileage ?? null;
    let smartMileage = null;
    if (Number.isFinite(currentMileage)) {
      smartMileage = currentMileage + panelState.mileInterval;
    }
    panelState.appointment.mileage = smartMileage;
    if (!panelState.appointment.date) {
      panelState.appointment.date = baseDate;
    }
    persistPanelState();
    return baseDate;
  }

  function getFiveSelectableDates(baseDate) {
    const targetDate = new Date(baseDate);
    targetDate.setHours(0, 0, 0, 0);

    const dayOfWeek = targetDate.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const monday = addDays(targetDate, -daysSinceMonday);
    return [0, 1, 2, 3, 4].map((offset) => addDays(monday, offset));
  }

  /* ============================
     JOBS HELPERS
  ============================ */

  function getNormalizedJobStatus(job) {
    return String(
      job?.authorizationStatus ??
      job?.authorizedStatus ??
      job?.approvalStatus ??
      job?.status ??
      ""
    )
      .trim()
      .toUpperCase();
  }

  function isApprovedJob(job) {
    const status = getNormalizedJobStatus(job);
    if (job?.authorized === true || job?.approved === true) return true;
    return ["AUTHORIZED", "APPROVED", "SOLD", "COMPLETED"].includes(status);
  }

  function isDeclinedJob(job) {
    const status = getNormalizedJobStatus(job);
    if (job?.authorized === false || job?.declined === true) return true;
    return ["DECLINED", "REJECTED", "UNAUTHORIZED"].includes(status);
  }

  function getPerformedJobs(roData) {
    const jobs = roData?.jobs ?? [];
    return jobs.filter((j) => isApprovedJob(j));
  }

  function getDeclinedJobs(roData) {
    const jobs = roData?.jobs ?? [];
    return jobs.filter((j) => isDeclinedJob(j));
  }

  function getJobName(job) {
    return job.name ?? "Unnamed Service";
  }

  /* ============================
     LAYOUT HELPERS
  ============================ */

  function applyShift() {
    const root = document.getElementById("root");
    const sidebar = document.querySelector(".MuiDrawer-paperAnchorRight");
    if (root) root.style.marginRight = PANEL_WIDTH + "px";
    if (sidebar) sidebar.style.marginRight = PANEL_WIDTH + "px";
  }

  function resetShift() {
    const root = document.getElementById("root");
    const sidebar = document.querySelector(".MuiDrawer-paperAnchorRight");
    if (root) root.style.marginRight = "0px";
    if (sidebar) sidebar.style.marginRight = "0px";
  }

  /* ============================
     STYLES
  ============================ */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 56px;
        right: 0;
        width: ${PANEL_WIDTH}px;
        height: calc(100vh - 56px);
        background: #f8f9fb;
        border-left: 1px solid #e0e4ea;
        box-shadow: -6px 0 32px rgba(0,0,0,0.10);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        transform: translate3d(100%, 0, 0);
        opacity: 0;
        will-change: transform, opacity;
        backface-visibility: hidden;
        transition: transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
                    opacity 0.22s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        font-size: 13px;
        color: #1a1a2e;
      }

      #${PANEL_ID}.aa-visible {
        transform: translate3d(0, 0, 0);
        opacity: 1;
      }

      .aa-header {
        padding: 14px 16px 12px;
        background: #fff;
        border-bottom: 1px solid #e8eaed;
        text-align: center;
        position: relative;
        flex-shrink: 0;
      }

      .aa-title {
        font-weight: 700;
        font-size: 14px;
        color: #111827;
        letter-spacing: -0.01em;
      }

      .aa-subtitle {
        font-size: 11px;
        color: #6b7280;
        margin-top: 3px;
      }

      .aa-close {
        position: absolute;
        right: 14px;
        top: 50%;
        transform: translateY(-50%);
        cursor: pointer;
        font-size: 14px;
        color: #9ca3af;
        width: 26px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        transition: background 0.15s, color 0.15s;
      }
      .aa-close:hover { background: #f3f4f6; color: #374151; }

      .aa-body {
        flex: 1;
        overflow-y: auto;
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .aa-card {
        background: #fff;
        border: 1px solid #e8eaed;
        border-radius: 10px;
        padding: 14px;
      }

      .aa-card-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #6b7280;
        margin-bottom: 10px;
      }

      .aa-label {
        font-size: 11px;
        color: #6b7280;
        font-weight: 500;
        margin-bottom: 5px;
      }

      .aa-value {
        font-weight: 700;
        font-size: 16px;
        color: #111827;
        line-height: 1.35;
      }

      .aa-value-sub {
        font-size: 12px;
        color: #6b7280;
        font-weight: 400;
        margin-top: 2px;
      }

      .aa-select {
        width: 100%;
        padding: 8px 28px 8px 10px;
        border: 1px solid #d1d5db;
        border-radius: 7px;
        background: #fff;
        font-size: 13px;
        color: #111827;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 10px center;
        cursor: pointer;
        font-family: inherit;
        transition: border-color 0.15s;
        box-sizing: border-box;
      }
      .aa-select:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
      }

      .aa-date-buttons {
        display: grid;
        grid-template-columns: repeat(5, minmax(0, 1fr));
        gap: 5px;
        margin-top: 8px;
      }

      .aa-date-btn {
        min-width: 0;
        padding: 7px 3px;
        font-size: 10.5px;
        line-height: 1.3;
        border: 1.5px solid #e5e7eb;
        background: #f9fafb;
        cursor: pointer;
        border-radius: 7px;
        text-align: center;
        font-family: inherit;
        color: #374151;
        transition: border-color 0.15s, background 0.15s, color 0.15s;
      }
      .aa-date-btn:hover:not(.active) {
        border-color: #93c5fd;
        background: #eff6ff;
      }
      .aa-date-btn.active {
        background: #2563eb;
        color: #fff;
        border-color: #2563eb;
        font-weight: 600;
      }

      .aa-date-count {
        display: block;
        font-size: 9.5px;
        margin-top: 2px;
        opacity: 0.75;
      }

      .aa-type-toggle {
        display: flex;
        gap: 8px;
      }

      .aa-type-btn {
        flex: 1;
        padding: 9px 8px;
        font-size: 13px;
        font-weight: 500;
        border: 1.5px solid #e5e7eb;
        background: #f9fafb;
        border-radius: 8px;
        cursor: pointer;
        font-family: inherit;
        color: #374151;
        transition: all 0.15s;
      }
      .aa-type-btn.active {
        background: #2563eb;
        color: #fff;
        border-color: #2563eb;
        font-weight: 600;
      }
      .aa-type-btn:hover:not(.active) {
        border-color: #93c5fd;
        background: #eff6ff;
      }

      .aa-check-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .aa-check-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 9px 10px;
        border: 1.5px solid #e5e7eb;
        border-radius: 8px;
        background: #f9fafb;
        cursor: pointer;
        transition: border-color 0.15s, background 0.15s;
        user-select: none;
      }
      .aa-check-item:hover { border-color: #93c5fd; background: #eff6ff; }
      .aa-check-item.checked { border-color: #2563eb; background: #eff6ff; }

      .aa-check-item input[type="checkbox"] {
        margin: 0;
        width: 15px;
        height: 15px;
        flex-shrink: 0;
        cursor: pointer;
        accent-color: #2563eb;
        margin-top: 1px;
      }

      .aa-check-label {
        font-size: 12.5px;
        color: #111827;
        line-height: 1.4;
        cursor: pointer;
      }

      .aa-empty-state {
        font-size: 12px;
        color: #9ca3af;
        font-style: italic;
        padding: 4px 0;
      }

      .aa-textarea {
        width: 100%;
        min-height: 72px;
        padding: 9px 10px;
        border: 1.5px solid #e5e7eb;
        border-radius: 8px;
        font-size: 13px;
        font-family: inherit;
        color: #111827;
        resize: vertical;
        background: #fff;
        box-sizing: border-box;
        transition: border-color 0.15s;
      }
      .aa-textarea:focus {
        outline: none;
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37,99,235,0.1);
      }
      .aa-textarea::placeholder { color: #9ca3af; }

      .aa-btn-primary {
        display: block;
        width: 100%;
        padding: 11px 10px;
        background: #2563eb;
        color: #fff;
        border: none;
        border-radius: 9px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
        letter-spacing: -0.01em;
        transition: background 0.15s, transform 0.1s;
        box-sizing: border-box;
      }
      .aa-btn-primary:hover { background: #1d4ed8; }
      .aa-btn-primary:active { transform: scale(0.98); }
      .aa-btn-primary:disabled {
        background: #9ca3af;
        cursor: not-allowed;
        transform: none;
      }

      .aa-btn-secondary {
        display: block;
        width: 100%;
        padding: 10px;
        background: #fff;
        color: #374151;
        border: 1.5px solid #e5e7eb;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: background 0.15s, border-color 0.15s;
        box-sizing: border-box;
      }
      .aa-btn-secondary:hover { background: #f9fafb; border-color: #d1d5db; }

      .aa-btn-ghost {
        display: block;
        width: 100%;
        padding: 10px;
        background: transparent;
        color: #6b7280;
        border: 1.5px solid #e5e7eb;
        border-radius: 9px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
        transition: all 0.15s;
        text-align: center;
        box-sizing: border-box;
      }
      .aa-btn-ghost:hover { background: #f3f4f6; color: #374151; }

      .aa-status {
        font-size: 11px;
        color: #6b7280;
        text-align: center;
        min-height: 16px;
      }

      .aa-error-banner {
        background: #fef2f2;
        border: 1px solid #fecaca;
        color: #b91c1c;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 12.5px;
        line-height: 1.4;
      }

      .aa-confirm-badge {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 15px;
        font-weight: 700;
        color: #15803d;
        margin-bottom: 4px;
      }

      .aa-confirm-id {
        font-size: 12px;
        color: #6b7280;
        margin-top: 4px;
      }

      .aa-loading {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 12px;
        padding: 40px 20px;
        color: #6b7280;
        font-size: 13px;
      }

      .aa-spinner {
        width: 28px;
        height: 28px;
        border: 3px solid #e5e7eb;
        border-top-color: #2563eb;
        border-radius: 50%;
        animation: aa-spin 0.8s linear infinite;
      }

      @keyframes aa-spin { to { transform: rotate(360deg); } }

      .aa-footer {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 12px 14px;
        background: #fff;
        border-top: 1px solid #e8eaed;
        flex-shrink: 0;
      }

      .aa-hint {
        font-size: 11px;
        color: #9ca3af;
        line-height: 1.4;
      }
    `;
    document.head.appendChild(style);
  }

  function renderCurrentScreen(panel) {
    if (panelState.screen === 2) {
      renderScreen2(panel);
      return;
    }
    if (panelState.screen === 3) {
      renderScreen3(
        panel,
        panelState.appointment.date ? new Date(panelState.appointment.date) : new Date(),
        "—"
      );
      return;
    }
    renderScreen1(panel);
  }

  function renderScreen1(panel) {
    panelState.screen = 1;
    const data = panelState.roData;
    const baseDate = recalculateSmartValues();
    const dateOptions = getFiveSelectableDates(baseDate);

    const weekStart = dateOptions[0];
    const weekEnd = dateOptions[dateOptions.length - 1];
    const nextWeekKey = `${panelState.roData?.shopId ?? ""}:${getDateKey(weekStart)}:${getDateKey(weekEnd)}`;

    if (
      panelState.roData?.shopId &&
      panelState.appointmentCountWeekKey !== nextWeekKey &&
      !panelState.appointmentCountsLoading
    ) {
      panelState.appointmentCountsLoading = true;
      panelState.appointmentCountWeekKey = nextWeekKey;
      fetchAppointmentCounts(panelState.roData.shopId, weekStart, weekEnd)
        .then((counts) => {
          panelState.appointmentCounts = counts;
        })
        .catch(() => {
          panelState.appointmentCounts = {};
        })
        .finally(() => {
          panelState.appointmentCountsLoading = false;
          persistPanelState();
          renderScreen1(panel);
        });
    }

    const selectedDate = panelState.appointment.date
      ? new Date(panelState.appointment.date)
      : null;
    const selectedInOptions = selectedDate
      ? dateOptions.some((d) => d.toDateString() === selectedDate.toDateString())
      : false;
    if (!selectedInOptions) {
      panelState.appointment.date = new Date(dateOptions[0]);
    }

    const roNumber = data?.roNumber ?? "—";
    const customerName = data?.customer
      ? `${data.customer.firstName ?? ""} ${data.customer.lastName ?? ""}`.trim()
      : "";
    const vehicleDisplay = data?.vehicle
      ? `${data.vehicle.year ?? ""} ${data.vehicle.make ?? ""} ${data.vehicle.model ?? ""}`.trim()
      : "";

    panel.innerHTML = `
      <div class="aa-header">
        <div class="aa-title">Advance Appointment Scheduler</div>
        <div class="aa-subtitle">RO #${roNumber} · ${customerName} · ${vehicleDisplay}</div>
        <div class="aa-close" id="aa-close-btn" title="Close">✕</div>
      </div>

      <div class="aa-body">

        <div class="aa-card">
          <div class="aa-card-title">Schedule Next Visit</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px;">
            <div>
              <div class="aa-label">Month Interval</div>
              <select class="aa-select" id="aa-month-interval"></select>
            </div>
            <div>
              <div class="aa-label">Approx. Mileage</div>
              <select class="aa-select" id="aa-mile-interval"></select>
            </div>
          </div>
          <div class="aa-label">Next Recommended Visit</div>
          <div class="aa-value">${formatShortDate(panelState.appointment.date)}</div>
          ${panelState.appointment.mileage
            ? `<div class="aa-value-sub">${formatMiles(panelState.appointment.mileage)} miles</div>`
            : ""}
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Select Date</div>
          <div class="aa-date-buttons" id="aa-date-buttons"></div>
          <div class="aa-status" id="aa-appointment-counts-status" style="margin-top:8px;"></div>
        </div>

      </div>

      <div class="aa-footer">
        <button class="aa-btn-ghost" id="aa-view-scheduler-btn">View Full Scheduler ↗</button>
        <button class="aa-btn-primary" id="aa-continue-btn">Continue →</button>
      </div>
    `;

    document.getElementById("aa-close-btn").onclick = hidePanel;

    const monthSelect = document.getElementById("aa-month-interval");
    for (let i = SHOP_CONFIG.minMonths; i <= SHOP_CONFIG.maxMonths; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${i} months`;
      if (i === panelState.monthInterval) opt.selected = true;
      monthSelect.appendChild(opt);
    }
    monthSelect.onchange = (e) => {
      panelState.monthInterval = Number(e.target.value);
      panelState.mileInterval = getMilesForMonthInterval(panelState.monthInterval);
      panelState.appointment.date = null;
      persistPanelState();
      renderScreen1(panel);
    };

    const mileSelect = document.getElementById("aa-mile-interval");
    for (let m = SHOP_CONFIG.minMiles; m <= SHOP_CONFIG.maxMiles; m += SHOP_CONFIG.mileStep) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = `${m.toLocaleString()} miles`;
      if (m === panelState.mileInterval) opt.selected = true;
      mileSelect.appendChild(opt);
    }
    mileSelect.onchange = (e) => {
      panelState.mileInterval = Number(e.target.value);
      panelState.appointment.date = null;
      persistPanelState();
      renderScreen1(panel);
    };

    const dateContainer = document.getElementById("aa-date-buttons");
    dateOptions.forEach((date) => {
      const btn = document.createElement("button");
      btn.className = "aa-date-btn";
      const count = panelState.appointmentCounts[getDateKey(date)] ?? 0;
      const isActive =
        panelState.appointment.date &&
        new Date(panelState.appointment.date).toDateString() === new Date(date).toDateString();
      if (isActive) btn.classList.add("active");

      btn.innerHTML =
        `<strong>${date.toLocaleDateString(undefined, { weekday: "short" })}</strong><br/>` +
        `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` +
        `<span class="aa-date-count">${count} booked</span>`;

      btn.onclick = () => {
        panelState.appointment.date = new Date(date);
        persistPanelState();
        renderScreen1(panel);
      };
      dateContainer.appendChild(btn);
    });

    const countStatus = document.getElementById("aa-appointment-counts-status");
    countStatus.textContent = panelState.appointmentCountsLoading ? "Loading availability…" : "";

    document.getElementById("aa-view-scheduler-btn").onclick = () => {
      setPanelOpenPersisted(true);
      persistPanelState();

      const schedulerUrl = new URL(
        `/admin/shop/${panelState.roData.shopId}/appointments`,
        window.location.origin
      );
      schedulerUrl.searchParams.set("date", new Date(panelState.appointment.date).toISOString());
      if (panelState.sourceRoId) {
        schedulerUrl.searchParams.set(RO_ID_QUERY_PARAM, panelState.sourceRoId);
      }
      window.open(schedulerUrl.toString(), "_blank");
    };

    document.getElementById("aa-continue-btn").onclick = () => {
      panelState.screen = 2;
      persistPanelState();
      renderScreen2(panel);
    };

    persistPanelState();
  }

  function renderScreen2(panel) {
    panelState.screen = 2;
    const roData = panelState.roData;
    const performedJobs = getPerformedJobs(roData);
    const declinedJobs = getDeclinedJobs(roData);

    const performedWithIds = performedJobs.map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `p${idx}`)
    }));

    const declinedWithIds = declinedJobs.map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `d${idx}`)
    }));

    if (panelState.repeatServices.length === 0 && performedWithIds.length > 0) {
      panelState.repeatServices = performedWithIds.map((j) => j._stableId);
    }
    if (panelState.declinedServices.length === 0 && declinedWithIds.length > 0) {
      panelState.declinedServices = declinedWithIds.map((j) => j._stableId);
    }

    panel.innerHTML = `
      <div class="aa-header">
        <div class="aa-title">Confirm Appointment</div>
        <div class="aa-subtitle">${formatShortDate(panelState.appointment.date)} · ${
          panelState.appointment.mileage
            ? formatMiles(panelState.appointment.mileage) + " miles"
            : "mileage TBD"
        }</div>
        <div class="aa-close" id="aa-close-btn" title="Close">✕</div>
      </div>

      <div class="aa-body">

        <div class="aa-card">
          <div class="aa-card-title">Appointment Type</div>
          <div class="aa-type-toggle">
            <button class="aa-type-btn ${panelState.appointment.type === "dropoff" ? "active" : ""}" id="aa-dropoff-btn">
              🚗 Drop-Off
            </button>
            <button class="aa-type-btn ${panelState.appointment.type === "wait" ? "active" : ""}" id="aa-wait-btn">
              ⏳ Wait
            </button>
          </div>
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Repeat Services</div>
          <div class="aa-hint" style="margin-bottom:10px;">Select services to repeat at this appointment.</div>
          <div class="aa-check-list" id="aa-repeat-list">
            ${performedWithIds.length === 0
              ? `<div class="aa-empty-state">No performed services on this RO.</div>`
              : performedWithIds.map((j) => {
                  const checked = panelState.repeatServices.includes(j._stableId);
                  return `
                    <label class="aa-check-item ${checked ? "checked" : ""}">
                      <input type="checkbox" data-id="${j._stableId}" data-group="repeat" ${checked ? "checked" : ""}/>
                      <span class="aa-check-label">${getJobName(j)}</span>
                    </label>`;
                }).join("")
            }
          </div>
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Declined Services</div>
          <div class="aa-hint" style="margin-bottom:10px;">Declined today — include in Purpose of Visit.</div>
          <div class="aa-check-list" id="aa-declined-list">
            ${declinedWithIds.length === 0
              ? `<div class="aa-empty-state">No declined services on this RO.</div>`
              : declinedWithIds.map((j) => {
                  const checked = panelState.declinedServices.includes(j._stableId);
                  return `
                    <label class="aa-check-item ${checked ? "checked" : ""}">
                      <input type="checkbox" data-id="${j._stableId}" data-group="declined" ${checked ? "checked" : ""}/>
                      <span class="aa-check-label">${getJobName(j)}</span>
                    </label>`;
                }).join("")
            }
          </div>
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Customer Instructions</div>
          <div class="aa-hint" style="margin-bottom:8px;">Included in Purpose of Visit (loaner, concerns, preferences, etc.)</div>
          <textarea
            class="aa-textarea"
            id="aa-customer-notes"
            placeholder="e.g. Customer needs a loaner vehicle. Check tire pressure on arrival."
          >${panelState.customerNotes}</textarea>
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Purpose of Visit Preview</div>
          <div class="aa-hint" style="margin-bottom:8px;">This content will be attached to the appointment's Purpose of Visit field.</div>
          <pre id="aa-purpose-preview" style="margin:0; white-space:pre-wrap; font-family:inherit; font-size:12px; color:#374151; line-height:1.45;">${buildPurposeOfVisit(roData) || "No details selected."}</pre>
        </div>

        <div id="aa-s2-error"></div>

      </div>

      <div class="aa-footer">
        <button class="aa-btn-primary" id="aa-schedule-btn">Schedule Appointment</button>
        <button class="aa-btn-secondary" id="aa-back-btn">← Back</button>
      </div>
    `;

    document.getElementById("aa-close-btn").onclick = hidePanel;
    document.getElementById("aa-back-btn").onclick = () => {
      panelState.screen = 1;
      persistPanelState();
      renderScreen1(panel);
    };

    document.getElementById("aa-dropoff-btn").onclick = () => {
      panelState.appointment.type = "dropoff";
      persistPanelState();
      renderScreen2(panel);
    };
    document.getElementById("aa-wait-btn").onclick = () => {
      panelState.appointment.type = "wait";
      persistPanelState();
      renderScreen2(panel);
    };

    panel.querySelectorAll('input[data-group="repeat"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-id");
        if (e.target.checked) {
          if (!panelState.repeatServices.includes(id)) panelState.repeatServices.push(id);
          e.target.closest("label")?.classList.add("checked");
        } else {
          panelState.repeatServices = panelState.repeatServices.filter((x) => x !== id);
          e.target.closest("label")?.classList.remove("checked");
        }
        persistPanelState();
        refreshPurposePreview(roData);
      });
    });

    panel.querySelectorAll('input[data-group="declined"]').forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-id");
        if (e.target.checked) {
          if (!panelState.declinedServices.includes(id)) panelState.declinedServices.push(id);
          e.target.closest("label")?.classList.add("checked");
        } else {
          panelState.declinedServices = panelState.declinedServices.filter((x) => x !== id);
          e.target.closest("label")?.classList.remove("checked");
        }
        persistPanelState();
        refreshPurposePreview(roData);
      });
    });

    document.getElementById("aa-customer-notes").addEventListener("input", (e) => {
      panelState.customerNotes = e.target.value;
      persistPanelState();
      refreshPurposePreview(roData);
    });

    document.getElementById("aa-schedule-btn").onclick = () => scheduleAppointment(panel);
    persistPanelState();
  }

  function refreshPurposePreview(roData) {
    const preview = document.getElementById("aa-purpose-preview");
    if (!preview) return;
    preview.textContent = buildPurposeOfVisit(roData) || "No details selected.";
  }

  function buildAppointmentTitle() {
    return `${panelState.monthInterval} Month / ${formatMiles(panelState.mileInterval)} Mile Service`;
  }

  function buildPurposeOfVisit(roData) {
    const performedJobs = getPerformedJobs(roData);
    const declinedJobs = getDeclinedJobs(roData);

    const performedWithIds = performedJobs.map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `p${idx}`)
    }));
    const declinedWithIds = declinedJobs.map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `d${idx}`)
    }));

    const lines = [];

    const repeatSelected = performedWithIds.filter((j) =>
      panelState.repeatServices.includes(j._stableId)
    );
    if (repeatSelected.length > 0) {
      lines.push("REPEAT SERVICES:");
      repeatSelected.forEach((j) => lines.push(`  • ${getJobName(j)}`));
    }

    const declinedSelected = declinedWithIds.filter((j) =>
      panelState.declinedServices.includes(j._stableId)
    );
    if (declinedSelected.length > 0) {
      if (lines.length) lines.push("");
      lines.push("PREVIOUSLY DECLINED:");
      declinedSelected.forEach((j) => lines.push(`  • ${getJobName(j)}`));
    }

    const typeLabel = panelState.appointment.type === "wait" ? "Customer Waits" : "Drop-Off";
    if (lines.length) lines.push("");
    lines.push(`APPOINTMENT TYPE: ${typeLabel}`);

    if (panelState.customerNotes.trim()) {
      lines.push("");
      lines.push("CUSTOMER INSTRUCTIONS:");
      lines.push(panelState.customerNotes.trim());
    }

    return lines.join("\n").trim();
  }

  async function scheduleAppointment(panel) {
    const scheduleBtn = document.getElementById("aa-schedule-btn");
    const errorEl = document.getElementById("aa-s2-error");

    if (scheduleBtn) {
      scheduleBtn.disabled = true;
      scheduleBtn.textContent = "Scheduling…";
    }
    if (errorEl) errorEl.innerHTML = "";

    try {
      const ro = panelState.roData;
      const selectedDate = new Date(panelState.appointment.date);

      const startTime = new Date(selectedDate);
      startTime.setHours(8, 0, 0, 0);
      const endTime = new Date(selectedDate);
      endTime.setHours(9, 0, 0, 0);

      const response = await fetch(`${CLOUD_RUN_URL}/appointments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopId: ro.shopId,
          customerId: ro.customer.id,
          vehicleId: ro.vehicle.id,
          title: buildAppointmentTitle(),
          purposeOfVisit: buildPurposeOfVisit(ro),
          appointmentType: panelState.appointment.type,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          mileage: panelState.appointment.mileage
        })
      });

      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.message || "Scheduling failed");
      }

      const appointmentId = result.appointment?.data ?? result.appointment?.id ?? "—";
      panelState.screen = 3;
      persistPanelState();
      renderScreen3(panel, startTime, appointmentId);
    } catch (err) {
      console.error("Schedule error:", err);
      if (scheduleBtn) {
        scheduleBtn.disabled = false;
        scheduleBtn.textContent = "Schedule Appointment";
      }
      if (errorEl) {
        errorEl.innerHTML = `
          <div class="aa-error-banner">
            ⚠️ Failed to schedule appointment.<br/>
            <span style="font-size:11px;opacity:0.8;">${err.message || "Please try again."}</span>
          </div>`;
      }
    }
  }

  function renderScreen3(panel, startTime, appointmentId) {
    panelState.screen = 3;
    const ro = panelState.roData;

    panel.innerHTML = `
      <div class="aa-header">
        <div class="aa-title">Appointment Scheduled</div>
        <div class="aa-close" id="aa-close-btn" title="Close">✕</div>
      </div>

      <div class="aa-body">

        <div class="aa-card">
          <div class="aa-confirm-badge">✅ Confirmed!</div>
          <div class="aa-confirm-id">Confirmation ID: ${appointmentId}</div>
        </div>

        <div class="aa-card">
          <div class="aa-card-title">Appointment Details</div>
          <div class="aa-value">${formatDate(startTime)}</div>
          <div class="aa-value-sub">${formatTime(startTime)}</div>
          ${panelState.appointment.mileage
            ? `<div class="aa-value-sub" style="margin-top:6px;">Est. mileage: ${formatMiles(panelState.appointment.mileage)}</div>`
            : ""}
          <div class="aa-value-sub" style="margin-top:4px;">
            Type: ${panelState.appointment.type === "wait" ? "Customer Waits" : "Drop-Off"}
          </div>
        </div>

      </div>

      <div class="aa-footer">
        <button class="aa-btn-primary" id="aa-view-btn">View in Scheduler ↗</button>
        <button class="aa-btn-secondary" id="aa-close-done-btn">Done</button>
      </div>
    `;

    document.getElementById("aa-close-btn").onclick = hidePanel;
    document.getElementById("aa-close-done-btn").onclick = hidePanel;
    document.getElementById("aa-view-btn").onclick = () => {
      setPanelOpenPersisted(true);
      persistPanelState();

      const appointmentUrl = new URL(
        `/admin/shop/${ro.shopId}/appointments`,
        window.location.origin
      );
      appointmentUrl.searchParams.set("date", startTime.toISOString());
      if (panelState.sourceRoId) {
        appointmentUrl.searchParams.set(RO_ID_QUERY_PARAM, panelState.sourceRoId);
      }
      window.open(appointmentUrl.toString(), "_blank");
    };

    persistPanelState();
  }

  function setPanelOpenPersisted(isOpen) {
    try {
      window.localStorage.setItem(PANEL_OPEN_STORAGE_KEY, isOpen ? "1" : "0");
    } catch {}
  }

  function isPanelOpenPersisted() {
    try {
      return window.localStorage.getItem(PANEL_OPEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  async function createPanel() {
    if (document.getElementById(PANEL_ID)) return;

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    requestAnimationFrame(() => panel.classList.add("aa-visible"));
    panelMounted = true;
    applyShift();

    panel.innerHTML = `
      <div class="aa-header">
        <div class="aa-title">Advance Appointment Scheduler</div>
        <div class="aa-close" id="aa-close-btn" title="Close">✕</div>
      </div>
      <div class="aa-body">
        <div class="aa-loading">
          <div class="aa-spinner"></div>
          <div>Loading repair order…</div>
        </div>
      </div>
    `;
    document.getElementById("aa-close-btn").onclick = hidePanel;

    const roIdFromPath = getRoIdFromUrl();
    const roIdFromQuery = getRoIdFromSchedulerQuery();
    const roId = roIdFromPath || roIdFromQuery || panelState.sourceRoId;

    try {
      if (roId) {
        try {
          const data = await fetchRoData(roId);
          if (!data || data.success === false) throw new Error("Invalid API response");
          panelState.roData = data;
          panelState.sourceRoId = String(roId);
        } catch (err) {
          if (!panelState.roData) throw err;
        }
      } else if (!panelState.roData) {
        throw new Error("No RO context available");
      }

      renderCurrentScreen(panel);
    } catch {
      panel.innerHTML = `
        <div class="aa-header">
          <div class="aa-title">Advance Appointment Scheduler</div>
          <div class="aa-close" id="aa-close-btn" title="Close">✕</div>
        </div>
        <div class="aa-body">
          <div class="aa-error-banner" style="margin-top:16px;">
            ⚠️ Failed to load repair order data.<br/>
            <span style="font-size:11px;opacity:0.8;">Open a repair order and try again.</span>
          </div>
        </div>
      `;
      document.getElementById("aa-close-btn").onclick = hidePanel;
    }
  }

  function showPanel() {
    setPanelOpenPersisted(true);
    restorePanelState();
    injectStyles();
    createPanel();
  }

  function hidePanel() {
    setPanelOpenPersisted(false);
    clearPersistedPanelState();

    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.classList.remove("aa-visible");
    setTimeout(() => {
      panel.remove();
      panelMounted = false;
      panelState = getDefaultPanelState();
      resetShift();
    }, 340);
  }

  window.AA.showPanel = showPanel;
  window.AA.hidePanel = hidePanel;
  window.AA.isPanelMounted = () => panelMounted;

  if (isPanelOpenPersisted()) {
    showPanel();
  }

  window.AA.initLayoutWatcher = function () {};
  window.AA.initRouteWatcher = function () {};
})();
