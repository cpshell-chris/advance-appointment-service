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
 * Calculate appointment time window
 * - monthsOut: 6 or 12
 * - Tuesday–Thursday only
 * - 9am–10am
 */
function calculateAppointmentWindow(monthsOut) {
  const date = new Date();
  date.setMonth(date.getMonth() + monthsOut);

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
 */
app.post("/create-advance-appointments", async (req, res) => {
  try {
    const { shopId, customerId, vehicleId, appointments } = req.body;

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
    const created = [];

    for (const appt of appointments) {
      if (![6, 12].includes(appt.monthsOut)) continue;

      const { startTime, endTime } =
        calculateAppointmentWindow(appt.monthsOut);

      const title =
        appt.monthsOut === 6
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
      created.push(result.data);
    }

    res.json({
      success: true,
      appointments: created
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
 * DEBUG ENDPOINT — FETCH REPAIR ORDER
 * TEMPORARY
 */
app.get("/debug/repair-order/:id", async (req, res) => {
  try {
    const token = await getAccessToken();
    const roId = req.params.id;

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
      throw new Error(text);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Cloud Run entrypoint
 */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});
