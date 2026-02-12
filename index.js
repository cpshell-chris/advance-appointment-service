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
 * Health Check
 */
app.get("/", (req, res) => {
  res.json({ status: "Advance Appointment service running" });
});

/**
 * Fetch Repair Order Details
 */
app.get("/ro/:roId", async (req, res) => {
  try {
    const { roId } = req.params;

    const token = await getAccessToken();

    const response = await fetch(
      `${TEKMETRIC_BASE_URL}/api/v1/repair-orders/${roId}`,
      {
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
        message: text
      });
    }

    const roData = await response.json();

    console.log("FULL TEKMETRIC RESPONSE:");
    console.log(JSON.stringify(roData, null, 2));

    // 👇 Instead of assuming structure, return raw data for now
    res.json({
      success: true,
      raw: roData
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
