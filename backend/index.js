import express from "express";

const app = express();
app.use(express.json());

/* ============================
   CORS
============================ */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes("*")) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

/* ============================
   Config Helpers
============================ */

function getTekmetricConfig() {
  return {
    TEKMETRIC_CLIENT_ID: process.env.TEKMETRIC_CLIENT_ID,
    TEKMETRIC_CLIENT_SECRET: process.env.TEKMETRIC_CLIENT_SECRET,
    TEKMETRIC_BASE_URL: process.env.TEKMETRIC_BASE_URL
  };
}

function validateTekmetricConfig() {
  const {
    TEKMETRIC_CLIENT_ID,
    TEKMETRIC_CLIENT_SECRET,
    TEKMETRIC_BASE_URL
  } = getTekmetricConfig();

  const missing = [];
  if (!TEKMETRIC_CLIENT_ID) missing.push("TEKMETRIC_CLIENT_ID");
  if (!TEKMETRIC_CLIENT_SECRET) missing.push("TEKMETRIC_CLIENT_SECRET");
  if (!TEKMETRIC_BASE_URL) missing.push("TEKMETRIC_BASE_URL");

  return {
    ok: missing.length === 0,
    missing
  };
}

function getFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Fetch API not available. Use Node 18+.");
  }
  return globalThis.fetch;
}

/* ============================
   OAuth Token Handling
============================ */

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const config = validateTekmetricConfig();
  if (!config.ok) {
    throw new Error(
      `Tekmetric environment variables not configured: ${config.missing.join(", ")}`
    );
  }

  const {
    TEKMETRIC_CLIENT_ID,
    TEKMETRIC_CLIENT_SECRET,
    TEKMETRIC_BASE_URL
  } = getTekmetricConfig();

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const auth = Buffer.from(
    `${TEKMETRIC_CLIENT_ID}:${TEKMETRIC_CLIENT_SECRET}`
  ).toString("base64");

  const fetch = getFetch();
  const response = await fetch(`${TEKMETRIC_BASE_URL}/api/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tekmetric auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;

  const expiresInMs = Number.isFinite(Number(data.expires_in))
    ? Number(data.expires_in) * 1000
    : 55 * 60 * 1000;

  tokenExpiresAt = now + Math.max(60 * 1000, expiresInMs - 60 * 1000);
  return cachedToken;
}

/* ============================
   Tekmetric Request Helpers
============================ */

async function tekmetricRequest(token, method, path, body) {
  const { TEKMETRIC_BASE_URL } = getTekmetricConfig();
  const fetch = getFetch();

  const response = await fetch(`${TEKMETRIC_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tekmetric ${method} failed (${response.status}) [${path}]: ${text}`);
  }

  return response.json();
}

function tekmetricGet(token, path) {
  return tekmetricRequest(token, "GET", path);
}

/* ============================
   Job / RO Helpers
============================ */

/**
 * Fetch all jobs for a repair order.
 * Tekmetric returns jobs under /api/v1/jobs?repairOrderId=X
 * Response is paginated in a 'content' array.
 */
async function fetchRoJobs(token, roId, shopId) {
  const pageSize = 200;
  const jobs = [];
  let page = 0;

  try {
    while (true) {
      const params = new URLSearchParams({
        shop: String(shopId),
        repairOrderId: String(roId),
        page: String(page),
        size: String(pageSize)
      });

      const payload = await tekmetricGet(
        token,
        `/api/v1/jobs?${params.toString()}`
      );

      const pageJobs = Array.isArray(payload?.content)
        ? payload.content
        : [];

      if (pageJobs.length === 0) break;

      jobs.push(...pageJobs);

      if (payload?.last === true) break;
      if (pageJobs.length < pageSize) break;

      page += 1;
    }

    return jobs;
  } catch (err) {
    console.warn("fetchRoJobs failed:", err.message);
    return jobs;
  }
}

async function fetchVehicleRepairOrders(token, vehicleId, shopId) {
  const pageSize = 200;
  const ros = [];
  let page = 0;

  try {
    while (true) {
      const params = new URLSearchParams({
        shop: String(shopId),
        vehicleId: String(vehicleId),
        page: String(page),
        size: String(pageSize)
      });

      const payload = await tekmetricGet(
        token,
        `/api/v1/repair-orders?${params.toString()}`
      );

      const pageRos = Array.isArray(payload?.content)
        ? payload.content
        : [];

      if (pageRos.length === 0) break;

      ros.push(...pageRos);

      if (payload?.last === true) break;
      if (pageRos.length < pageSize) break;

      page += 1;
    }

    return ros;
  } catch (err) {
    console.warn("fetchVehicleRepairOrders failed:", err.message);
    return ros;
  }
}

/* ============================
   Appointment Count Helpers
============================ */

function toDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getAppointmentsFromResponse(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function buildDateRangeKeys(startDate, endDate) {
  const keys = [];
  const cursor = new Date(startDate);
  const end = new Date(endDate);

  cursor.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  while (cursor <= end) {
    keys.push(toDateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return keys.filter(Boolean);
}

function getRangeBounds(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);

  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);

  return {
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

async function fetchAppointmentsForRange(token, shopId, startDate, endDate) {
  const { startIso, endIso } = getRangeBounds(startDate, endDate);

  // Tekmetric appointments endpoint is paginated; gather all pages to avoid
  // undercounting daily totals when first page does not contain all rows.
  const pageSize = 200;
  const collected = [];
  let page = 0;

  try {
    while (true) {
      const params = new URLSearchParams({
        shop: String(shopId),
        start: startIso,
        end: endIso,
        page: String(page),
        size: String(pageSize)
      });

      const payload = await tekmetricGet(
        token,
        `/api/v1/appointments?${params.toString()}`
      );

      const list = getAppointmentsFromResponse(payload);
      if (list.length === 0) break;

      collected.push(...list);

      const isLastPage = payload?.last === true;
      const totalPages = Number(payload?.totalPages);

      if (isLastPage) break;
      if (Number.isFinite(totalPages) && page + 1 >= totalPages) break;
      if (list.length < pageSize) break;

      page += 1;
    }

    return collected;
  } catch (err) {
    console.warn("fetchAppointmentsForRange failed:", err.message);
    return collected;
  }
}

/* ============================
   Routes
============================ */

app.get("/", (req, res) => {
  res.status(200).send("Advance Appointment Service Running");
});

app.get("/healthz", (req, res) => {
  const config = validateTekmetricConfig();
  res.status(200).json({
    ok: true,
    service: "advance-appointment-service",
    tekmetricConfigured: config.ok,
    missingEnvVars: config.missing
  });
});

// ============================
// RO Search (OPEN: Estimate/WIP/Complete not posted)
// ============================
app.get("/ro-search", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service not fully configured",
        missingEnvVars: config.missing
      });
    }

    const { shopId, q, page = "0", size = "20" } = req.query;

    if (!shopId) {
      return res.status(400).json({ success: false, message: "shopId is required" });
    }

    const token = await getAccessToken();

    // OPEN ROs per your definition:
    // 1 = Estimate, 2 = Work-in-Progress, 3 = Complete (NOT Posted)
    const params = new URLSearchParams({
      shop: String(shopId),
      page: String(page),
      size: String(Math.min(Number(size) || 20, 100))
    });

    if (q && String(q).trim()) params.set("search", String(q).trim());

    // Tekmetric supports repeated query params for arrays in most setups:
    // ...&repairOrderStatusId=1&repairOrderStatusId=2&repairOrderStatusId=3
    params.append("repairOrderStatusId", "1");
    params.append("repairOrderStatusId", "2");
    params.append("repairOrderStatusId", "3");

    // Optional: sort newest-ish
    params.set("sort", "createdDate");
    params.set("sortDirection", "DESC");

    const payload = await tekmetricGet(token, `/api/v1/repair-orders?${params.toString()}`);

    const rows = Array.isArray(payload?.content) ? payload.content : [];

    // Return a slim shape for the UI
    const items = rows.map((ro) => ({
      id: ro.id,
      roNumber: ro.repairOrderNumber,
      statusId: ro.repairOrderStatus?.id ?? null,
      statusName: ro.repairOrderStatus?.name ?? "",
      customerId: ro.customerId ?? null,
      vehicleId: ro.vehicleId ?? null,
      milesIn: ro.milesIn ?? null,
      milesOut: ro.milesOut ?? null,
      createdDate: ro.createdDate ?? null,
      updatedDate: ro.updatedDate ?? null
    }));

    return res.json({
      success: true,
      items,
      page: payload?.number ?? Number(page) || 0,
      totalPages: payload?.totalPages ?? 0,
      totalElements: payload?.totalElements ?? items.length,
      last: payload?.last ?? true
    });
  } catch (err) {
    console.error("/ro-search error", err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error"
    });
  }
});

/*
 * GET /ro/:roId
 *
 * Returns repair order data including customer, vehicle, and jobs.
 * Jobs are used by the extension to populate the Repeat Services and
 * Declined Services lists on screen 2.
 */
app.get("/ro/:roId", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service not fully configured",
        missingEnvVars: config.missing
      });
    }

    const { roId } = req.params;
    const token = await getAccessToken();

    // Fetch RO, customer, vehicle, and jobs in parallel where possible
    const ro = await tekmetricGet(
      token,
      `/api/v1/repair-orders/${encodeURIComponent(roId)}`
    );

    const [customer, vehicle, jobs] = await Promise.all([
      tekmetricGet(token, `/api/v1/customers/${encodeURIComponent(ro.customerId)}`),
      tekmetricGet(token, `/api/v1/vehicles/${encodeURIComponent(ro.vehicleId)}`),
      fetchRoJobs(token, roId, ro.shopId)
    ]);

    return res.json({
      success: true,
      roId: ro.id,
      roNumber: ro.repairOrderNumber,
      shopId: ro.shopId,
      mileage: ro.milesOut ?? null,
      completedDate: ro.completedDate ?? null,
      customer,
      vehicle,
      jobs  // <-- now included: array of job objects with name, status, id, etc.
    });
  } catch (err) {
    console.error("/ro/:roId error", err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error"
    });
  }
});

app.get("/vehicle-history/:vehicleId", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service not fully configured",
        missingEnvVars: config.missing
      });
    }

    const { vehicleId } = req.params;
    const { shopId } = req.query;

    if (!vehicleId || !shopId) {
      return res.status(400).json({
        success: false,
        message: "vehicleId and shopId are required"
      });
    }

    const token = await getAccessToken();

    const repairOrders = await fetchVehicleRepairOrders(
      token,
      vehicleId,
      shopId
    );

    // ---- Build mileage timeline ----
let rawTimeline = [];

for (const ro of repairOrders) {
  const date =
    ro.completedDate ||
    ro.closedDate ||
    ro.createdDate ||
    null;

  const mileage = ro.milesOut ?? ro.milesIn ?? null;

  if (!date) continue;
  if (!Number.isFinite(Number(mileage))) continue;

  const numericMileage = Number(mileage);

  // Ignore zero or clearly invalid mileage
  if (numericMileage <= 0) continue;

  rawTimeline.push({
    date,
    mileage: numericMileage
  });
}

// Sort chronologically
rawTimeline.sort(
  (a, b) => new Date(a.date) - new Date(b.date)
);

// Remove mileage regressions (only keep forward movement)
const mileageTimeline = [];

for (const entry of rawTimeline) {
  if (mileageTimeline.length === 0) {
    mileageTimeline.push(entry);
    continue;
  }

  const lastValid = mileageTimeline[mileageTimeline.length - 1];

  if (entry.mileage >= lastValid.mileage) {
    mileageTimeline.push(entry);
  }
}

// ---- Calculate average miles per day using first & last valid ----
let avgMilesPerDay = null;
let historySpanDays = null;

if (mileageTimeline.length >= 2) {
  const first = mileageTimeline[0];
  const last = mileageTimeline[mileageTimeline.length - 1];

  const milesDelta = last.mileage - first.mileage;
  const daysDelta =
    (new Date(last.date) - new Date(first.date)) /
    (1000 * 60 * 60 * 24);

  if (daysDelta > 0 && milesDelta > 0) {
    avgMilesPerDay = milesDelta / daysDelta;
    historySpanDays = Math.round(daysDelta);
  }
}

    res.json({
  success: true,
  vehicleId,
  mileageTimeline,
  avgMilesPerDay,
  dataPointCount: mileageTimeline.length,
  historySpanDays
});
  } catch (err) {
    console.error("/vehicle-history error", err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error"
    });
  }
});

app.get("/appointments/counts", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service not fully configured",
        missingEnvVars: config.missing
      });
    }

    const { shopId, startDate, endDate } = req.query;

    if (!shopId || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "shopId, startDate and endDate are required"
      });
    }

    const token = await getAccessToken();
    console.log("Access token:", token);
    const appointments = await fetchAppointmentsForRange(
      token,
      shopId,
      startDate,
      endDate
    );

    const counts = {};
    for (const key of buildDateRangeKeys(startDate, endDate)) {
      counts[key] = 0;
    }

    for (const appt of appointments) {
      // Skip deleted or cancelled appointments
      if (appt.deletedDate) continue;
      if (appt.appointmentStatus === "CANCELLED" || appt.appointmentStatus === "NO_SHOW") continue;

      const key = toDateKey(appt?.startTime || appt?.startDate);
      if (!key) continue;
      if (!(key in counts)) continue;
      counts[key] += 1;
    }

    return res.json({
      success: true,
      counts
    });
  } catch (err) {
    console.error("/appointments/counts error", err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error"
    });
  }
});

/*
 * POST /appointments
 *
 * Creates an appointment in Tekmetric.
 * Now accepts: appointmentType ("dropoff" | "wait")
 * in addition to the original required fields.
 */
app.post("/appointments", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service not fully configured",
        missingEnvVars: config.missing
      });
    }

    const {
      shopId,
      customerId,
      vehicleId,
      title,
      description,
      startTime,
      endTime,
      mileage,
      appointmentType,
      color
    } = req.body;

const appointmentColor = typeof color === "string" && color.trim() ? color.trim() : "navy";
    if (!shopId || !customerId || !vehicleId || !title || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message:
          "shopId, customerId, vehicleId, title, startTime and endTime are required"
      });
    }

    const token = await getAccessToken();

    // Determine Tekmetric appointment option

let appointmentOption = undefined;
let dropoffTime = undefined;
let pickupTime = undefined;

if (appointmentType === "dropoff") {
  appointmentOption = { id: 2 };   // DROP
  dropoffTime = startTime;
  pickupTime = endTime;
} else if (appointmentType === "wait") {
  appointmentOption = { id: 1 };   // STAY
}

const appointmentPayload = {
  shopId,
  customerId,
  vehicleId,
  title,
  description,
  startTime,
  endTime,
  color: appointmentColor,
  rideOption: "NONE",
  status: "NONE",
  appointmentOption,
  dropoffTime,
  pickupTime
};

if (mileage != null) {
  appointmentPayload.mileage = mileage;
}

    const data = await tekmetricRequest(
      token,
      "POST",
      "/api/v1/appointments",
      appointmentPayload
    );

    return res.json({
      success: true,
      appointment: data
    });
  } catch (err) {
    console.error("/appointments error", err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : "Internal server error"
    });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled express error", err);
  if (res.headersSent) return next(err);
  return res.status(500).json({
    success: false,
    message: "Unhandled server error"
  });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception", err);
});

/* ============================
   Start Server
============================ */

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
