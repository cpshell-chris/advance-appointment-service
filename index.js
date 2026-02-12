import express from "express";

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

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  return next();
});

/* ============================
   Config Helpers (NO STARTUP CRASH)
============================ */

function getTekmetricConfig() {
  const TEKMETRIC_CLIENT_ID = process.env.TEKMETRIC_CLIENT_ID;
  const TEKMETRIC_CLIENT_SECRET = process.env.TEKMETRIC_CLIENT_SECRET;
  const TEKMETRIC_BASE_URL = process.env.TEKMETRIC_BASE_URL;

  return {
    TEKMETRIC_CLIENT_ID,
    TEKMETRIC_CLIENT_SECRET,
    TEKMETRIC_BASE_URL
  };
}

function validateTekmetricConfig() {
  const { TEKMETRIC_CLIENT_ID, TEKMETRIC_CLIENT_SECRET, TEKMETRIC_BASE_URL } = getTekmetricConfig();
  const missing = [];

  if (!TEKMETRIC_CLIENT_ID) missing.push("TEKMETRIC_CLIENT_ID");
  if (!TEKMETRIC_CLIENT_SECRET) missing.push("TEKMETRIC_CLIENT_SECRET");
  if (!TEKMETRIC_BASE_URL) missing.push("TEKMETRIC_BASE_URL");

  return {
    ok: missing.length === 0,
    missing
  };
}

const initialValidation = validateTekmetricConfig();
if (!initialValidation.ok) {
  console.error(`Missing Tekmetric environment variables: ${initialValidation.missing.join(", ")}`);
}

/* ============================
   OAuth Token Handling
============================ */

let cachedToken = null;
let tokenExpiresAt = 0;

function getFetch() {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Fetch API is not available in this runtime. Use Node.js 18+ or install a fetch polyfill.");
  }
  return globalThis.fetch;
}

async function getAccessToken() {
  const config = validateTekmetricConfig();
  if (!config.ok) {
    throw new Error(`Tekmetric environment variables not configured: ${config.missing.join(", ")}`);
  }

  const { TEKMETRIC_CLIENT_ID, TEKMETRIC_CLIENT_SECRET, TEKMETRIC_BASE_URL } = getTekmetricConfig();
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const auth = Buffer.from(`${TEKMETRIC_CLIENT_ID}:${TEKMETRIC_CLIENT_SECRET}`).toString("base64");

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

  if (!data?.access_token) {
    throw new Error("Tekmetric auth response did not include access_token");
  }

  cachedToken = data.access_token;
  const expiresInMs = Number.isFinite(data.expires_in) ? Number(data.expires_in) * 1000 : 55 * 60 * 1000;
  tokenExpiresAt = now + Math.max(60 * 1000, expiresInMs - 60 * 1000);

  return cachedToken;
}

/* ============================
   Generic GET
============================ */

async function tekmetricGet(token, path) {
  const { TEKMETRIC_BASE_URL } = getTekmetricConfig();

  const fetch = getFetch();
  const response = await fetch(`${TEKMETRIC_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tekmetric GET failed (${response.status}) [${path}]: ${text}`);
  }

  return response.json();
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

app.get("/ro/:roId", async (req, res) => {
  try {
    const config = validateTekmetricConfig();
    if (!config.ok) {
      return res.status(503).json({
        success: false,
        message: "Service is not fully configured",
        missingEnvVars: config.missing
      });
    }

    const { roId } = req.params;
    if (!roId) {
      return res.status(400).json({
        success: false,
        message: "Missing required route parameter: roId"
      });
    }

    const token = await getAccessToken();

    const ro = await tekmetricGet(token, `/api/v1/repair-orders/${encodeURIComponent(roId)}`);

    if (!ro || !ro.customerId || !ro.vehicleId) {
      return res.status(404).json({
        success: false,
        message: "Repair order missing required data"
      });
    }

    const customer = await tekmetricGet(token, `/api/v1/customers/${encodeURIComponent(ro.customerId)}`);
    const vehicle = await tekmetricGet(token, `/api/v1/vehicles/${encodeURIComponent(ro.vehicleId)}`);

    return res.json({
      success: true,
      roId: ro.id,
      roNumber: ro.repairOrderNumber,
      shopId: ro.shopId,
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email
      },
      vehicle: {
        id: vehicle.id,
        year: vehicle.year,
        make: vehicle.make,
        model: vehicle.model,
        vin: vehicle.vin
      }
    });
  } catch (err) {
    console.error("/ro/:roId error", err);
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
