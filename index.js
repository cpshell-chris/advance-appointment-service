import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

/**
 * -------------------------
 * CORS MIDDLEWARE
 * -------------------------
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

const {
  TEKMETRIC_CLIENT_ID,
  TEKMETRIC_CLIENT_SECRET,
  TEKMETRIC_BASE_URL
} = process.env;

if (!TEKMETRIC_CLIENT_ID || !TEKMETRIC_CLIENT_SECRET || !TEKMETRIC_BASE_URL) {
  throw new Error("Missing required Tekmetric environment variables");
}

/**
 * -------------------------
 * TOKEN CACHE
 * -------------------------
 */
let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();

  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const auth = Buffer.from(
    `${TEKMETRIC_CLIENT_ID}:${TEKMETRIC_CLIENT_SECRET}`
  ).toString("base64");

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
    throw new Error(`Tekmetric auth failed: ${text}`);
  }

  const data = await response.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + 55 * 60 * 1000;

  return cachedToken;
}

/**
 * -------------------------
 * HEALTH CHECK
 * -------------------------
 */
app.get("/", (req, res) => {
  res.json({ status: "Advance Appointment service running" });
});

/**
 * -------------------------
 * GET REPAIR ORDER DATA
 * -------------------------
 */
app.get("/ro/:id", async (req, res) => {
  try {
    const roId = req.params.id;
    const token = await getAccessToken();

    const response = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/repair-orders/${roId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tekmetric fetch failed: ${text}`);
    }

    const ro = await response.json();

    res.json({
      success: true,
      roId: ro.id,
      roNumber: ro.repairOrderNumber,
      shopId: ro.shopId,
      customer: {
        id: ro.customerId,
        firstName: ro.customerFirstName || ro.customer?.firstName || "",
        lastName: ro.customerLastName || ro.customer?.lastName || "",
        email: ro.customer?.email || null
      },
      vehicle: {
        id: ro.vehicleId,
        year: ro.vehicle?.year,
        make: ro.vehicle?.make,
        model: ro.vehicle?.model,
        vin: ro.vehicle?.vin
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/**
 * -------------------------
 * START SERVER
 * -------------------------
 */
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});
