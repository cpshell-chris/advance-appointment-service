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

/* ============================================================
   TOKEN CACHE
============================================================ */

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
  tokenExpiresAt = now + 55 * 60 * 1000; // 55 minutes cache

  return cachedToken;
}

/* ============================================================
   HEALTH CHECK
============================================================ */

app.get("/", (req, res) => {
  res.json({
    status: "Advance Appointment service running"
  });
});

/* ============================================================
   FETCH REPAIR ORDER
============================================================ */

app.get("/ro/:roId", async (req, res) => {
  try {
    const { roId } = req.params;

    if (!roId) {
      return res.status(400).json({
        success: false,
        message: "Missing RO ID"
      });
    }

    const token = await getAccessToken();

    const response = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/repair-orders/${roId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        success: false,
        error: text
      });
    }

    const data = await response.json();
    const ro = data.data;

    res.json({
      success: true,
      roId: ro.id,
      roNumber: ro.number,
      shopId: ro.shopId,
      customerId: ro.customer?.id,
      customerName: ro.customer?.fullName || null,
      vehicleId: ro.vehicle?.id,
      vehicle:
        ro.vehicle
          ? `${ro.vehicle.year} ${ro.vehicle.make} ${ro.vehicle.model}`
          : null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

/* ============================================================
   CALCULATE APPOINTMENT WINDOW
   - 6 months out
   - Tuesday–Thursday only
   - 9am–10am
============================================================ */

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

/* ============================================================
   CREATE APPOINTMENT
============================================================ */

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

/* ============================================================
   CREATE ADVANCE APPOINTMENT ENDPOINT
============================================================ */

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

/* ============================================================
   CLOUD RUN ENTRYPOINT
============================================================ */

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Advance Appointment service running on port ${PORT}`);
});
