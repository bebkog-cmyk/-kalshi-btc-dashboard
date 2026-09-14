(function () {
  "use strict";

  var KALSHI_HOSTS = [
    "https://external-api.kalshi.com/trade-api/v2",
    "https://api.elections.kalshi.com/trade-api/v2"
  ];
  var SERIES = "KXBTC15M";
  var state = {
    market: null,
    candles: [],
    proxy: null,
    manual: null,
    lastMarketFetch: 0,
    lastCandleFetch: 0,
    lastSavedKey: "",
    priceSource: "Coinbase proxy"
  };

  var el = function (id) { return document.getElementById(id); };
  var clamp = function (x, a, b) { return Math.max(a, Math.min(b, x)); };
  var money = function (n) {
    return Number.isFinite(n)
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n)
      : "—";
  };
  var pct = function (n) { return Number.isFinite(n) ? Math.round(n * 100) + "%" : "—"; };
  var num = function (v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function normalCdf(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989423 * Math.exp(-x * x / 2);
    var p = 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x >= 0 ? p : 1 - p;
  }

  function fieldPrice(market, names) {
    for (var i = 0; i < names.length; i++) {
      var value = num(market[names[i]]);
      if (value !== null) return value > 1 ? value / 100 : value;
    }
    return null;
  }

  function targetOf(market) {
    var fields = ["floor_strike", "cap_strike", "strike_value", "functional_strike"];
    for (var i = 0; i < fields.length; i++) {
      var n = num(market[fields[i]]);
      if (n !== null && n > 1000) return n;
    }

    var text = [
      market.title,
      market.subtitle,
      market.yes_sub_title,
      market.no_sub_title,
      market.rules_primary,
      market.ticker
    ].filter(Boolean).join(" ");

    var matches = text.match(/\$?([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?|[0-9]{5,6}(?:\.[0-9]+)?)/g) || [];
    for (var j = 0; j < matches.length; j++) {
      var parsed = Number(matches[j].replace(/[$,]/g, ""));
      if (parsed > 1000) return parsed;
    }
    return null;
  }

  function closeOf(market) {
    return new Date(market.close_time || market.expiration_time || market.expected_expiration_time);
  }

  async function getJson(url, label) {
    try {
      var response = await fetch(url, { cache: "no-store", mode: "cors" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    } catch (error) {
      throw new Error((label || "Data source") + " unavailable");
    }
  }

  async function getKalshi(path) {
    var lastError;
    for (var i = 0; i < KALSHI_HOSTS.length; i++) {
      try {
        return await getJson(KALSHI_HOSTS[i] + path, "Kalshi");
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Kalshi market data unavailable");
  }

  async function refreshJournalResults() {
    var rows = JSON.parse(localStorage.getItem("edgeLabJournal") || "[]");
    var current = state.market && state.market.ticker;
    var unresolved = [];

    rows.forEach(function (row) {
      if (!row.result && row.ticker !== current && unresolved.indexOf(row.ticker) < 0) unresolved.push(row.ticker);
    });

    unresolved = unresolved.slice(-5);
    if (!unresolved.length) return;

    await Promise.all(unresolved.map(async function (ticker) {
      try {
        var data = await getKalshi("/markets/" + encodeURIComponent(ticker));
        var result = data.market && data.market.result;
        if (result === "yes" || result === "no") {
          rows.forEach(function (row) {
            if (row.ticker === ticker) {
              row.result = result.toUpperCase();
              row.correct = row.signal === "UP" ? result === "yes" : row.signal === "DOWN" ? result === "no" : "";
            }
          });
        }
      } catch (_) {}
    }));

    localStorage.setItem("edgeLabJournal", JSON.stringify(rows));
    updateJournalCount();
  }

  async function fetchMarket() {
    var data = await getKalshi("/markets?series_ticker=" + SERIES + "&status=open&limit=100");
    var now = Date.now();
    var list = (data.markets || []).filter(function (market) {
      return closeOf(market).getTime() > now;
    });

    list.sort(function (a, b) { return closeOf(a).getTime() - closeOf(b).getTime(); });

    var active = list.find(function (market) {
      var opens = new Date(market.open_time || 0).getTime();
      return !opens || opens <= now;
    }) || list[0];

    if (!active) throw new Error("No open BTC 15-minute contract found");

    if (!state.market || active.ticker !== state.market.ticker) state.manual = null;
    state.market = active;
    state.lastMarketFetch = now;
    refreshJournalResults();
  }

  async function fetchPriceData() {
    try {
      var base = "https://api.exchange.coinbase.com/products/BTC-USD";
      var results = await Promise.all([
        getJson(base + "/ticker", "Coinbase"),
        getJson(base + "/candles?granularity=60", "Coinbase")
      ]);
      state.proxy = num(results[0].price);
      state.candles = (results[1] || [])
        .sort(function (a, b) { return a[0] - b[0]; })
        .slice(-90);
      state.priceSource = "Coinbase proxy";
    } catch (coinbaseError) {
      var kraken = await Promise.all([
        getJson("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", "Kraken"),
        getJson("https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1", "Kraken")
      ]);
      var tickerKey = Object.keys(kraken[0].result || {}).find(function (key) { return key !== "last"; });
      var candleKey = Object.keys(kraken[1].result || {}).find(function (key) { return key !== "last"; });
      if (!tickerKey || !candleKey) throw new Error("BTC price feeds unavailable");
      state.proxy = num(kraken[0].result[tickerKey].c[0]);
      state.candles = (kraken[1].result[candleKey] || []).slice(-90);
      state.priceSource = "Kraken proxy";
    }
    state.lastCandleFetch = Date.now();
  }

  function calculateModel() {
    var market = state.market;
    if (!market || !state.candles.length) return null;

    var spot = state.manual || state.proxy;
    var target = targetOf(market);
    var seconds = (closeOf(market).getTime() - Date.now()) / 1000;
    if (!spot || !target || seconds <= 0) return null;

    var closes = state.candles.map(function (candle) { return num(candle[4]); }).filter(Boolean);
    var returns = [];
    for (var i = 1; i < closes.length; i++) returns.push(Math.log(closes[i] / closes[i - 1]));
    if (returns.length < 15) return null;

    var recent = returns.slice(-60);
    var weights = [];
    var sumWeight = 0;
    var mean = 0;

    for (i = 0; i < recent.length; i++) {
      var weight = Math.pow(0.965, recent.length - 1 - i);
      weights.push(weight);
      sumWeight += weight;
      mean += weight * recent[i];
    }
    mean /= sumWeight;

    var variance = 0;
    for (i = 0; i < recent.length; i++) {
      variance += weights[i] * Math.pow(recent[i] - mean, 2);
    }

    var sigma = Math.sqrt(variance / sumWeight);
    var lastFive = returns.slice(-5);
    var momentum = lastFive.reduce(function (a, b) { return a + b; }, 0) / lastFive.length;

    // Momentum receives only a 15% weight and is capped to reduce overreaction.
    var drift = clamp(momentum * 0.15, -sigma * 0.2, sigma * 0.2);

    // A Brownian approximation to a one-minute average has an effective
    // horizon about 40 seconds shorter than a single close observation.
    var effectiveSeconds = Math.max(5, seconds - 40);
    var horizonMinutes = effectiveSeconds / 60;
    var standardDeviation = Math.max(0.00008, sigma) * Math.sqrt(horizonMinutes);
    var z = (Math.log(target / spot) - drift * horizonMinutes) / standardDeviation;
    var pUp = clamp(1 - normalCdf(z), 0.005, 0.995);

    var upAsk = fieldPrice(market, ["yes_ask_dollars", "yes_ask"]);
    var downAsk = fieldPrice(market, ["no_ask_dollars", "no_ask"]);

    if (upAsk === null) {
      var noBid = fieldPrice(market, ["no_bid_dollars", "no_bid"]);
      if (noBid !== null) upAsk = 1 - noBid;
    }
    if (downAsk === null) {
      var yesBid = fieldPrice(market, ["yes_bid_dollars", "yes_bid"]);
      if (yesBid !== null) downAsk = 1 - yesBid;
    }

    var rawUp = upAsk === null ? null : pUp - upAsk;
    var rawDown = downAsk === null ? null : (1 - pUp) - downAsk;
    var best = null;

    if (rawUp !== null && rawDown !== null) {
      best = rawUp >= rawDown ? { side: "UP", raw: rawUp } : { side: "DOWN", raw: rawDown };
    }

    return {
      spot: spot,
      target: target,
      seconds: seconds,
      pUp: pUp,
      upAsk: upAsk,
      downAsk: downAsk,
      best: best,
      sigma: sigma
    };
  }

  function paint() {
    var market = state.market;
    var model = calculateModel();
    var ready = Boolean(market && model);

    el("dot").className = "dot" + (ready ? " ok" : "");
    el("status").textContent = ready ? "Live · refreshes automatically" : "Waiting for data";
    if (!market || !model) return;

    var close = closeOf(market);
    var minutes = Math.max(0, Math.floor(model.seconds / 60));
    var seconds = Math.max(0, Math.floor(model.seconds % 60));

    el("contract").textContent =
      (market.title || "Bitcoin Up or Down") + " · " +
      close.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    el("countdown").textContent = minutes + ":" + String(seconds).padStart(2, "0");
    el("target").textContent = money(model.target);
    el("spot").textContent = money(model.spot);
    el("spotSource").textContent = state.manual ? "Manual CF/Kalshi override" : state.priceSource;

    var distance = model.spot - model.target;
    el("distance").textContent = (distance >= 0 ? "+" : "") + money(distance);
    el("distance").className = "value " + (distance >= 0 ? "upc" : "downc");

    el("pUp").textContent = pct(model.pUp);
    el("pDown").textContent = pct(1 - model.pUp);
    el("modelProb").textContent =
      pct(Math.max(model.pUp, 1 - model.pUp)) + " " + (model.pUp >= 0.5 ? "UP" : "DOWN");
    el("probBar").style.width = (model.pUp * 100) + "%";

    el("upAsk").textContent = model.upAsk === null ? "—" : Math.round(model.upAsk * 100) + "¢";
    el("downAsk").textContent = model.downAsk === null ? "—" : Math.round(model.downAsk * 100) + "¢";

    var signal = "NO TRADE";
    var why = "Estimated advantage is not large enough after the safety threshold.";
    var cssClass = "wait";
    var edgeText = "—";

    if (model.best) {
      var net = model.best.raw - 0.03;
      edgeText = (net >= 0 ? "+" : "") + Math.round(net * 100) + " pts (" + model.best.side + ")";

      if (model.seconds <= 60) {
        why = "Final minute: settlement averaging is underway and this proxy cannot see the exact CF average.";
      } else if (model.best.raw >= 0.08) {
        signal = model.best.side;
        cssClass = model.best.side.toLowerCase();
        why = "Experimental " + model.best.side +
          " edge clears the 8-point threshold before the 3-point safety cushion.";
      }
    } else {
      why = "Kalshi ask prices are unavailable, so no actionable comparison can be made.";
    }

    el("edge").textContent = edgeText;
    el("signal").textContent = signal;
    el("signal").className = "signal " + cssClass;
    el("reason").textContent = why;
    maybeSave(model, signal);
  }

  function maybeSave(model, signal) {
    if (!state.market || model.seconds <= 0) return;

    var bucket = Math.floor(Date.now() / 60000);
    var key = state.market.ticker + "-" + bucket;
    if (key === state.lastSavedKey) return;
    state.lastSavedKey = key;

    var rows = JSON.parse(localStorage.getItem("edgeLabJournal") || "[]");
    rows.push({
      time: new Date().toISOString(),
      ticker: state.market.ticker,
      target: model.target,
      spot: model.spot,
      source: state.manual ? "manual" : state.priceSource.toLowerCase().replace(" proxy", ""),
      seconds_remaining: Math.round(model.seconds),
      p_up: Number(model.pUp.toFixed(4)),
      up_ask: model.upAsk,
      down_ask: model.downAsk,
      signal: signal,
      result: "",
      correct: ""
    });

    localStorage.setItem("edgeLabJournal", JSON.stringify(rows.slice(-2500)));
    updateJournalCount();
  }

  function updateJournalCount() {
    var rows = JSON.parse(localStorage.getItem("edgeLabJournal") || "[]");
    var calls = rows.filter(function (row) { return row.signal === "UP" || row.signal === "DOWN"; });
    var graded = calls.filter(function (row) { return row.correct === true || row.correct === false; });
    var correct = graded.filter(function (row) { return row.correct === true; }).length;
    var label = rows.length + " snapshots";
    if (graded.length) label += " · " + Math.round(correct / graded.length * 100) + "% on " + graded.length + " graded calls";
    el("journalCount").textContent = label;
  }

  async function refresh() {
    try {
      var now = Date.now();
      if (!state.market || now - state.lastMarketFetch > 15000 || closeOf(state.market).getTime() < now) {
        await fetchMarket();
      }
      if (!state.proxy || now - state.lastCandleFetch > 30000) await fetchPriceData();
      paint();
    } catch (error) {
      el("dot").className = "dot";
      el("status").textContent = "Data issue";
      el("reason").innerHTML = '<span class="error">' + error.message + ". Try again shortly.</span>";
    }
  }

  el("applyManual").onclick = function () {
    var value = Number(el("manualPrice").value.replace(/[$,]/g, ""));
    if (value > 1000) {
      state.manual = value;
      paint();
    }
  };

  el("clearManual").onclick = function () {
    state.manual = null;
    el("manualPrice").value = "";
    paint();
  };

  el("exportCsv").onclick = function () {
    var rows = JSON.parse(localStorage.getItem("edgeLabJournal") || "[]");
    if (!rows.length) return;

    var keys = Object.keys(rows[0]);
    var csv = [keys.join(",")].concat(rows.map(function (row) {
      return keys.map(function (key) {
        var value = row[key];
        return value === null || value === undefined ? "" : value;
      }).join(",");
    }));

    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv.join("\n")], { type: "text/csv" }));
    link.download = "btc-edge-lab-signals.csv";
    link.click();
  };

  updateJournalCount();
  refresh();
  setInterval(paint, 1000);
  setInterval(refresh, 15000);
})();