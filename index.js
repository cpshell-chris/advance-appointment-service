import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  TEKMETRIC_CLIENT_ID,
  TEKMETRIC_CLIENT_SECRET,
  TEKMETRIC_BASE_URL
} = process.env;

/* ============================
   Safety Check (NO CRASH)
============================ */

if (!TEKMETRIC_CLIENT_ID || !TEKMETRIC_CLIENT_SECRET || !TEKMETRIC_BASE_URL) {
  console.error("Missing Tekmetric environment variables");
}

/* ============================
   OAuth Token Handling
============================ */

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (!TEKMETRIC_CLIENT_ID || !TEKMETRIC_CLIENT_SECRET || !TEKMETRIC_BASE_URL) {
    throw new Error("Tekmetric environment variables not configured");
  }

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

/* ============================
   Generic GET
============================ */

async function tekmetricGet(token, path) {
  const response = await fetch(
    `${TEKMETRIC_BASE_URL}${path}`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Tekmetric GET failed: ${text}`);
  }

  return response.json();
}

/* ============================
   RO Endpoint
============================ */

app.get("/ro/:roId", async (req, res) => {
  try {
    const { roId } = req.params;

    const token = await getAccessToken();

    const ro = await tekmetricGet(
      token,
      `/api/v1/repair-orders/${roId}`
    );

    if (!ro || !ro.customerId || !ro.vehicleId) {
      return res.status(404).json({
        success: false,
        message: "Repair order missing required data"
      });
    }

    const customer = await tekmetricGet(
      token,
      `/api/v1/customers/${ro.customerId}`
    );

    const vehicle = await tekmetricGet(
      token,
      `/api/v1/vehicles/${ro.vehicleId}`
    );

    res.json({
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
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* ============================
   Health Check
============================ */

app.get("/", (req, res) => {
  res.send("Advance Appointment Service Running");
});

/* ============================
   Start Server
============================ */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server listening on port ${PORT}`);
});
