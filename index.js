import express from "express";

const app = express();
app.use(express.json());

const {
  TEKMETRIC_CLIENT_ID,
  TEKMETRIC_CLIENT_SECRET,
  TEKMETRIC_BASE_URL
} = process.env;

if (!TEKMETRIC_CLIENT_ID || !TEKMETRIC_CLIENT_SECRET || !TEKMETRIC_BASE_URL) {
  console.error("Missing required Tekmetric environment variables");
}

/**
 * OAuth token cache
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
 * Health check
 */
app.get("/", (req, res) => {
  res.json({ status: "Advance Appointment service running" });
});

/**
 * Fetch RO + Customer + Vehicle
 */
app.get("/ro/:roId", async (req, res) => {
  try {
    const { roId } = req.params;
    const token = await getAccessToken();

    // Get Repair Order
    const roResponse = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/repair-orders/${roId}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!roResponse.ok) {
      const text = await roResponse.text();
      return res.status(roResponse.status).json({
        success: false,
        message: text
      });
    }

    const ro = await roResponse.json();

    const {
      repairOrderNumber,
      shopId,
      customerId,
      vehicleId
    } = ro;

    // Get Customer
    const customerResponse = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/customers/${customerId}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const customer = await customerResponse.json();

    // Get Vehicle
    const vehicleResponse = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/vehicles/${vehicleId}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    const vehicle = await vehicleResponse.json();

    res.json({
      success: true,
      roId,
      roNumber: repairOrderNumber,
      shopId,
      customer: {
        id: customerId,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.primaryPhone,
        email: customer.email
      },
      vehicle: {
        id: vehicleId,
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

/**
 * Cloud Run entrypoint
 */
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});

