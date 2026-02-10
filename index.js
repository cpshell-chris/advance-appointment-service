import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const {
  TEKMETRIC_CLIENT_ID,
  TEKMETRIC_CLIENT_SECRET,
  TEKMETRIC_BASE_URL
} = process.env;

if (!TEKMETRIC_CLIENT_ID || !TEKMETRIC_CLIENT_SECRET || !TEKMETRIC_BASE_URL) {
  throw new Error("Missing required Tekmetric environment variables");
}

/**
 * In-memory OAuth token cache
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
 * Calculate appointment window
 * - Always 6 months out
 * - Tuesday–Thursday only
 * - 9am–10am
 */
function calculateAppointmentWindow() {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);

  while (![2, 3, 4].includes(date.getDay())) {
    date.setDate(date.getDate() + 1);
  }

  const start = new Date(date);
  start.setHours(9, 0, 0, 0);

  const end = new Date(date);
  end.setHours(10, 0, 0, 0);

  return {
    startTime: start.toISOString(),
    endTime: end.toISOString()
  };
}

/**
 * Create Tekmetric appointment
 */
async function createAppointment(token, payload) {
  const response = await fetch(
    `${TEKMETRIC_BASE_URL}/api/v1/appointments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Appointment creation failed: ${text}`);
  }

  return response.json();
}

/**
 * MAIN ENDPOINT
 * Creates ONE 6-month advance appointment
 */
app.post("/create-advance-appointment", async (req, res) => {
  try {
    const { shopId, customerId, vehicleId } = req.body;

    if (!shopId || !customerId || !vehicleId) {
      return res.status(400).json({
        success: false,
        message: "Invalid request payload"
      });
    }

    const token = await getAccessToken();
    const { startTime, endTime } = calculateAppointmentWindow();

    const payload = {
      shopId,
      customerId,
      vehicleId,
      startTime,
      endTime,
      title: "6 Month Advance Appointment",
      description:
        "Advance follow-up appointment scheduled at time of vehicle checkout."
    };

    const result = await createAppointment(token, payload);

    res.json({
      success: true,
      appointmentId: result.data
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
app.listen(PORT, () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});
