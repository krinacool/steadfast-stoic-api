const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const axios = require("axios");
const fs = require("fs");
const csv = require("fast-csv");
const path = require("path");
const bodyParser = require("body-parser");

const app = express();

// Enable fucking CORS for your frontend's origin
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

app.use(express.json());
app.use(bodyParser.json());

// Root route to prevent "Cannot GET /" error
app.get("/", (req, res) => {
  res.send("Welcome to the Proxy Server");
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

require("dotenv").config();
// All Brokers API Keys, Client IDs, Secret IDs
const DHAN_ACCESS_TOKEN = process.env.DHAN_API_TOKEN;
const DHAN_CLIENT_ID = String(process.env.DHAN_CLIENT_ID);
const FLATTRADE_CLIENT_ID = String(process.env.FLATTRADE_CLIENT_ID);
const FLATTRADE_API_KEY = String(process.env.FLATTRADE_API_KEY);
const FLATTRADE_API_SECRET = String(process.env.FLATTRADE_API_SECRET);

const brokers = [
  {
    brokerClientId: DHAN_CLIENT_ID,
    brokerName: "Dhan",
    appId: "dhan-app-id",
    apiKey: DHAN_ACCESS_TOKEN,
    apiSecret: DHAN_ACCESS_TOKEN,
    status: "Active",
    lastTokenGeneratedAt: "2023-10-01T12:00:00Z",
    addedAt: "2023-09-01T12:00:00Z",
  },
  {
    brokerClientId: FLATTRADE_CLIENT_ID,
    brokerName: "Flattrade",
    appId: "flattrade-app-id",
    apiKey: FLATTRADE_API_KEY,
    apiSecret: FLATTRADE_API_SECRET,
    status: "Active",
    lastTokenGeneratedAt: "2023-10-01T12:00:00Z",
    addedAt: "2023-09-01T12:00:00Z",
  },
  // Add more brokers as needed
];

app.get("/brokers", (req, res) => {
  res.json(brokers);
});

// Send Credentials for Manage Brokers
app.get('/api/flattrade-credentials', (req, res) => {
  res.json({
    apiKey: FLATTRADE_API_KEY,
    apiSecret: FLATTRADE_API_SECRET,
  });
});
// Broker Flattrade - Proxy configuration for Flattrade API
app.use(
  "/flattradeApi",
  createProxyMiddleware({
    target: "https://authapi.flattrade.in",
    changeOrigin: true,
    pathRewrite: {
      "^/flattradeApi": "", // remove /flattradeApi prefix when forwarding to target
    },
  })
);
// Broker Flattrade - Get Funds
app.post("/flattradeFundLimit", async (req, res) => {
  const jKey = req.query.generatedToken || req.query.token;
  const jData = JSON.stringify({ uid: 'FT014523', actid: 'FT014523' });
  const payload = `jKey=${jKey}&jData=${jData}`;

  try {
    const response = await axios.post('https://piconnect.flattrade.in/PiConnectTP/Limits', payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching fund limits:', error);
    res.status(500).json({ message: 'Error fetching fund limits', error: error.message });
  }
});

// All Dhan API Endpoints

// Broker Dhan - Proxy configuration for Dhan API
app.use(
  "/api",
  createProxyMiddleware({
    target: "https://api.dhan.co",
    changeOrigin: true,
    pathRewrite: {
      "^/api": "",
    },
    onProxyReq: (proxyReq, req, res) => {
      // Log the headers to verify they are set correctly
      console.log("Proxying request to:", proxyReq.path);
      console.log("Request headers:", req.headers);
    },
    onProxyRes: (proxyRes, req, res) => {
      console.log("Received response with status:", proxyRes.statusCode);
    },
    onError: (err, req, res) => {
      console.error("Proxy Error:", err);
      res.status(500).json({ message: "Error in proxying request" });
    },
  })
);

// Broker Dhan - Get Funds
app.get("/dhanFundLimit", async (req, res) => {
  try {
    const options = {
      method: "GET",
      url: "https://api.dhan.co/fundlimit",
      headers: {
        "access-token": process.env.DHAN_API_TOKEN,
        Accept: "application/json",
      },
    };
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch fund limit:", error);
    res.status(500).json({ message: "Failed to fetch fund limit" });
  }
});

app.get("/symbols", (req, res) => {
  const { exchangeSymbol, masterSymbol } = req.query;
  const callStrikes = [];
  const putStrikes = [];
  const expiryDates = new Set();

  fs.createReadStream("./api-scrip-master.csv")
    .pipe(csv.parse({ headers: true }))
    .on("data", (row) => {
      if (
        row["SEM_EXM_EXCH_ID"] === exchangeSymbol &&
        row["SEM_TRADING_SYMBOL"].startsWith(masterSymbol + "-")
      ) {
        if (["OPTIDX", "OP"].includes(row["SEM_EXCH_INSTRUMENT_TYPE"])) {
          const strikeData = {
            tradingSymbol: row["SEM_TRADING_SYMBOL"],
            expiryDate: row["SEM_EXPIRY_DATE"],
            securityId: row["SEM_SMST_SECURITY_ID"],
          };
          if (row["SEM_OPTION_TYPE"] === "CE") {
            callStrikes.push(strikeData);
          } else if (row["SEM_OPTION_TYPE"] === "PE") {
            putStrikes.push(strikeData);
          }
          expiryDates.add(row["SEM_EXPIRY_DATE"]);
        }
      }
    })
    .on("end", () => {
      res.json({
        callStrikes,
        putStrikes,
        expiryDates: Array.from(expiryDates),
      });
    })
    .on("error", (error) => {
      res.status(500).json({ message: "Failed to process CSV file" });
    });
});

// Broker Dhan - Route to place an order to include securityId from the request
app.post("/placeOrder", async (req, res) => {
  const {
    brokerClientId,
    transactionType,
    exchangeSegment,
    productType,
    orderType,
    validity,
    tradingSymbol,
    securityId,
    quantity,
    price,
    drvExpiryDate,
    drvOptionType,
  } = req.body;

  const options = {
    method: "POST",
    url: "https://api.dhan.co/orders",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    data: {
      brokerClientId,
      transactionType,
      exchangeSegment,
      productType,
      orderType,
      validity,
      tradingSymbol,
      securityId,
      quantity,
      price,
      drvExpiryDate,
      drvOptionType,
    },
  };

  console.log("Sending request with body:", options.data);

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to place order:", error);
    res.status(500).json({ message: "Failed to place order" });
  }
});

// Broker Dhan - Endpoint for Kill Switch
app.post("/killSwitch", async (req, res) => {
  const killSwitchStatus = req.query.killSwitchStatus; // Get from query parameters

  console.log("Received killSwitchStatus:", killSwitchStatus); // Log the received status

  if (!["ACTIVATE", "DEACTIVATE"].includes(killSwitchStatus)) {
    return res.status(400).json({
      message:
        'Invalid killSwitchStatus value. Must be either "ACTIVATE" or "DEACTIVATE".',
    });
  }

  const options = {
    method: "POST",
    url: "https://api.dhan.co/killSwitch",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    params: {
      // Send as query parameters to the Dhan API
      killSwitchStatus,
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to activate Kill Switch:", error);
    res.status(500).json({
      message: "Failed to activate Kill Switch",
      error: error.response.data,
    });
  }
});

// Broker Dhan - Route to get orders
app.get("/getOrders", async (req, res) => {
  const options = {
    method: "GET",
    url: "https://api.dhan.co/orders",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN, // Set the API token from environment variables
      Accept: "application/json",
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// Broker Dhan - Route to fetch positions
app.get("/positions", async (req, res) => {
  const options = {
    method: "GET",
    url: "https://api.dhan.co/positions",
    headers: {
      "access-token": process.env.DHAN_API_TOKEN, // Use the API token from environment variables
      Accept: "application/json",
    },
  };

  try {
    const response = await axios(options);
    res.json(response.data);
  } catch (error) {
    console.error("Failed to fetch positions:", error);
    res.status(500).json({ message: "Failed to fetch positions" });
  }
});

// Broker Dhan - Route to cancel an order
app.delete("/cancelOrder", async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) {
    return res.status(400).json({ message: "orderId is required" });
  }

  const options = {
    method: "DELETE",
    url: `https://api.dhan.co/orders/${orderId}`,
    headers: {
      "access-token": process.env.DHAN_API_TOKEN,
      Accept: "application/json",
    },
  };

  try {
    const { data } = await axios.request(options);
    res.json(data);
  } catch (error) {
    console.error("Failed to cancel order:", error);
    res.status(500).json({ message: "Failed to cancel order" });
  }
});
