require("dotenv").config();
const OS = require("os");
process.env.UV_THREADPOOL_SIZE = OS.cpus().length;
const express = require("express");
const { Server } = require("socket.io");
const Binance = require("node-binance-api");
const WebSocket = require("ws");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");
let { log } = console;
const app = express();
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));
let PORT = process.env.PORT || 3001;
let server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
app.get("/health", (req, res) => {
  return res.send("ok");
});
const API_KEY = process.env.API_KEY;
const SECRET_KEY = process.env.SECRET_KEY;
let binance = new Binance().options({
  APIKEY: API_KEY,
  APISECRET: SECRET_KEY,
  recvWindow: 60000,
  useServerTime: true,
  verbose: true,
  reconnect: true,
  family: 4,
});
let subscribe;
let chart = new Map();
let endpoints = {};
let maxSymbols = 50;

//Start socket server
const io = new Server(server, {
  cors: {
    origin: process.env.ORIGIN,
    credentials: true,
    maxHttpBufferSize: 1e8,
  },
});
io.on("connection", (socket) => {
  socket.on("subscribe", () => {
    if (subscribe) clearInterval(subscribe);
    subscribe = setInterval(() => {
      socket.emit("data", chart, highVolCoins, balance, position);
    }, 5000);
  });
});

const setChart = (symbol, interval, data) => {
  if (Object.keys(data).length === 0 || data === undefined) return;
  if (chart[symbol] === undefined) chart[symbol] = {};
  chart[symbol][interval] = data;
  // const size = Buffer.byteLength(JSON.stringify(chart));
  // const kiloBytes = size / 1024;
  // const megaBytes = kiloBytes / 1024;
  // log(megaBytes);
};
const stream = async (market, interval) => {
  try {
    let id = await binance.futuresChart(market, interval, setChart, 500);
    endpoints[interval] = id;
  } catch (error) {
    console.log("stream error", error);
  }
};

let highVolCoins = [];
let avoid = ["USDCUSDT", "TRXUSDT"];
async function openStreams() {
  try {
    let futures = await binance.futuresDaily();
    for (let symbol in futures) {
      let coin = futures[symbol];
      if (symbol.slice(-4) === "USDT") {
        highVolCoins.push({ symbol, vol: Number(coin.quoteVolume) });
      }
    }
    let market = [...highVolCoins]
      .sort((a, b) => b.vol - a.vol)
      .splice(0, maxSymbols)
      .map((coin) => coin.symbol)
      .sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0));
    let timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"];

    // log(await stream(market, timeframes[0]));
    stream(market, timeframes[1]);
    stream(market, timeframes[2]);
    stream(market, timeframes[3]);
    stream(market, timeframes[4]);
    stream(market, timeframes[5]);

    setInterval(() => {
      let subscriptions = binance.futuresSubscriptions();
      for (let interval in endpoints) {
        if (!subscriptions[endpoints[interval]]) {
          stream(market, interval);
        }
      }
    }, 1000 * 5);
  } catch (error) {
    console.log("error", error);
  }
}
// openStreams();
var position;
var balance;
// function fetchListenKey() {
//   const ws = new WebSocket("wss://ws-fapi.binance.com/ws-fapi/v1");
//   let params = {
//     apiKey: API_KEY,
//   };
//   let message = {
//     id: uuidv4(),
//     method: "userDataStream.start",
//     params: {
//       ...params,
//     },
//   };
//   ws.on("open", () => {
//     setInterval(() => {
//       let message = {
//         id: uuidv4(),
//         method: "userDataStream.ping",
//         params: {
//           ...params,
//           listenKey: listenKey,
//         },
//       };
//       ws.send(JSON.stringify(message));
//     }, 1000 * 60 * 30);
//     ws.send(JSON.stringify(message));
//   });
//   ws.on("message", (data) => {
//     let result = JSON.parse(data);
//     listenKey = result?.result?.listenKey;
//     log("listenKey", listenKey);
//   });

//   ws.on("close", () => {
//     console.log("Disconnected from Binance WebSocket");
//   });

//   ws.on("error", (error) => {
//     console.error("WebSocket error:", error);
//   });
// }
let listenKey = "";
async function keepUserStreamAlive() {
  try {
    const url = "https://fapi.binance.com/fapi/v1/listenKey";
    let res = await axios.post(url, null, {
      headers: {
        "X-MBX-APIKEY": API_KEY,
      },
      params: {
        listenKey: listenKey,
      },
    });
    listenKey = res?.data?.listenKey;
    setTimeout(keepUserStreamAlive, 1000 * 60 * 30);
  } catch (error) {
    setTimeout(keepUserStreamAlive, 1000 * 60);
  }
}
async function getListenKey() {
  const url = "https://fapi.binance.com/fapi/v1/listenKey";
  let res = await axios.post(url, null, {
    headers: {
      "X-MBX-APIKEY": API_KEY,
    },
  });
  listenKey = res?.data?.listenKey;
  // log(listenKey);
  setTimeout(keepUserStreamAlive, 1000 * 60 * 30);
}
function userDataStream() {
  getListenKey();
  const ws = new WebSocket(`wss://fstream.binance.com/ws`);
  ws.on("open", () => {
    setInterval(() => {
      if (listenKey) {
        let message = {
          id: uuidv4(),
          method: "REQUEST",
          params: [`${listenKey}@position`, `${listenKey}@balance`],
        };
        ws.send(JSON.stringify(message));
      }
    }, 2000);
    console.log("Connected to User Stream WebSocket");
  });
  ws.on("message", (data) => {
    let result = JSON.parse(data);
    if (!result?.result) return;
    position = result?.result[0]?.res?.positions;
    balance = result?.result[1]?.res?.balances.filter(
      (sym) => sym?.asset === "USDT"
    )[0];
    log(balance);
  });

  ws.on("close", (reason) => {
    console.log("Disconnected from User Stream WebSocket", JSON.parse(reason));
  });

  ws.on("error", (error) => {
    console.error("User Stream WebSocket error:", error);
  });
}

userDataStream();
