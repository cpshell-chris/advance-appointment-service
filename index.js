import express from "express";
import { DateTime } from "luxon";

const app = express();
app.use(express.json());

/* ============================
   CORS (Chrome extension + preflight)
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
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
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

/* ============================
   OAuth Token Handling
============================ */

let cachedToken = null;
let tokenExpiresAt = 0;

function getFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Fetch API not available. Use Node 18+.");
  }
  return globalThis.fetch;
}

async function getAccessToken() {
  const config = validateTekmetricConfig();
  if (!config.ok) {
    throw new Error(
      `Tekmetric environment variables not configured: ${config.missing.join(
        ", "
      )}`
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

  const response = await fetch(
    `${TEKMETRIC_BASE_URL}/api/v1/oauth/token`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }
  );

  if (!response.ok) {
    const text = await response.text();
        throw new Error(`Tekmetric auth failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  cachedToken = data.access_token;

  const expiresInMs = Number.isFinite(data.expires_in)
    ? Number(data.expires_in) * 1000
    : 55 * 60 * 1000;

    tokenExpiresAt = now + Math.max(60 * 1000, expiresInMs - 60 * 1000);
  return cachedToken;
}

/* ============================
   Generic Request (GET + POST)
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
    throw new Error(
      `Tekmetric ${method} failed (${response.status}) [${path}]: ${text}`
    );
  }

  return response.json();
}

async function tekmetricGet(token, path) {
  return tekmetricRequest(token, "GET", path);
}

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

  const queryAttempts = [
    { startTime: startIso, endTime: endIso },
    { startDate: startIso, endDate: endIso },
    { from: startIso, to: endIso },
    { dateFrom: startIso, dateTo: endIso },
    { shopId: String(shopId), limit: "500" }
  ];

  for (const query of queryAttempts) {
    const params = new URLSearchParams({
      shopId: String(shopId),
      ...query
    });

    try {
      const payload = await tekmetricGet(
        token,
        `/api/v1/appointments?${params.toString()}`
      );

      const list = getAppointmentsFromResponse(payload);
      if (list.length > 0 || query.limit) {
        return list;
      }
    } catch (err) {
      continue;
    }
  }

  return [];
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

/* ============================
   RO DETAILS (milesOut)
============================ */

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

    const ro = await tekmetricGet(
      token,
      `/api/v1/repair-orders/${encodeURIComponent(roId)}`
    );

    const customer = await tekmetricGet(
      token,
      `/api/v1/customers/${encodeURIComponent(ro.customerId)}`
    );

    const vehicle = await tekmetricGet(
      token,
      `/api/v1/vehicles/${encodeURIComponent(ro.vehicleId)}`
    );

    return res.json({
      success: true,
      roId: ro.id,
      roNumber: ro.repairOrderNumber,
      shopId: ro.shopId,
      mileage: ro.milesOut ?? null,
      completedDate: ro.completedDate ?? null,
      customer,
      vehicle
    });
  } catch (err) {
    console.error("/ro/:roId error", err);
    return res.status(500).json({
      success: false,
      message:
        err instanceof Error
          ? err.message
          : "Internal server error"
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


/* ============================
   CREATE APPOINTMENT
============================ */

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
      startTime,
      endTime,
      mileage
    } = req.body;

    if (
      !shopId ||
      !customerId ||
      !vehicleId ||
      !title ||
      !startTime ||
      !endTime
    ) {
      return res.status(400).json({
        success: false,
        message:
          "shopId, customerId, vehicleId, title, startTime and endTime are required"
      });
    }

    const token = await getAccessToken();

    const { TEKMETRIC_BASE_URL } = getTekmetricConfig();

    const fetch = getFetch();

    const response = await fetch(`${TEKMETRIC_BASE_URL}/api/v1/appointments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        shopId,
        customerId,
        vehicleId,
        title,
        startTime,
        endTime,
        mileage
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        throw new Error(`Tekmetric POST failed (${response.status}): ${text}`);

    const data = await response.json();

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

/* ============================
   Error Handling
============================ */

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
