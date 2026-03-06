// src/sidepanel/sidepanel.js
(function () {
  "use strict";

  const app = document.getElementById("app");
  if (!app) return;

  let cachedContext = null; // { roId, origin, shopId? }
  // ----------------------------
  // UI mode (wizard vs search)
  // ----------------------------
  let rootElRef = null;              // holds the current #aa-shadow-root element
  let uiMode = "wizard";             // "wizard" | "search"
  let searchState = {
    query: "",
    loading: false,
    error: "",
    results: []
  };

  const OPEN_RO_STATUS_IDS = [1, 2, 3]; // Estimate, Work-in-Progress, Complete (not posted)
  const SEARCH_DEBOUNCE_MS = 250;
  let searchDebounceTimer = null;

  // ----------------------------
  // Constants / storage keys
  // ----------------------------
  const CLOUD_RUN_URL =
    "https://advance-appointment-service-361478515851.us-east4.run.app";

  const PANEL_STATE_STORAGE_KEY = "aaPanelState"; // moved from localStorage -> chrome.storage.local
  const CONTEXT_KEY = "aaContext";
  const RO_ID_QUERY_PARAM = "aaRoId";

  // ----------------------------
  // App config
  // ----------------------------
  const SHOP_CONFIG = {
    defaultMonths: 6,
    defaultMiles: 6000,
    smartTargetMiles: 6000,
    minMonths: 1,
    maxMonths: 12,
    minMiles: 1000,
    maxMiles: 100000,
    mileStep: 1000,
    dayStartHour: 6,
    dayEndHour: 22
  };

  const TEKMETRIC_COLORS = [
    "red",
    "pink",
    "yellow",
    "orange",
    "light green",
    "green",
    "blue",
    "navy",
    "lavender",
    "purple"
  ];

  // ----------------------------
  // DOM helpers
  // ----------------------------
  function uiId(id) {
    return document.getElementById(id);
  }

  // ----------------------------
  // Messaging / fetch
  // ----------------------------
  function send(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(resp);
      });
    });
  }

  async function cloudRunFetch(path, options = {}) {
    const url = `${CLOUD_RUN_URL}${path.startsWith("/") ? "" : "/"}${path}`;

    const resp = await send({
      __aa: true,
      type: "CLOUDRUN_FETCH",
      payload: {
        url,
        method: options.method || "GET",
        headers: options.headers || {},
        body: options.body || null,
        timeoutMs: options.timeoutMs || 25000
      }
    });

    if (!resp?.ok) {
      const msg =
        resp?.error ||
        (typeof resp?.data === "string" ? resp.data : "") ||
        `Request failed (${resp?.status || "unknown"})`;
      throw new Error(msg);
    }
    return resp.data;
  }

  async function getContext() {
    const { aaContext } = await chrome.storage.local.get([CONTEXT_KEY]);
    return aaContext || null;
  }

  async function setContext(next) {
    await chrome.storage.local.set({ [CONTEXT_KEY]: next });
  }

  async function clearContextAndState() {
    await chrome.storage.local.remove([CONTEXT_KEY, PANEL_STATE_STORAGE_KEY]);
  }

  // ----------------------------
  // State persistence (chrome.storage.local)
  // ----------------------------
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
        type: "dropoff",
        hour: 8,
        color: "navy"
      },
      appointmentCounts: {},
      appointmentCountWeekKey: null,
      appointmentCountsLoading: false,
      appointmentCountsLoadingStartedAt: null,
      timeSlotCounts: { dropoff: {}, wait: {} },
      timeSlotCountsDateKey: null,
      timeSlotCountsLoading: false,
      vehicleAvgMilesPerDay: null,
      vehicleDataPointCount: 0,
      vehicleHistorySpanDays: null,
      hasUserSelectedMonthInterval: false,
      repeatServices: [],
      declinedServices: [],
      customerNotes: "",
      scheduledAppointmentId: null,
      scheduledStartTime: null,
      isConfirmed: false
    };
  }

  let panelState = getDefaultPanelState();

  let aaRenderToken = 0;
function nextRenderToken() {
  aaRenderToken += 1;
  return aaRenderToken;
}

  function serializePanelState() {
    return {
      ...panelState,
      appointment: {
        ...panelState.appointment,
        date: panelState.appointment.date
          ? new Date(panelState.appointment.date).toISOString()
          : null
      },
      scheduledStartTime: panelState.scheduledStartTime
        ? new Date(panelState.scheduledStartTime).toISOString()
        : null
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
      mileage: Number.isFinite(rawState.appointment?.mileage) ? rawState.appointment.mileage : null,
      type: rawState.appointment?.type === "wait" ? "wait" : "dropoff",
      hour: Number.isFinite(rawState.appointment?.hour) ? rawState.appointment.hour : 8,
      color: TEKMETRIC_COLORS.includes(rawState.appointment?.color)
        ? rawState.appointment.color
        : "navy"
    };

    next.appointmentCounts = rawState.appointmentCounts ?? {};
    next.appointmentCountWeekKey = rawState.appointmentCountWeekKey ?? null;
    next.appointmentCountsLoading = false;

    next.timeSlotCounts = rawState.timeSlotCounts ?? { dropoff: {}, wait: {} };
    next.timeSlotCountsDateKey = rawState.timeSlotCountsDateKey ?? null;
    next.timeSlotCountsLoading = false;

    next.vehicleAvgMilesPerDay = Number.isFinite(rawState.vehicleAvgMilesPerDay)
      ? rawState.vehicleAvgMilesPerDay
      : null;
    next.vehicleDataPointCount = Number(rawState.vehicleDataPointCount) || 0;
    next.vehicleHistorySpanDays = Number(rawState.vehicleHistorySpanDays) || null;

    next.hasUserSelectedMonthInterval = rawState.hasUserSelectedMonthInterval === true;

    next.repeatServices = Array.isArray(rawState.repeatServices) ? rawState.repeatServices : [];
    next.declinedServices = Array.isArray(rawState.declinedServices) ? rawState.declinedServices : [];
    next.customerNotes = typeof rawState.customerNotes === "string" ? rawState.customerNotes : "";

    next.scheduledAppointmentId = rawState.scheduledAppointmentId
      ? String(rawState.scheduledAppointmentId)
      : null;
    next.scheduledStartTime = rawState.scheduledStartTime
      ? new Date(rawState.scheduledStartTime)
      : null;
    next.isConfirmed = rawState.isConfirmed === true;

    return next;
  }

  async function persistPanelState() {
    try {
      await chrome.storage.local.set({
        [PANEL_STATE_STORAGE_KEY]: serializePanelState()
      });
    } catch {}
  }

  async function restorePanelState() {
    try {
      const raw = await chrome.storage.local.get([PANEL_STATE_STORAGE_KEY]);
      if (raw && raw[PANEL_STATE_STORAGE_KEY]) {
        panelState = hydratePanelState(raw[PANEL_STATE_STORAGE_KEY]);
      }
    } catch {}
  }

  async function clearPersistedPanelState() {
    try {
      await chrome.storage.local.remove([PANEL_STATE_STORAGE_KEY]);
    } catch {}
  }

  // ----------------------------
  // Cloud calls
  // ----------------------------
  async function fetchRoData(roId) {
    const data = await cloudRunFetch(`/ro/${encodeURIComponent(roId)}`);
    if (!data || data.success === false) throw new Error("Failed to fetch RO data");
    return data;
  }

  async function fetchVehicleHistory(vehicleId, shopId) {
    const data = await cloudRunFetch(
      `/vehicle-history/${encodeURIComponent(vehicleId)}?shopId=${encodeURIComponent(shopId)}`
    );
    if (!data || data.success === false) throw new Error("Failed to fetch vehicle history");
    return data;
  }
  // Search OPEN repair orders (Estimate/WIP/Complete-not-posted)
  // NOTE: adjust path here if your Cloud Run route name differs.
  async function searchOpenRepairOrders(shopId, searchText) {
    const params = new URLSearchParams({
      shopId: String(shopId),
      search: String(searchText || "").trim(),
      statusIds: OPEN_RO_STATUS_IDS.join(",")
    });

    const data = await cloudRunFetch(`/repair-orders/search?${params.toString()}`);
    if (!data || data.success === false) throw new Error(data?.message || "Search failed");
    return data;
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
      const result = await cloudRunFetch(`/appointments/counts?${params.toString()}`);
      if (!result || !result.success || !result.counts) return {};
      return result.counts;
    } catch {
      return {};
    }
  }

  function normalizeTimeCountResponse(result, selectedDate) {
    const normalized = { dropoff: {}, wait: {} };
    if (!result || typeof result !== "object") return normalized;

    const dateKey = getDateKey(selectedDate);
    const source = result.timeCounts ?? result.counts ?? result;
    const scoped = source?.[dateKey] ?? source;

    const readHourFromKey = (rawKey) => {
      const text = String(rawKey ?? "").trim();
      if (!text) return null;

      if (text.includes("T")) {
        const parsedDate = new Date(text);
        if (!Number.isNaN(parsedDate.getTime())) return parsedDate.getHours();
      }

      const ampmMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
      if (ampmMatch) {
        const hour12 = Number(ampmMatch[1]);
        const suffix = ampmMatch[3].toUpperCase();
        const normalizedHour = hour12 % 12;
        return suffix === "PM" ? normalizedHour + 12 : normalizedHour;
      }

      const hourFirstMatch = text.match(/^(\d{1,2})(?::\d{2})?$/);
      if (hourFirstMatch) {
        const hour = Number(hourFirstMatch[1]);
        return Number.isFinite(hour) ? hour : null;
      }

      const isoHourMatch = text.match(/T(\d{2}):\d{2}/);
      if (isoHourMatch) return Number(isoHourMatch[1]);

      return null;
    };

    const applyCountMap = (type, map) => {
      if (!map || typeof map !== "object") return;
      Object.entries(map).forEach(([hourKey, count]) => {
        const hour = readHourFromKey(hourKey);
        if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;
        normalized[type][hour] = (normalized[type][hour] || 0) + (Number(count) || 0);
      });
    };

    applyCountMap("dropoff", scoped?.dropoff ?? scoped?.dropOff);
    applyCountMap("wait", scoped?.wait ?? scoped?.waiter);

    if (!Object.keys(normalized.dropoff).length && !Object.keys(normalized.wait).length) {
      applyCountMap("dropoff", scoped);
    }

    return normalized;
  }

  function getAppointmentTypeKey(appointment) {
    const rawType = String(
      appointment?.appointmentType ??
        appointment?.type ??
        appointment?.appointment_type ??
        appointment?.visitType ??
        ""
    ).toLowerCase();

    if (rawType.includes("wait")) return "wait";
    return "dropoff";
  }

  function getAppointmentStartDate(appointment) {
    const rawStart =
      appointment?.startTime ??
      appointment?.startDate ??
      appointment?.start ??
      appointment?.startsAt ??
      appointment?.start_at ??
      null;

    if (!rawStart) return null;
    const parsed = new Date(rawStart);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function normalizeAppointmentListCounts(items, selectedDate) {
    const normalized = { dropoff: {}, wait: {} };
    if (!Array.isArray(items)) return normalized;

    const selectedKey = getDateKey(selectedDate);

    items.forEach((appointment) => {
      const startDate = getAppointmentStartDate(appointment);
      if (!startDate || getDateKey(startDate) !== selectedKey) return;

      const hour = startDate.getHours();
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return;

      const typeKey = getAppointmentTypeKey(appointment);
      normalized[typeKey][hour] = (normalized[typeKey][hour] || 0) + 1;
    });

    return normalized;
  }

  function mergeTimeCounts(primary, fallback) {
    const merged = { dropoff: {}, wait: {} };

    ["dropoff", "wait"].forEach((type) => {
      const first = primary?.[type] ?? {};
      const second = fallback?.[type] ?? {};
      const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
      keys.forEach((key) => {
        const total = Number(first[key] || 0) + Number(second[key] || 0);
        if (total > 0) merged[type][key] = total;
      });
    });

    return merged;
  }

  async function fetchTimeSlotCountsFromAppointments(shopId, selectedDate) {
    const baseParams = {
      shopId: String(shopId),
      startDate: getDateKey(selectedDate),
      endDate: getDateKey(selectedDate)
    };

    const requestList = async (extraParams = {}) => {
      const params = new URLSearchParams({ ...baseParams, ...extraParams });
      try {
        const result = await cloudRunFetch(`/appointments?${params.toString()}`);

        const items =
          result?.appointments ??
          result?.data?.appointments ??
          result?.data ??
          result?.results ??
          null;

        if (!Array.isArray(items)) return null;
        return normalizeAppointmentListCounts(items, selectedDate);
      } catch {
        return null;
      }
    };

    try {
      const combined = await requestList();
      if (combined && (Object.keys(combined.dropoff).length || Object.keys(combined.wait).length)) {
        return combined;
      }

      const [wait, dropoff] = await Promise.all([
        requestList({ appointmentType: "wait" }) ?? Promise.resolve(null),
        requestList({ appointmentType: "dropoff" }) ?? Promise.resolve(null)
      ]);

      return mergeTimeCounts(wait, dropoff);
    } catch {
      return { dropoff: {}, wait: {} };
    }
  }

  async function fetchTimeSlotCounts(shopId, selectedDate) {
    const fromAppointments = await fetchTimeSlotCountsFromAppointments(shopId, selectedDate);
    if (Object.keys(fromAppointments.dropoff).length || Object.keys(fromAppointments.wait).length) {
      return fromAppointments;
    }

    const baseParams = {
      shopId: String(shopId),
      startDate: getDateKey(selectedDate),
      endDate: getDateKey(selectedDate)
    };

    const requestCounts = async (extraParams = {}) => {
      const params = new URLSearchParams({ ...baseParams, ...extraParams });
      try {
        const result = await cloudRunFetch(`/appointments/counts?${params.toString()}`);
        if (!result || !result.success) return null;
        return normalizeTimeCountResponse(result, selectedDate);
      } catch {
        return null;
      }
    };

    try {
      const grouped = await requestCounts({ groupBy: "hour", includeTypes: "1" });
      if (grouped && (Object.keys(grouped.dropoff).length || Object.keys(grouped.wait).length)) {
        return grouped;
      }

      const [dropoff, wait, waiter] = await Promise.all([
        requestCounts({ groupBy: "hour", appointmentType: "dropoff" }),
        requestCounts({ groupBy: "hour", appointmentType: "wait" }),
        requestCounts({ groupBy: "hour", appointmentType: "waiter" })
      ]);

      return {
        dropoff: dropoff?.dropoff ?? {},
        wait: mergeTimeCounts(wait, waiter).wait
      };
    } catch {
      return { dropoff: {}, wait: {} };
    }
  }

  // ----------------------------
  // Date/format helpers
  // ----------------------------
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

  function getHourlyTimeOptions() {
    const times = [];
    for (let hour = SHOP_CONFIG.dayStartHour; hour < SHOP_CONFIG.dayEndHour; hour++) {
      times.push(hour);
    }
    return times;
  }

  function formatHourLabel(hour) {
    const suffix = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 === 0 ? 12 : hour % 12;
    return `${hour12}:00 ${suffix}`;
  }

  function formatMiles(miles) {
    return Number(miles).toLocaleString();
  }

  // ----------------------------
  // Mileage math
  // ----------------------------
  function getProjectedMileage(monthInterval) {
    const currentMileage = panelState.roData?.mileage ?? null;
    const avgMilesPerDay = panelState.vehicleAvgMilesPerDay ?? null;

    if (!Number.isFinite(currentMileage)) return null;

    if (!Number.isFinite(avgMilesPerDay)) {
      return currentMileage + monthInterval * 1000;
    }

    const daysAhead = monthInterval * 30.4375;
    const projectedIncrease = avgMilesPerDay * daysAhead;
    return Math.round(currentMileage + projectedIncrease);
  }

  function getMileageMathBreakdown(monthInterval) {
    const currentMileage = panelState.roData?.mileage ?? null;
    const avgMilesPerDay = panelState.vehicleAvgMilesPerDay ?? null;

    if (!Number.isFinite(currentMileage)) return null;

    const daysPerMonth = 30.4375;

    if (!Number.isFinite(avgMilesPerDay) || avgMilesPerDay <= 0) {
      return {
        currentMileage,
        avgMilesPerDay: null,
        milesPerMonth: 1000,
        months: monthInterval,
        projectedIncrease: monthInterval * 1000,
        projectedMileage: currentMileage + monthInterval * 1000,
        fallback: true
      };
    }

    const milesPerMonth = avgMilesPerDay * daysPerMonth;
    const projectedIncrease = milesPerMonth * monthInterval;
    const projectedMileage = Math.round(currentMileage + projectedIncrease);

    return {
      currentMileage,
      avgMilesPerDay,
      milesPerMonth,
      months: monthInterval,
      projectedIncrease,
      projectedMileage,
      fallback: false
    };
  }

  function getConfidenceLevel() {
    const count = panelState.vehicleDataPointCount;
    const span = panelState.vehicleHistorySpanDays;

    if (!count || count < 2 || !span) return { label: "Low", tone: "low" };
    if (count >= 5 && span >= 365) return { label: "High", tone: "high" };
    if (count >= 3 && span >= 180) return { label: "Medium", tone: "medium" };
    return { label: "Low", tone: "low" };
  }

  function getSmartRecommendedMonth() {
    const avgMilesPerDay = panelState.vehicleAvgMilesPerDay;
    const targetMiles = SHOP_CONFIG.smartTargetMiles;

    if (!Number.isFinite(avgMilesPerDay) || avgMilesPerDay <= 0) return null;

    const milesPerMonth = avgMilesPerDay * 30.4375;
    const rawMonths = targetMiles / milesPerMonth;
    const rounded = Math.round(rawMonths);

    if (rounded >= SHOP_CONFIG.minMonths && rounded <= SHOP_CONFIG.maxMonths) {
      return rounded;
    }
    return null;
  }

  function recalculateSmartValues() {
    const baseDate = addMonths(new Date(), panelState.monthInterval);
    const currentMileage = panelState.roData?.mileage ?? null;
    let smartMileage = null;
    if (Number.isFinite(currentMileage)) {
      smartMileage = getProjectedMileage(panelState.monthInterval);
    }
    panelState.appointment.mileage = smartMileage;
    if (!panelState.appointment.date) {
      panelState.appointment.date = baseDate;
    }
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

  // ----------------------------
  // Jobs selection
  // ----------------------------
  function getNormalizedJobStatus(job) {
    return String(
      job?.authorizationStatus ??
        job?.authorizedStatus ??
        job?.approvalStatus ??
        job?.appointmentStatus ??
        job?.status ??
        ""
    )
      .trim()
      .toUpperCase();
  }

  function extractJobsFromRoData(roData) {
    const raw = Array.isArray(roData?.jobs) ? roData.jobs : [];
    const seen = new Set();
    const rows = [];

    for (const job of raw) {
      if (!job || typeof job !== "object") continue;
      const key = String(job.id ?? job.jobId ?? job.uuid ?? "");
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      rows.push(job);
    }
    return rows;
  }

  function isApprovedJob(job) {
    const status = getNormalizedJobStatus(job);
    if (job?.authorized === true || job?.approved === true || job?.isApproved === true) return true;
    if (typeof status === "string") {
      if (status.includes("DECLIN") || status.includes("REJECT")) return false;
      if (
        status.includes("AUTH") ||
        status.includes("APPROV") ||
        status.includes("SOLD") ||
        status.includes("COMPLETE")
      )
        return true;
    }
    return false;
  }

  function isDeclinedJob(job) {
    const status = getNormalizedJobStatus(job);
    if (job?.authorized === false || job?.declined === true || job?.isDeclined === true) return true;
    if (typeof status === "string") {
      if (status.includes("DECLIN") || status.includes("REJECT") || status.includes("UNAUTH")) return true;
    }
    return false;
  }

  function getPerformedJobs(roData) {
    return extractJobsFromRoData(roData).filter((j) => isApprovedJob(j));
  }

  function getDeclinedJobs(roData) {
    return extractJobsFromRoData(roData).filter((j) => isDeclinedJob(j));
  }

  function getJobName(job) {
    return job?.name ?? job?.title ?? job?.description ?? "Unnamed Service";
  }

  // ----------------------------
  // Styles (ported from shadow CSS)
  // ----------------------------
  const STYLE_ID = "aa-sidepanel-style";

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500;9..40,600;9..40,700&display=swap');

      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        background: #FBFBFC;
        color: #1A1A2E;
      }

      #app { height: 100%; }

      /* Root container */
      #aa-shadow-root{
        height: 100%;
        display: flex;
        flex-direction: column;
        background: #FBFBFC;
        border-left: 1px solid #E8E8EC;
        overflow: hidden;
        position: relative;
        border-radius: 0;
        font-size: 13px;
        color: #1A1A2E;
      }

      .aa-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
      .aa-scroll::-webkit-scrollbar { width: 4px; }
      .aa-scroll::-webkit-scrollbar-track { background: transparent; }
      .aa-scroll::-webkit-scrollbar-thumb { background: #D1D1DB; border-radius: 4px; }

      .aa-header {
        padding: 16px 20px 14px;
        border-bottom: 1px solid #E8E8EC;
        display: flex; align-items: center; gap: 12px;
        background: #FBFBFC;
        position: relative; z-index: 3;
        flex-shrink: 0;
      }

      .aa-header-back {
        width: 28px; height: 28px; border-radius: 8px;
        border: 1px solid #E0E0E8; background: #fff;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; color: #5B5B76; font-size: 14px;
        transition: all 0.15s ease;
      }
      .aa-header-back:hover { border-color: #B0B0C0; color: #1A1A2E; }
      .aa-header-info { flex: 1; min-width: 0; }
      .aa-header-title {
        font-size: 14px; font-weight: 600; color: #1A1A2E;
        letter-spacing: -0.01em; line-height: 1.3;
      }
      .aa-header-meta {
        font-size: 11.5px; color: #8888A0; margin-top: 1px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .aa-header-close {
        width: 28px; height: 28px; border: none; background: transparent;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; color: #8888A0; font-size: 16px;
        transition: all 0.15s ease; flex-shrink: 0;
        border-radius: 8px;
      }
      .aa-header-close:hover { background: #F0F0F5; color: #1A1A2E; }

      .aa-steps {
        display: flex; align-items: center; gap: 0;
        padding: 12px 20px; border-bottom: 1px solid #E8E8EC;
        background: #FBFBFC; flex-shrink: 0;
      }
      .aa-step { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 500; color: #B0B0C0; transition: color 0.2s ease; }
      .aa-step.active { color: #1A1A2E; }
      .aa-step.done { color: #3B82F6; }
      .aa-step-num {
        width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid #D1D1DB; background: #fff;
        display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: #B0B0C0;
        transition: all 0.2s ease;
      }
      .aa-step.active .aa-step-num { border-color: #1A1A2E; color: #1A1A2E; background: #fff; }
      .aa-step.done .aa-step-num { border-color: #3B82F6; background: #3B82F6; color: #fff; }
      .aa-step-line { flex: 1; height: 1px; background: #E0E0E8; margin: 0 10px; }
      .aa-step-line.done { background: #3B82F6; }

      .aa-content { padding: 20px; }
      .aa-section { margin-bottom: 24px; }
      .aa-section:last-child { margin-bottom: 0; }
      .aa-section-label { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #8888A0; margin-bottom: 10px; }
      .aa-field-row { display: flex; gap: 10px; }
      .aa-field { flex: 1; min-width: 0; }
      .aa-field-label { font-size: 11px; font-weight: 500; color: #6B6B82; margin-bottom: 5px; display: flex; align-items: center; gap: 5px; }

      .aa-select {
        width: 100%; padding: 9px 30px 9px 11px; border: 1px solid #E0E0E8; border-radius: 8px; background: #fff;
        font-size: 13px; color: #1A1A2E; font-family: inherit; font-weight: 500; appearance: none; cursor: pointer;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238888A0' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 11px center; transition: border-color 0.15s ease;
      }
      .aa-select:hover { border-color: #C0C0D0; }
      .aa-select:focus { outline: none; border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
      .aa-select-recommended { border-color: #3B82F6; }
      .aa-rec-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; color: #3B82F6; margin-top: 6px; }
      .aa-rec-badge svg { width: 12px; height: 12px; }

      .aa-visit-summary { background: #fff; border: 1px solid #E8E8EC; border-radius: 10px; padding: 14px 16px; margin-top: 14px; }
      .aa-visit-date { font-size: 20px; font-weight: 700; color: #1A1A2E; letter-spacing: -0.03em; line-height: 1.2; }
      .aa-visit-mileage { font-size: 12px; color: #6B6B82; margin-top: 3px; font-weight: 500; }

      .aa-date-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
      .aa-date-btn {
        padding: 10px 4px 8px; border: 1px solid #E0E0E8; border-radius: 8px; background: #fff; cursor: pointer;
        text-align: center; transition: all 0.15s ease; display: flex; flex-direction: column; align-items: center; gap: 1px;
      }
      .aa-date-btn:hover { border-color: #C0C0D0; background: #F8F8FC; }
      .aa-date-btn .aa-date-dow { font-size: 10px; font-weight: 600; color: #8888A0; text-transform: uppercase; letter-spacing: 0.04em; }
      .aa-date-btn .aa-date-day { font-size: 15px; font-weight: 700; color: #1A1A2E; line-height: 1.3; }
      .aa-date-btn .aa-date-month { font-size: 10px; color: #8888A0; font-weight: 500; }
      .aa-date-btn .aa-date-count { font-size: 9px; color: #B0B0C0; margin-top: 2px; font-weight: 500; }
      .aa-date-btn.active { background: #1A1A2E; border-color: #1A1A2E; }
      .aa-date-btn.active .aa-date-dow, .aa-date-btn.active .aa-date-day, .aa-date-btn.active .aa-date-month { color: #fff; }
      .aa-date-btn.active .aa-date-count { color: rgba(255,255,255,0.6); }
      .aa-hint-text { font-size: 11px; color: #B0B0C0; margin-top: 6px; }

      .aa-toggle-group { display: flex; gap: 6px; }
      .aa-toggle-btn { flex: 1; padding: 10px 8px; border: 1px solid #E0E0E8; border-radius: 8px; background: #fff; cursor: pointer; font-family: inherit; font-size: 12.5px; font-weight: 500; color: #5B5B76; text-align: center; transition: all 0.15s ease; }
      .aa-toggle-btn:hover { border-color: #C0C0D0; }
      .aa-toggle-btn.active { background: #1A1A2E; border-color: #1A1A2E; color: #fff; font-weight: 600; }

      .aa-time-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
      .aa-time-btn { padding: 7px 4px 6px; border: 1px solid #E0E0E8; border-radius: 7px; background: #fff; cursor: pointer; font-family: inherit; color: #5B5B76; text-align: center; transition: all 0.15s ease; display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
      .aa-time-label { font-size: 11.5px; font-weight: 500; }
      .aa-time-btn:hover { border-color: #C0C0D0; }
      .aa-time-btn.active { background: #1A1A2E; border-color: #1A1A2E; color: #fff; font-weight: 600; }
      .aa-time-btn.active .aa-time-booked { color: rgba(255, 255, 255, 0.85); }

      .aa-check-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #E8E8EC; border-radius: 8px; background: #fff; cursor: pointer; margin-bottom: 5px; transition: all 0.15s ease; }
      .aa-check-item:last-child { margin-bottom: 0; }
      .aa-check-item:hover { border-color: #D0D0DD; }
      .aa-check-item.checked { border-color: #3B82F6; background: #F5F8FF; }
      .aa-check-box { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid #D1D1DB; background: #fff; flex-shrink: 0; display: flex; align-items: center; justify-content: center; transition: all 0.15s ease; }
      .aa-check-item.checked .aa-check-box { border-color: #3B82F6; background: #3B82F6; }
      .aa-check-box svg { width: 10px; height: 10px; }
      .aa-check-name { flex: 1; font-size: 12.5px; color: #1A1A2E; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .aa-check-expand { width: 22px; height: 22px; border-radius: 5px; border: none; background: #F0F0F5; cursor: pointer; display: none; align-items: center; justify-content: center; color: #8888A0; font-size: 12px; flex-shrink: 0; transition: all 0.15s ease; }
      .aa-check-expand:hover { background: #E0E0EA; }
      .aa-check-item.expanded .aa-check-name { white-space: normal; overflow: visible; text-overflow: unset; }
      .aa-check-item.expanded .aa-check-expand { transform: rotate(180deg); }

      .aa-empty-note { font-size: 12px; color: #B0B0C0; font-style: italic; padding: 4px 0; }

      .aa-textarea { width: 100%; min-height: 76px; padding: 10px 12px; border: 1px solid #E0E0E8; border-radius: 8px; font-family: inherit; font-size: 13px; color: #1A1A2E; resize: vertical; box-sizing: border-box; background: #fff; transition: border-color 0.15s ease; }
      .aa-textarea:focus { outline: none; border-color: #3B82F6; box-shadow: 0 0 0 3px rgba(59,130,246,0.1); }
      .aa-textarea::placeholder { color: #B0B0C0; }

      .aa-preview-box { background: #F5F5F8; border: 1px solid #E8E8EC; border-radius: 8px; padding: 12px 14px; font-size: 12px; color: #5B5B76; line-height: 1.5; white-space: pre-wrap; font-family: 'DM Sans', -apple-system, sans-serif; max-height: 140px; overflow-y: auto; }

      .aa-footer { padding: 14px 20px 16px; border-top: 1px solid #E8E8EC; background: #FBFBFC; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px; }

      .aa-btn-primary { width: 100%; padding: 12px 16px; border: none; border-radius: 8px; font-family: inherit; font-size: 13.5px; font-weight: 600; color: #fff; background: #1A1A2E; cursor: pointer; transition: all 0.15s ease; letter-spacing: -0.005em; }
      .aa-btn-primary:hover { background: #2A2A42; }
      .aa-btn-primary:active { background: #12121F; transform: scale(0.995); }
      .aa-btn-primary:disabled { background: #C0C0D0; cursor: not-allowed; }

      .aa-btn-secondary { width: 100%; padding: 10px 16px; border: 1px solid #E0E0E8; border-radius: 8px; background: #fff; font-family: inherit; font-size: 12.5px; font-weight: 500; color: #5B5B76; cursor: pointer; transition: all 0.15s ease; }
      .aa-btn-secondary:hover { border-color: #C0C0D0; color: #1A1A2E; }

      .aa-btn-link { background: none; border: none; font-family: inherit; font-size: 12px; color: #3B82F6; cursor: pointer; padding: 6px 0; font-weight: 500; transition: color 0.15s ease; }
      .aa-btn-link:hover { color: #2563EB; }

      .aa-color-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; }
      .aa-color-btn { padding: 8px 4px; border: 1px solid #E0E0E8; border-radius: 8px; background: #fff; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 4px; transition: all 0.15s ease; }
      .aa-color-btn:hover { border-color: #C0C0D0; }
      .aa-color-btn.active { border-color: #1A1A2E; border-width: 2px; }
      .aa-color-chip { width: 14px; height: 14px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.08); }
      .aa-color-name { font-size: 9px; color: #8888A0; font-weight: 500; text-transform: capitalize; }
      .aa-color-btn.active .aa-color-name { color: #1A1A2E; font-weight: 600; }

      .aa-confirmed-card { background: #F0FDF4; border: 1px solid #BBF7D0; border-radius: 10px; padding: 16px; text-align: center; }
      .aa-confirmed-check { width: 36px; height: 36px; border-radius: 50%; background: #22C55E; display: inline-flex; align-items: center; justify-content: center; margin-bottom: 8px; }
      .aa-confirmed-check svg { width: 18px; height: 18px; }
      .aa-confirmed-title { font-size: 15px; font-weight: 700; color: #15803D; }
      .aa-confirmed-id { font-size: 11.5px; color: #5B5B76; margin-top: 3px; }

      .aa-detail-row { display: flex; justify-content: space-between; align-items: baseline; padding: 7px 0; border-bottom: 1px solid #F0F0F5; }
      .aa-detail-row:last-child { border-bottom: none; }
      .aa-detail-key { font-size: 12px; color: #8888A0; font-weight: 500; }
      .aa-detail-val { font-size: 12.5px; color: #1A1A2E; font-weight: 600; text-align: right; }

      .aa-error-banner { background: #FFF1F2; border: 1px solid #FECDD3; color: #BE123C; border-radius: 8px; padding: 10px 12px; font-size: 12px; line-height: 1.4; }

      .aa-tip-trigger {
  width: 15px; height: 15px; border-radius: 50%;
  background: #E8E8EC; color: #6B6B82;
  font-size: 10px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer;
  position: relative;
}

/* Popover: fixed so it is NOT clipped by overflow containers */
.aa-tip-content {
  position: fixed;
  top: 0; left: 0;            /* JS will place it */
  width: 260px;
  max-width: calc(100vw - 24px); /* always fit in sidepanel width */
  box-sizing: border-box;

  background: #fff;
  border: 1px solid #E0E0E8;
  border-radius: 10px;
  padding: 14px;
  font-size: 11.5px;
  line-height: 1.55;
  color: #1A1A2E;
  box-shadow: 0 12px 40px rgba(0,0,0,0.12);

  opacity: 0;
  pointer-events: none;
  transform: translateY(4px);
  transition: opacity 0.15s ease, transform 0.15s ease;
  z-index: 1000002;
}

.aa-tip-content.aa-open {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

      .aa-confidence { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; margin-bottom: 8px; }
      .aa-conf-dot { width: 7px; height: 7px; border-radius: 50%; }
      .aa-conf-dot.high { background: #22C55E; }
      .aa-conf-dot.medium { background: #EAB308; }
      .aa-conf-dot.low { background: #EF4444; }
      .aa-tip-divider { height: 1px; background: #F0F0F5; margin: 8px 0; }
      .aa-tip-row { font-size: 11px; color: #5B5B76; line-height: 1.6; }
      .aa-tip-row strong { color: #1A1A2E; }

      .aa-date-btn:focus, .aa-toggle-btn:focus, .aa-time-btn:focus, .aa-color-btn:focus, .aa-btn-primary:focus, .aa-btn-secondary:focus {
        outline: none; box-shadow: 0 0 0 3px rgba(59,130,246,0.15);
      }

      @keyframes aa-fade-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .aa-animate-in { animation: aa-fade-in 0.3s ease forwards; }
    `;
    document.head.appendChild(style);
  }

  // ----------------------------
  // UI HTML helpers (ported)
  // ----------------------------
  function stepsHTML(activeStep) {
    const labels = ["Schedule", "Details", "Confirm"];
    return `<div class="aa-steps">${labels
      .map((label, i) => {
        const num = i + 1;
        const cls = num < activeStep ? "done" : num === activeStep ? "active" : "";
        const line =
          i < labels.length - 1
            ? `<div class="aa-step-line ${num < activeStep ? "done" : ""}"></div>`
            : "";
        return `<div class="aa-step ${cls}"><div class="aa-step-num">${
          num < activeStep ? "✓" : num
        }</div><span>${label}</span></div>${line}`;
      })
      .join("")}</div>`;
  }

  function headerHTML({ title, subtitle, showBack, showClose }) {
    return `<div class="aa-header">
      ${showBack ? `<div class="aa-header-back" id="aa-back-btn">←</div>` : ""}
      <div class="aa-header-info">
        <div class="aa-header-title">${title}</div>
        ${subtitle ? `<div class="aa-header-meta">${subtitle}</div>` : ""}
      </div>
      ${
        showClose !== false
          ? `<button class="aa-header-close" id="aa-close-btn" title="Close">✕</button>`
          : ""
      }
    </div>`;
  }

  function schedulerFooterButtonHTML(extraClass = "") {
    const classes = ["aa-btn-secondary", extraClass].filter(Boolean).join(" ");
    return `<button class="${classes}" data-aa-open-scheduler="1">Open Full Scheduler</button>`;
  }

  function bindOpenSchedulerButtons(dateOverride) {
    document.querySelectorAll("[data-aa-open-scheduler='1']").forEach((btn) => {
      if (!(btn instanceof HTMLElement)) return;
      btn.onclick = () => openFullScheduler(dateOverride);
    });
  }

  function wireMileageTooltipPositioning() {
  const trigger = document.querySelector(".aa-tip-trigger");
  const tip = uiId("aa-mileage-tooltip");
  if (!trigger || !tip) return;

  // Avoid double-binding if renderScreen1 runs again
  if (trigger.dataset.aaTipBound === "1") return;
  trigger.dataset.aaTipBound = "1";

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  const position = () => {
    const r = trigger.getBoundingClientRect();

    // Measure tooltip (needs to be visible briefly to get accurate size)
    tip.classList.add("aa-open");
    const tr = tip.getBoundingClientRect();

    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below trigger; if not enough space, go above.
    let top = r.bottom + 8;
    if (top + tr.height + pad > vh) {
      top = r.top - tr.height - 8;
    }
    top = clamp(top, pad, Math.max(pad, vh - tr.height - pad));

    // Align right edge to trigger, but clamp inside viewport.
    let left = r.right - tr.width;
    left = clamp(left, pad, Math.max(pad, vw - tr.width - pad));

    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  };

  const open = () => {
    // Make visible, then position
    tip.classList.add("aa-open");
    position();
  };

  const close = () => {
    tip.classList.remove("aa-open");
  };

  trigger.addEventListener("mouseenter", open);
  trigger.addEventListener("mouseleave", close);
  tip.addEventListener("mouseenter", open);
  tip.addEventListener("mouseleave", close);

  window.addEventListener("resize", () => {
    if (tip.classList.contains("aa-open")) position();
  });
}

    function bindHeaderControls() {
    const closeBtn = uiId("aa-close-btn");
    if (closeBtn) closeBtn.onclick = onHeaderX;
  }
  
    function onHeaderX() {
    // X should open Search UI (for now), not close/clear the app.
    uiMode = "search";
    searchState.error = "";
    // Keep whatever the last query was; if you prefer blank every time, uncomment next line:
    // searchState.query = "";
    renderSearchScreen(rootElRef);
  }

  async function onClose() {
  await chrome.storage.local.set({ aaSidePanelOpen: false });
  await clearContextAndState();
  panelState = getDefaultPanelState();
  renderNoContext();
}

  // ----------------------------
  // Scheduler link (ported)
  // ----------------------------
  function openFullScheduler(dateOverride) {
  const ro = panelState.roData;
  if (!ro?.shopId) return;

  const origin = cachedContext?.origin || "https://shop.tekmetric.com";
  const selectedDate =
    dateOverride || panelState.scheduledStartTime || panelState.appointment.date || new Date();

  const schedulerUrl = new URL(`/admin/shop/${ro.shopId}/appointments`, origin);
  schedulerUrl.searchParams.set("date", new Date(selectedDate).toISOString());

  // Keep RO context in the scheduler tab
  if (panelState.sourceRoId) schedulerUrl.searchParams.set(RO_ID_QUERY_PARAM, panelState.sourceRoId);

  // IMPORTANT: must be synchronous inside click handler
  window.open(schedulerUrl.toString(), "_blank", "noopener,noreferrer");
}

  // ----------------------------
  // Rendering screens
  // ----------------------------
  function renderNoContext() {
    app.innerHTML = `
      <div id="aa-shadow-root">
        ${headerHTML({ title: "Advance Appointment Scheduler", subtitle: null, showBack: false })}
        <div class="aa-scroll">
          <div class="aa-content">
            <div class="aa-error-banner" style="background:#fff;border-color:#E8E8EC;color:#5B5B76;">
              Open a Tekmetric Repair Order (Payment tab), then click the shimmering button to launch.
            </div>
          </div>
        </div>
      </div>
    `;
    bindHeaderControls();
  }

  function renderLoading(subtitle) {
    app.innerHTML = `
      <div id="aa-shadow-root">
        ${headerHTML({ title: "Advance Appointment Scheduler", subtitle: subtitle || "Loading…", showBack: false })}
        <div class="aa-scroll">
          <div class="aa-content">
            <div class="aa-hint-text">Loading repair order…</div>
          </div>
        </div>
      </div>
    `;
    bindHeaderControls();
  }

    function renderSearchScreen(rootEl) {
    if (!rootEl) return;

    // We need a shopId to search within the current shop only.
    const shopId = cachedContext?.shopId || panelState?.roData?.shopId || null;

    rootEl.innerHTML = `
      ${headerHTML({
        title: "Search Repair Orders",
        subtitle: shopId ? `Shop #${shopId} · OPEN (Estimate/WIP/Complete)` : "Missing shop context",
        showBack: false
      })}
      <div class="aa-scroll">
        <div class="aa-content">
          <div class="aa-section">
            <div class="aa-section-label">Search</div>
            <input
              id="aa-search-input"
              class="aa-textarea"
              style="min-height:unset;height:40px;resize:none;"
              placeholder="Search by RO #, customer, or vehicle…"
              value="${escapeHtml(searchState.query)}"
            />
            <div class="aa-hint-text" style="margin-top:8px;">
              Searching OPEN only: Estimate, Work-in-Progress, Complete (not posted)
            </div>
          </div>

          ${
            !shopId
              ? `<div class="aa-error-banner">Can’t search yet — shopId is missing. Open any RO first.</div>`
              : searchState.error
                ? `<div class="aa-error-banner">${escapeHtml(searchState.error)}</div>`
                : ""
          }

          ${
            searchState.loading
              ? `<div class="aa-hint-text">Searching…</div>`
              : ""
          }

          <div id="aa-search-results"></div>
        </div>
      </div>
      <div class="aa-footer">
        <button class="aa-btn-secondary" id="aa-search-cancel-btn">Back to Scheduler</button>
      </div>
    `;

    // Wire input + debounce search
    const input = uiId("aa-search-input");
    if (input) {
      input.focus();
      input.addEventListener("input", (e) => {
        searchState.query = e.target.value || "";
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          void runSearch();
        }, SEARCH_DEBOUNCE_MS);
      });
    }

    // Back button -> return to wizard
    const cancelBtn = uiId("aa-search-cancel-btn");
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        uiMode = "wizard";
        renderCurrentScreen(rootElRef);
      };
    }

    // Initial render of results (possibly empty)
    renderSearchResults(rootEl);
  }

  function renderSearchResults(rootEl) {
    const container = uiId("aa-search-results");
    if (!container) return;

    const results = Array.isArray(searchState.results) ? searchState.results : [];
    if (!results.length && !searchState.loading && searchState.query.trim()) {
      container.innerHTML = `<div class="aa-hint-text">No results.</div>`;
      return;
    }
    if (!results.length && !searchState.loading) {
      container.innerHTML = `<div class="aa-hint-text">Type to search…</div>`;
      return;
    }

    container.innerHTML = results
      .map((r) => {
        const roId = r.id ?? r.roId ?? "";
        const roNum = r.repairOrderNumber ?? r.roNumber ?? "—";
        const customer = r.customerName ?? r.customer ?? "";
        const vehicle = r.vehicle ?? r.vehicleLabel ?? "";
        const status = r.repairOrderStatus?.name ?? r.status ?? "";

        return `
          <div class="aa-check-item" data-ro-id="${escapeHtml(String(roId))}" style="cursor:pointer;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;color:#1A1A2E;">RO #${escapeHtml(String(roNum))}</div>
              <div style="font-size:12px;color:#6B6B82;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${escapeHtml(customer)} · ${escapeHtml(vehicle)}
              </div>
              <div style="font-size:11px;color:#8888A0;margin-top:2px;">${escapeHtml(status)}</div>
            </div>
            <div style="color:#8888A0;font-size:14px;">→</div>
          </div>
        `;
      })
      .join("");

    // Click handler: load selected RO and return to wizard screen 1
    container.querySelectorAll("[data-ro-id]").forEach((row) => {
      row.addEventListener("click", async () => {
        const roId = row.getAttribute("data-ro-id");
        if (!roId) return;

        // Reset wizard to screen 1 for the selected RO
        uiMode = "wizard";
        await chrome.storage.local.remove([PANEL_STATE_STORAGE_KEY]);
        panelState = getDefaultPanelState();

        // Update context with the new RO id (keep origin + shopId)
        const nextCtx = {
          ...(cachedContext || {}),
          roId: String(roId)
        };
        await setContext(nextCtx);

        // Re-run boot to load RO, history, etc.
        void boot();
      });
    });
  }

  async function runSearch() {
    const shopId = cachedContext?.shopId || panelState?.roData?.shopId || null;
    const q = (searchState.query || "").trim();

    if (!shopId) return;
    if (!q) {
      searchState.results = [];
      searchState.error = "";
      searchState.loading = false;
      renderSearchScreen(rootElRef);
      return;
    }

    searchState.loading = true;
    searchState.error = "";
    renderSearchScreen(rootElRef);

    try {
      const payload = await searchOpenRepairOrders(shopId, q);

      // normalize results from your Cloud Run response shape
      const rows =
        payload.results ||
        payload.content ||
        payload.repairOrders ||
        payload.data ||
        [];

      searchState.results = Array.isArray(rows) ? rows : [];
      searchState.loading = false;
      renderSearchScreen(rootElRef);
    } catch (err) {
      searchState.loading = false;
      searchState.error = err?.message || "Search failed";
      renderSearchScreen(rootElRef);
    }
  }

  // tiny helper to prevent HTML injection in templates
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderCurrentScreen(rootEl) {
    if (uiMode === "search") return renderSearchScreen(rootEl);
    if (panelState.screen === 2) return renderScreen2(rootEl);
    if (panelState.screen === 3) return renderScreen3(rootEl);
    return renderScreen1(rootEl);
  }

  function renderScreen1(rootEl) {
    const token = nextRenderToken();
    panelState.screen = 1;
    panelState.isConfirmed = false;
    panelState.scheduledAppointmentId = null;
    panelState.scheduledStartTime = null;

    const data = panelState.roData;
    const baseDate = recalculateSmartValues();
    const dateOptions = getFiveSelectableDates(baseDate);

    const weekStart = dateOptions[0];
    const weekEnd = dateOptions[dateOptions.length - 1];
    const nextWeekKey = `${panelState.roData?.shopId ?? ""}:${getDateKey(weekStart)}:${getDateKey(weekEnd)}`;
    // Safety: if loading got stuck, reset after 20s so we can refetch
if (
  panelState.appointmentCountsLoading &&
  panelState.appointmentCountsLoadingStartedAt &&
  Date.now() - panelState.appointmentCountsLoadingStartedAt > 20000
) {
  panelState.appointmentCountsLoading = false;
  panelState.appointmentCountsLoadingStartedAt = null;
}

    if (
      panelState.roData?.shopId &&
      panelState.appointmentCountWeekKey !== nextWeekKey &&
      !panelState.appointmentCountsLoading
    ) {
      panelState.appointmentCountsLoading = true;
      panelState.appointmentCountWeekKey = nextWeekKey;
      panelState.appointmentCountsLoadingStartedAt = Date.now();

      fetchAppointmentCounts(panelState.roData.shopId, weekStart, weekEnd)
  .then((counts) => {
    panelState.appointmentCounts = counts || {};
  })
  .catch(() => {
    panelState.appointmentCounts = {};
  })
  .finally(() => {
  panelState.appointmentCountsLoading = false;
  panelState.appointmentCountsLoadingStartedAt = null;

  // Side panel can delay rAF until interaction; repaint immediately.
  if (panelState.screen === 1 && rootEl && rootEl.isConnected) {
    try {
      renderScreen1(rootEl);
    } catch {}
    // Extra safety: if something else swaps DOM right after, repaint again next tick.
    setTimeout(() => {
      if (panelState.screen === 1 && rootEl && rootEl.isConnected) {
        try { renderScreen1(rootEl); } catch {}
      }
    }, 0);
  }

  try {
    void persistPanelState();
  } catch {}
});

    }

    const selectedDate = panelState.appointment.date ? new Date(panelState.appointment.date) : null;
    const selectedInOptions = selectedDate
      ? dateOptions.some((d) => d.toDateString() === selectedDate.toDateString())
      : false;
    if (!selectedInOptions) panelState.appointment.date = new Date(dateOptions[0]);

    const roNumber = data?.roNumber ?? "—";
    const customerName = data?.customer
      ? `${data.customer.firstName ?? ""} ${data.customer.lastName ?? ""}`.trim()
      : "";
    const vehicleDisplay = data?.vehicle
      ? `${data.vehicle.year ?? ""} ${data.vehicle.make ?? ""} ${data.vehicle.model ?? ""}`.trim()
      : "";

    const recommendedMonth = getSmartRecommendedMonth();
    if (
      recommendedMonth &&
      !panelState.hasUserSelectedMonthInterval &&
      panelState.monthInterval === SHOP_CONFIG.defaultMonths
    ) {
      panelState.monthInterval = recommendedMonth;
    }

    rootEl.innerHTML = `
      ${headerHTML({
        title: "Advance Appointment Scheduler",
        subtitle: `RO #${roNumber} · ${customerName} · ${vehicleDisplay}`,
        showBack: false
      })}
      ${stepsHTML(1)}
      <div class="aa-scroll">
        <div class="aa-content">
          <div class="aa-section">
            <div class="aa-section-label">Interval</div>
            <div class="aa-field-row">
              <div class="aa-field">
                <div class="aa-field-label">Months</div>
                <select class="aa-select" id="aa-month-interval"></select>
              </div>
              <div class="aa-field">
                <div class="aa-field-label">
                  Est. Mileage
                  <span class="aa-tip-trigger">?<div class="aa-tip-content" id="aa-mileage-tooltip"></div></span>
                </div>
                <select class="aa-select" id="aa-mile-interval"></select>
              </div>
            </div>
            <div id="aa-rec-area"></div>
          </div>

          <div class="aa-section">
            <div class="aa-visit-summary">
              <div class="aa-visit-date">${formatShortDate(panelState.appointment.date)}</div>
              ${
                panelState.appointment.mileage
                  ? `<div class="aa-visit-mileage">${formatMiles(
                      panelState.appointment.mileage
                    )} estimated miles</div>`
                  : ""
              }
            </div>
          </div>

          <div class="aa-section">
            <div class="aa-section-label">Select Day</div>
            <div class="aa-date-grid" id="aa-date-buttons"></div>
            <div class="aa-hint-text" id="aa-appointment-counts-status"></div>
          </div>
        </div>
      </div>
      <div class="aa-footer">
        ${schedulerFooterButtonHTML()}
        <button class="aa-btn-primary" id="aa-continue-btn">Continue</button>
      </div>
    `;

    bindHeaderControls();

    const monthSelect = uiId("aa-month-interval");
    for (let i = SHOP_CONFIG.minMonths; i <= SHOP_CONFIG.maxMonths; i++) {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${i} months`;
      if (i === panelState.monthInterval) opt.selected = true;
      monthSelect.appendChild(opt);
    }
    monthSelect.classList.toggle("aa-select-recommended", panelState.monthInterval === recommendedMonth);

    const recArea = uiId("aa-rec-area");
    if (recommendedMonth && panelState.monthInterval === recommendedMonth) {
      recArea.innerHTML = `<div class="aa-rec-badge">
        <svg viewBox="0 0 16 16" fill="none"><path d="M8 1l2.1 4.2L15 6l-3.5 3.4.8 4.8L8 12l-4.3 2.2.8-4.8L1 6l4.9-.8L8 1z" fill="#3B82F6"/></svg>
        Recommended — based on driving history
      </div>`;
    } else {
      recArea.innerHTML = "";
    }

    monthSelect.onchange = async (e) => {
      panelState.hasUserSelectedMonthInterval = true;
      panelState.monthInterval = Number(e.target.value);
      panelState.appointment.mileage = getProjectedMileage(panelState.monthInterval);
      panelState.appointment.date = null;
      await persistPanelState();
      renderScreen1(rootEl);
    };

    const mileSelect = uiId("aa-mile-interval");
    const avgMilesPerDay = panelState.vehicleAvgMilesPerDay ?? null;

    for (let month = SHOP_CONFIG.minMonths; month <= SHOP_CONFIG.maxMonths; month++) {
      let milesAhead;
      if (Number.isFinite(avgMilesPerDay) && avgMilesPerDay > 0) {
        const daysAhead = month * 30.4375;
        milesAhead = Math.round(avgMilesPerDay * daysAhead);
      } else {
        milesAhead = month * 1000;
      }
      const opt = document.createElement("option");
      opt.value = month;
      opt.textContent = `${milesAhead.toLocaleString()} mi`;
      if (month === panelState.monthInterval) opt.selected = true;
      mileSelect.appendChild(opt);
    }

    mileSelect.onchange = async (e) => {
      const selectedMonth = Number(e.target.value);
      panelState.hasUserSelectedMonthInterval = true;
      panelState.monthInterval = selectedMonth;
      panelState.appointment.mileage = getProjectedMileage(selectedMonth);
      panelState.appointment.date = null;
      await persistPanelState();
      renderScreen1(rootEl);
    };

    const breakdown = getMileageMathBreakdown(panelState.monthInterval);
    const tooltipEl = uiId("aa-mileage-tooltip");
    if (breakdown && tooltipEl) {
      if (breakdown.fallback) {
        tooltipEl.innerHTML = `
          <div class="aa-tip-row"><strong>Estimated (Default)</strong></div>
          <div class="aa-tip-divider"></div>
          <div class="aa-tip-row">
            Current: ${formatMiles(breakdown.currentMileage)} mi<br/>
            Default: 1,000 mi/month<br/>
            Months: ${breakdown.months}<br/><br/>
            Increase: +${formatMiles(breakdown.projectedIncrease)}<br/>
            <strong>Projected: ${formatMiles(breakdown.projectedMileage)} mi</strong>
          </div>`;
      } else {
        const confidence = getConfidenceLevel();
        const spanMonths = panelState.vehicleHistorySpanDays
          ? Math.round(panelState.vehicleHistorySpanDays / 30)
          : null;
        tooltipEl.innerHTML = `
          <div class="aa-confidence">
            <div class="aa-conf-dot ${confidence.tone}"></div>
            ${confidence.label} Confidence
          </div>
          <div class="aa-tip-divider"></div>
          <div class="aa-tip-row">
            ${panelState.vehicleDataPointCount} data points · ${spanMonths ?? "—"} months history
          </div>
          <div class="aa-tip-divider"></div>
          <div class="aa-tip-row">
            Current: ${formatMiles(breakdown.currentMileage)} mi<br/>
            Avg: ${breakdown.avgMilesPerDay.toFixed(1)} mi/day · ${Math.round(
          breakdown.milesPerMonth
        ).toLocaleString()} mi/month<br/>
            Months: ${breakdown.months}<br/><br/>
            Increase: +${Math.round(breakdown.projectedIncrease).toLocaleString()}<br/>
            <strong>Projected: ${formatMiles(breakdown.projectedMileage)} mi</strong>
          </div>`;
      }
    }
    wireMileageTooltipPositioning();

    const dateContainer = uiId("aa-date-buttons");
if (dateContainer) dateContainer.innerHTML = "";

dateOptions.forEach((date) => {
  const btn = document.createElement("button");
  btn.className = "aa-date-btn";
  const count = panelState.appointmentCounts[getDateKey(date)] ?? 0;
  const isActive =
    panelState.appointment.date &&
    new Date(panelState.appointment.date).toDateString() === new Date(date).toDateString();
  if (isActive) btn.classList.add("active");
  btn.innerHTML = `
    <span class="aa-date-dow">${date.toLocaleDateString(undefined, { weekday: "short" })}</span>
    <span class="aa-date-day">${date.getDate()}</span>
    <span class="aa-date-month">${date.toLocaleDateString(undefined, { month: "short" })}</span>
    <span class="aa-date-count">${count} appts</span>
  `;
  btn.onclick = async () => {
    panelState.appointment.date = new Date(date);
    await persistPanelState();
    renderScreen1(rootEl);
  };
  dateContainer.appendChild(btn);
});

    const statusEl = uiId("aa-appointment-counts-status");
if (statusEl) {
  const hasAnyCounts = panelState.appointmentCounts && Object.keys(panelState.appointmentCounts).length > 0;
  statusEl.textContent = panelState.appointmentCountsLoading
    ? "Loading availability…"
    : (hasAnyCounts ? "" : "Availability unavailable");
}

    bindOpenSchedulerButtons(panelState.appointment.date);

    const continueBtn = uiId("aa-continue-btn");
if (continueBtn) {
  continueBtn.onclick = async () => {
    panelState.screen = 2;
    await persistPanelState();
    renderScreen2(rootEl);
  };
}

void persistPanelState();
  }

  function loadTimeSlotCountsForSelectedDate(rootEl, token) {
  const selectedDate = panelState.appointment.date;
  const shopId = panelState.roData?.shopId;
  if (!selectedDate || !shopId) return;

  const selectedDateKey = getDateKey(selectedDate);
  if (panelState.timeSlotCountsDateKey === selectedDateKey || panelState.timeSlotCountsLoading) return;

  panelState.timeSlotCountsLoading = true;

  fetchTimeSlotCounts(shopId, selectedDate)
    .then((counts) => {
      panelState.timeSlotCounts = counts;
      panelState.timeSlotCountsDateKey = selectedDateKey;
    })
    .catch(() => {
      panelState.timeSlotCounts = { dropoff: {}, wait: {} };
      panelState.timeSlotCountsDateKey = selectedDateKey;
    })
    .finally(async () => {
      panelState.timeSlotCountsLoading = false;
      await persistPanelState();

      // Only re-render if we are still on this render token AND still on screen 2
      if (token === aaRenderToken && panelState.screen === 2 && rootEl && rootEl.isConnected) {
        renderScreen2(rootEl);
      }
    });
}

  function renderScreen2(rootEl) {
  const token = nextRenderToken();
  panelState.screen = 2;

  // Kick off async counts (token-gated) BEFORE rendering
  loadTimeSlotCountsForSelectedDate(rootEl, token);

  const roData = panelState.roData;

  const performedWithIds = getPerformedJobs(roData).map((j, idx) => ({
    ...j,
    _stableId: String(j.id ?? j.jobId ?? `p${idx}`)
  }));
  const declinedWithIds = getDeclinedJobs(roData).map((j, idx) => ({
    ...j,
    _stableId: String(j.id ?? j.jobId ?? `d${idx}`)
  }));

  rootEl.innerHTML = `
    ${headerHTML({
      title: "Appointment Details",
      subtitle: `${formatShortDate(panelState.appointment.date)} · ${
        panelState.appointment.mileage
          ? formatMiles(panelState.appointment.mileage) + " mi"
          : "mileage TBD"
      }`,
      showBack: true
    })}
    ${stepsHTML(2)}
    <div class="aa-scroll">
      <div class="aa-content">
        <div class="aa-section">
          <div class="aa-section-label">Drop-off or Wait</div>
          <div class="aa-toggle-group">
            <button class="aa-toggle-btn ${
              panelState.appointment.type === "dropoff" ? "active" : ""
            }" id="aa-type-dropoff">Drop-Off</button>
            <button class="aa-toggle-btn ${
              panelState.appointment.type === "wait" ? "active" : ""
            }" id="aa-type-wait">Waiter</button>
          </div>
        </div>

        <div class="aa-section">
          <div class="aa-section-label">Time</div>
          <div class="aa-time-grid" id="aa-time-grid"></div>
          <div class="aa-help" id="aa-time-counts-status"></div>
        </div>

        <div class="aa-section">
          <div class="aa-section-label">Repeat Services</div>
          <div id="aa-repeat-list">
            ${
              performedWithIds.length === 0
                ? `<div class="aa-empty-note">No performed services on this RO</div>`
                : performedWithIds
                    .map((j) => {
                      const checked = panelState.repeatServices.includes(j._stableId);
                      return `<div class="aa-check-item ${checked ? "checked" : ""}" data-id="${j._stableId}" data-group="repeat">
                        <div class="aa-check-box">${
                          checked
                            ? `<svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
                            : ""
                        }</div>
                        <span class="aa-check-name">${getJobName(j)}</span>
                        <button class="aa-check-expand">▾</button>
                      </div>`;
                    })
                    .join("")
            }
          </div>
        </div>

        <div class="aa-section">
          <div class="aa-section-label">Declined Services</div>
          <div id="aa-declined-list">
            ${
              declinedWithIds.length === 0
                ? `<div class="aa-empty-note">No declined services on this RO</div>`
                : declinedWithIds
                    .map((j) => {
                      const checked = panelState.declinedServices.includes(j._stableId);
                      return `<div class="aa-check-item ${checked ? "checked" : ""}" data-id="${j._stableId}" data-group="declined">
                        <div class="aa-check-box">${
                          checked
                            ? `<svg viewBox="0 0 10 10" fill="none"><path d="M2 5l2.5 2.5L8 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
                            : ""
                        }</div>
                        <span class="aa-check-name">${getJobName(j)}</span>
                        <button class="aa-check-expand">▾</button>
                      </div>`;
                    })
                    .join("")
            }
          </div>
        </div>

        <div class="aa-section">
          <div class="aa-section-label">Notes</div>
          <textarea class="aa-textarea" id="aa-customer-notes" placeholder="Loaner needed, special concerns, etc.">${panelState.customerNotes}</textarea>
        </div>

        <div class="aa-section">
          <div class="aa-section-label">Purpose of Visit Preview</div>
          <div class="aa-preview-box" id="aa-purpose-preview">${buildPurposeOfVisit(roData) || "No details selected."}</div>
        </div>

        <div id="aa-s2-error"></div>
      </div>
    </div>
    <div class="aa-footer">
      ${schedulerFooterButtonHTML()}
      <button class="aa-btn-primary" id="aa-continue-to-confirm-btn">Continue</button>
    </div>
  `;

  bindHeaderControls();

  const backBtn = uiId("aa-back-btn");
  if (backBtn) {
    backBtn.onclick = async () => {
      panelState.screen = 1;
      await persistPanelState();
      renderScreen1(rootEl);
    };
  }

  const dropBtn = uiId("aa-type-dropoff");
  if (dropBtn) {
    dropBtn.onclick = async () => {
      panelState.appointment.type = "dropoff";
      await persistPanelState();
      renderScreen2(rootEl);
    };
  }

  const waitBtn = uiId("aa-type-wait");
  if (waitBtn) {
    waitBtn.onclick = async () => {
      panelState.appointment.type = "wait";
      await persistPanelState();
      renderScreen2(rootEl);
    };
  }

  const timeGrid = uiId("aa-time-grid");
  if (!timeGrid) return;

  timeGrid.innerHTML = "";

  getHourlyTimeOptions().forEach((hour) => {
    const btn = document.createElement("button");
    btn.className = `aa-time-btn ${hour === panelState.appointment.hour ? "active" : ""}`;
    btn.innerHTML = `<span class="aa-time-label">${formatHourLabel(hour)}</span>`;
    btn.onclick = async () => {
      panelState.appointment.hour = hour;
      await persistPanelState();
      renderScreen2(rootEl);
    };
    timeGrid.appendChild(btn);
  });

  const timeCountStatus = uiId("aa-time-counts-status");
  if (timeCountStatus) {
    timeCountStatus.textContent = panelState.timeSlotCountsLoading ? "Loading scheduler counts…" : "";
  }

  function setupCheckList(containerId, stateKey) {
    const container = uiId(containerId);
    if (!container) return;

    container.querySelectorAll(".aa-check-item").forEach((item) => {
      const id = item.getAttribute("data-id");

      item.addEventListener("click", async (e) => {
        if (e.target.closest(".aa-check-expand")) return;

        const isChecked = panelState[stateKey].includes(id);
        if (isChecked) {
          panelState[stateKey] = panelState[stateKey].filter((x) => x !== id);
        } else {
          panelState[stateKey].push(id);
        }
        await persistPanelState();
        renderScreen2(rootEl);
      });

      const nameEl = item.querySelector(".aa-check-name");
      const expandBtn = item.querySelector(".aa-check-expand");
      if (nameEl && expandBtn) {
        requestAnimationFrame(() => {
          if (nameEl.scrollWidth > nameEl.clientWidth) expandBtn.style.display = "flex";
        });
      }
    });

    container.querySelectorAll(".aa-check-expand").forEach((toggle) => {
      toggle.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const item = toggle.closest(".aa-check-item");
        if (!item) return;
        const wasExpanded = item.classList.contains("expanded");
        container.querySelectorAll(".aa-check-item.expanded").forEach((el) => el.classList.remove("expanded"));
        if (!wasExpanded) item.classList.add("expanded");
      });
    });
  }

  setupCheckList("aa-repeat-list", "repeatServices");
  setupCheckList("aa-declined-list", "declinedServices");

  const notesEl = uiId("aa-customer-notes");
  if (notesEl) {
    notesEl.addEventListener("input", async (e) => {
      panelState.customerNotes = e.target.value;
      await persistPanelState();
      refreshPurposePreview(roData);
    });
  }

  bindOpenSchedulerButtons(panelState.appointment.date);

  const contBtn = uiId("aa-continue-to-confirm-btn");
  if (contBtn) {
    contBtn.onclick = async () => {
      panelState.screen = 3;
      panelState.isConfirmed = false;
      panelState.scheduledAppointmentId = null;
      panelState.scheduledStartTime = null;
      await persistPanelState();
      renderScreen3(rootEl);
    };
  }

  void persistPanelState();
}

  function buildTekmetricTitle(roData) {
    const customerName = roData?.customer
      ? `${roData.customer.firstName ?? ""} ${roData.customer.lastName ?? ""}`.trim()
      : "";
    const vehicleDisplay = roData?.vehicle
      ? `${roData.vehicle.year ?? ""} ${roData.vehicle.make ?? ""} ${roData.vehicle.model ?? ""} ${
          roData.vehicle.subModel ?? ""
        }`.trim()
      : "";
    return `Advance Appointment – ${customerName} – ${vehicleDisplay}`;
  }

  function buildPurposeOfVisit(roData) {
    const performedWithIds = getPerformedJobs(roData).map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `p${idx}`)
    }));
    const declinedWithIds = getDeclinedJobs(roData).map((j, idx) => ({
      ...j,
      _stableId: String(j.id ?? j.jobId ?? `d${idx}`)
    }));
    const lines = [];

    const repeatSelected = performedWithIds.filter((j) => panelState.repeatServices.includes(j._stableId));
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

    if (panelState.customerNotes.trim()) {
      lines.push("");
      lines.push("CUSTOMER INSTRUCTIONS:");
      lines.push(panelState.customerNotes.trim());
    }

    return lines.join("\n").trim();
  }

  function refreshPurposePreview(roData) {
    const preview = uiId("aa-purpose-preview");
    if (preview) preview.textContent = buildPurposeOfVisit(roData) || "No details selected.";
  }

  async function scheduleAppointment(rootEl) {
    const confirmBtn = uiId("aa-confirm-btn");
    const errorEl = uiId("aa-s3-error");
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Confirming…";
    }
    if (errorEl) errorEl.innerHTML = "";

    try {
      const ro = panelState.roData;
      const selectedDate = new Date(panelState.appointment.date);
      const selectedHour = panelState.appointment.hour || 8;

      const startTime = new Date(selectedDate);
      startTime.setHours(selectedHour, 0, 0, 0);
      const endTime = new Date(selectedDate);
      endTime.setHours(selectedHour + 1, 0, 0, 0);

      const result = await cloudRunFetch("/appointments", {
        method: "POST",
        body: {
          shopId: ro.shopId,
          customerId: ro.customer.id,
          vehicleId: ro.vehicle.id,
          title: buildTekmetricTitle(ro),
          description: buildPurposeOfVisit(ro),
          appointmentType: panelState.appointment.type,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          mileage: panelState.appointment.mileage,
          color: panelState.appointment.color
        }
      });

      if (!result || result.success === false) throw new Error(result?.message || "Scheduling failed");

      const appointmentId = result.appointment?.data ?? result.appointment?.id ?? "—";
      panelState.scheduledAppointmentId = String(appointmentId);
      panelState.scheduledStartTime = new Date(startTime);
      panelState.isConfirmed = true;
      await persistPanelState();
      renderScreen3(rootEl);
    } catch (err) {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirm Appointment";
      }
      if (errorEl) {
        errorEl.innerHTML = `<div class="aa-error-banner">Failed to schedule. ${
          err.message || "Please try again."
        }</div>`;
      }
    }
  }

  function getColorHex(name) {
    const map = {
      red: "#dc2626",
      pink: "#ec4899",
      yellow: "#eab308",
      orange: "#f97316",
      "light green": "#86efac",
      green: "#16a34a",
      blue: "#3b82f6",
      navy: "#1e3a8a",
      lavender: "#a78bfa",
      purple: "#9333ea"
    };
    return map[name] || "#1e3a8a";
  }

  function renderScreen3(rootEl) {
    const token = nextRenderToken();
    panelState.screen = 3;
    const ro = panelState.roData;

    const startTime = panelState.scheduledStartTime
      ? new Date(panelState.scheduledStartTime)
      : (() => {
          const d = new Date(panelState.appointment.date || new Date());
          d.setHours(panelState.appointment.hour || 8, 0, 0, 0);
          return d;
        })();

    const purposeText = buildPurposeOfVisit(ro) || "No details selected.";

    rootEl.innerHTML = `
      ${headerHTML({
        title: panelState.isConfirmed ? "Scheduled" : "Review & Confirm",
        subtitle: null,
        showBack: !panelState.isConfirmed
      })}
      ${stepsHTML(3)}
      <div class="aa-scroll">
        <div class="aa-content">
          ${
            panelState.isConfirmed
              ? `
            <div class="aa-confirmed-card aa-animate-in">
              <div class="aa-confirmed-check">
                <svg viewBox="0 0 18 18" fill="none"><path d="M4 9l3.5 3.5L14 5" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </div>
              <div class="aa-confirmed-title">Appointment Confirmed</div>
              <div class="aa-confirmed-id">ID: ${panelState.scheduledAppointmentId || "—"}</div>
            </div>
          `
              : ""
          }

          <div class="aa-section" style="margin-top:${panelState.isConfirmed ? "16px" : "0"};">
            <div class="aa-section-label">Summary</div>
            <div style="background:#fff; border:1px solid #E8E8EC; border-radius:10px; padding:14px 16px;">
              <div class="aa-detail-row">
                <span class="aa-detail-key">Date</span>
                <span class="aa-detail-val">${formatDate(startTime)}</span>
              </div>
              <div class="aa-detail-row">
                <span class="aa-detail-key">Time</span>
                <span class="aa-detail-val">${formatTime(startTime)}</span>
              </div>
              ${
                panelState.appointment.mileage
                  ? `
              <div class="aa-detail-row">
                <span class="aa-detail-key">Est. Mileage</span>
                <span class="aa-detail-val">${formatMiles(panelState.appointment.mileage)} mi</span>
              </div>`
                  : ""
              }
              <div class="aa-detail-row">
                <span class="aa-detail-key">Type</span>
                <span class="aa-detail-val">${panelState.appointment.type === "wait" ? "Waiter" : "Drop-Off"}</span>
              </div>
            </div>
          </div>

          ${
            purposeText !== "No details selected."
              ? `
          <div class="aa-section">
            <div class="aa-section-label">Purpose of Visit</div>
            <div class="aa-preview-box">${purposeText}</div>
          </div>`
              : ""
          }

          <div class="aa-section">
            <div class="aa-section-label">Calendar Color</div>
            <div class="aa-color-grid" id="aa-color-grid"></div>
          </div>

          <div id="aa-s3-error"></div>
        </div>
      </div>
      <div class="aa-footer">
        ${schedulerFooterButtonHTML()}
        ${
          panelState.isConfirmed
            ? `<button class="aa-btn-link" id="aa-view-mini-btn">View in Scheduler →</button>
               <button class="aa-btn-primary" id="aa-done-btn">Done</button>`
            : `<button class="aa-btn-primary" id="aa-confirm-btn">Confirm Appointment</button>`
        }
      </div>
    `;

    bindHeaderControls();

    if (!panelState.isConfirmed && uiId("aa-back-btn")) {
      uiId("aa-back-btn").onclick = async () => {
        panelState.screen = 2;
        await persistPanelState();
        renderScreen2(rootEl);
      };
    }

    const colorGrid = uiId("aa-color-grid");
    TEKMETRIC_COLORS.forEach((name) => {
      const btn = document.createElement("button");
      btn.className = `aa-color-btn ${panelState.appointment.color === name ? "active" : ""}`;
      btn.innerHTML = `<span class="aa-color-chip" style="background:${getColorHex(
        name
      )}"></span><span class="aa-color-name">${name}</span>`;
      btn.onclick = async () => {
        panelState.appointment.color = name;
        await persistPanelState();
        renderScreen3(rootEl);
      };
      colorGrid.appendChild(btn);
    });

    bindOpenSchedulerButtons(panelState.scheduledStartTime || startTime);

    if (!panelState.isConfirmed) {
      uiId("aa-confirm-btn").onclick = () => scheduleAppointment(rootEl);
    } else {
      uiId("aa-done-btn").onclick = async () => {
  await chrome.storage.local.set({ aaSidePanelOpen: false });
  await clearPersistedPanelState();
  // Actually close the side panel UI
  window.close();
};
      uiId("aa-view-mini-btn").onclick = () => {
        openFullScheduler(panelState.scheduledStartTime || startTime);
      };
    }

    void persistPanelState();
  }

  // ----------------------------
  // Boot / load context + RO
  // ----------------------------
  async function boot() {
    injectStyles();
    await chrome.storage.local.set({ aaSidePanelOpen: true });

    const ctx = await getContext();
    cachedContext = ctx;
    if (!ctx?.roId) {
      renderNoContext();
      return;
    }

    await restorePanelState();

    // Ensure roId in state matches context
    panelState.sourceRoId = String(ctx.roId);

    renderLoading(`RO #${ctx.roId}`);

    try {
      const roData = await fetchRoData(ctx.roId);
      panelState.roData = roData;

      // keep shopId in context for scheduler links
      try {
  const nextCtx = {
    ...ctx,
    roId: String(ctx.roId),
    shopId: roData?.shopId,
    origin: ctx.origin || "tekmetric"
  };

  // Only write if something actually changed.
  const same =
    String(ctx?.roId || "") === String(nextCtx.roId || "") &&
    String(ctx?.origin || "") === String(nextCtx.origin || "") &&
    String(ctx?.shopId || "") === String(nextCtx.shopId || "");

  if (!same) await setContext(nextCtx);
} catch {}

      try {
        const history = await fetchVehicleHistory(roData.vehicle.id, roData.shopId);
        panelState.vehicleAvgMilesPerDay = history.avgMilesPerDay ?? null;
        panelState.vehicleDataPointCount = history.dataPointCount ?? 0;
        panelState.vehicleHistorySpanDays = history.historySpanDays ?? null;
      } catch (err) {
        // ok to ignore
        void err;
      }

      const rootEl = document.createElement("div");
      rootEl.id = "aa-shadow-root";
      app.innerHTML = "";
      app.appendChild(rootEl);

      rootElRef = rootEl;

      renderCurrentScreen(rootEl);

      await persistPanelState();
    } catch (e) {
      app.innerHTML = `
        <div id="aa-shadow-root">
          ${headerHTML({ title: "Advance Appointment Scheduler", subtitle: null, showBack: false })}
          <div class="aa-scroll">
            <div class="aa-content">
              <div class="aa-error-banner" style="margin-top:8px;">
                Failed to load repair order data. Open a repair order and try again.
                <div style="margin-top:8px; font-size:11px; opacity:0.9;">${String(e?.message || "")}</div>
              </div>
            </div>
          </div>
        </div>
      `;
      bindHeaderControls();
    }
  }

  // Re-render whenever context changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.aaContext) return;

  const next = changes.aaContext.newValue || null;
  const prev = cachedContext;

  cachedContext = next;

  // Only reboot the UI if the RO actually changed.
  const prevRoId = prev?.roId ? String(prev.roId) : null;
  const nextRoId = next?.roId ? String(next.roId) : null;

  if (prevRoId !== nextRoId) {
    void boot();
  }
});

boot();
})();