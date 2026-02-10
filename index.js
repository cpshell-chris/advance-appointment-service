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
 * In-memory token cache
 * Cloud Run instances are ephemeral, this is fine for v1
 */
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Get Tekmetric OAuth token
 */
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
        "Authorization": `Basic ${auth}`,
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
  tokenExpiresAt = now + (55 * 60 * 1000); // 55 minutes

  return cachedToken;
}

/**
 * Calculate appointment date:
 * - monthsOut (6 or 12)
 * - force Tue–Thu
 * - default 9–10am local shop time (no TZ conversion in v1)
 */
function calculateAppointmentWindow(monthsOut) {
  const date = new Date();
  date.setMonth(date.getMonth() + monthsOut);

  // Force Tuesday–Thursday
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
        "Authorization": `Bearer ${token}`,
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
 * Main handler
 */
app.post("/create-advance-appointments", async (req, res) => {
  try {
    const {
      shopId,
      customerId,
      vehicleId,
      appointments
    } = req.body;

    if (
      !shopId ||
      !customerId ||
      !vehicleId ||
      !Array.isArray(appointments)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid request payload"
      });
    }

    const token = await getAccessToken();
    const createdAppointments = [];

    for (const appt of appointments) {
      const { monthsOut } = appt;

      if (![6, 12].includes(monthsOut)) {
        continue;
      }

      const { startTime, endTime } =
        calculateAppointmentWindow(monthsOut);

      const title =
        monthsOut === 6
          ? "6 Month Advance Appointment"
          : "12 Month Advance Appointment";

      const payload = {
        shopId,
        customerId,
        vehicleId,
        startTime,
        endTime,
        title,
        description:
          "Advance follow-up appointment scheduled at time of vehicle checkout."
      };

      const result = await createAppointment(token, payload);
      createdAppointments.push(result.data);
    }

    return res.json({
      success: true,
      appointments: createdAppointments
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * Cloud Run port binding
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});
