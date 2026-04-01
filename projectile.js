const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

let trails = [];
let weatherData = null;
let weatherEnabled = true;

// ── UI wiring ──────────────────────────────────────────────────────────
document.getElementById("btn-launch").addEventListener("click", launch);
document.getElementById("btn-clear").addEventListener("click", clearAll);
document.getElementById("btn-retry").addEventListener("click", fetchWeather);
document.getElementById("weather-toggle").addEventListener("change", e => {
  weatherEnabled = e.target.checked;
});

// ── Unit helpers ───────────────────────────────────────────────────────
function toMS(val, unit) {
  if (unit === "kmh") return val / 3.6;
  if (unit === "mph") return val * 0.44704;
  if (unit === "fts") return val * 0.3048;
  return val;
}
function unitLabel(unit) { return unit === "fts" ? "ft" : "m"; }
function velLabel(unit) {
  return { ms: "m/s", kmh: "km/h", mph: "mph", fts: "ft/s" }[unit] || "m/s";
}

// ── Air density physics ────────────────────────────────────────────────
// Computes air density (kg/m³) from real atmospheric measurements.
//
// Uses the CIPM-2007 formula for moist air:
//   ρ = (p_d / (R_d * T)) + (p_v / (R_v * T))
//
// where:
//   p_d = partial pressure of dry air = p - p_v
//   p_v = partial pressure of water vapour = φ · p_sat
//   p_sat = saturation vapour pressure via Buck equation
//   T   = absolute temperature (K)
//   R_d = specific gas constant for dry air = 287.058 J/(kg·K)
//   R_v = specific gas constant for water vapour = 461.495 J/(kg·K)
//
// Standard sea-level density is ~1.225 kg/m³ (15 °C, 0% RH, 101325 Pa).

function computeAirDensity(tempC, relHumidityPct, pressurePa) {
  const T    = tempC + 273.15;                   // Kelvin
  const phi  = relHumidityPct / 100;             // 0–1
  const Rd   = 287.058;                          // J/(kg·K) dry air
  const Rv   = 461.495;                          // J/(kg·K) water vapour

  // Saturation vapour pressure (Buck equation, Pa)
  const pSat = 611.21 * Math.exp((18.678 - tempC / 234.5) * (tempC / (257.14 + tempC)));

  const pv   = phi * pSat;                       // partial pressure of vapour
  const pd   = pressurePa - pv;                  // partial pressure of dry air

  return (pd / (Rd * T)) + (pv / (Rv * T));      // kg/m³
}

// ── Weather fetch ──────────────────────────────────────────────────────
async function fetchWeather() {
  const loadEl = document.getElementById("weather-loading");
  const dataEl = document.getElementById("weather-data");
  const errEl  = document.getElementById("weather-error");

  loadEl.classList.remove("hidden");
  dataEl.classList.add("hidden");
  errEl.classList.add("hidden");

  try {
    const coords = await getCoords();

    // Reverse geocode
    const geoRes  = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${coords.lat}&lon=${coords.lon}&format=json`
    );
    const geoJson = await geoRes.json();
    const city    = geoJson.address?.city || geoJson.address?.town ||
                    geoJson.address?.village || geoJson.address?.county || "Your location";

    // Fetch weather — including temperature, humidity, pressure, wind
    const wxRes  = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&current=temperature_2m,relative_humidity_2m,surface_pressure,` +
      `wind_speed_10m,wind_direction_10m,wind_gusts_10m`
    );
    const wxJson = await wxRes.json();
    const cur    = wxJson.current;

    const tempC      = cur.temperature_2m;           // °C
    const humidity   = cur.relative_humidity_2m;     // %
    const pressureHPa = cur.surface_pressure;        // hPa
    const pressurePa  = pressureHPa * 100;           // Pa
    const windSpeedMS = cur.wind_speed_10m / 3.6;    // m/s
    const gustMS      = (cur.wind_gusts_10m || 0) / 3.6;
    const windDir     = cur.wind_direction_10m;      // degrees

    const density = computeAirDensity(tempC, humidity, pressurePa);

    weatherData = { tempC, humidity, pressurePa, pressureHPa, windSpeedMS, gustMS, windDir, density, city };

    // Update UI
    document.getElementById("weather-loc").textContent = city.toUpperCase();
    document.getElementById("wind-speed-display").textContent = `${cur.wind_speed_10m.toFixed(1)} km/h`;
    document.getElementById("wind-dir-display").textContent   = `${windDir}° ${degToCompass(windDir)}`;
    document.getElementById("temp-display").textContent       = `${tempC.toFixed(1)} °C`;
    document.getElementById("humidity-display").textContent   = `${humidity} %`;
    document.getElementById("pressure-display").textContent   = `${pressureHPa.toFixed(0)} hPa`;
    document.getElementById("density-display").textContent    = `${density.toFixed(3)} kg/m³`;

    loadEl.classList.add("hidden");
    dataEl.classList.remove("hidden");
  } catch (err) {
    console.error("Weather fetch failed:", err);
    loadEl.classList.add("hidden");
    errEl.classList.remove("hidden");
  }
}

function degToCompass(deg) {
  const dirs = ["N","NE","E","SE","S","SW","W","NW"];
  return dirs[Math.round(deg / 45) % 8];
}

function getCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ lat: 41.8781, lon: -87.6298 });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      ()  => resolve({ lat: 41.8781, lon: -87.6298 }),
      { timeout: 5000 }
    );
  });
}

// ── Physics simulation ────────────────────────────────────────────────
// Drag force: F_d = 0.5 * Cd * A * ρ * v²
// Applied as acceleration: a_d = F_d / m  (opposed to velocity direction)
// Wind is added as a persistent horizontal velocity bias each step.

function simulate(vx0, vy0, g, Cd, area, mass, airDensity, windX) {
  const dt     = 0.02;
  const points = [];
  let vx = vx0, vy = vy0;
  let x  = 0,   y  = 0;
  const k = 0.5 * Cd * area * airDensity / mass;  // drag constant

  while (true) {
    points.push({ x, y: Math.max(0, y) });
    if (points.length > 1 && y < 0) break;
    if (points.length > 15000) break;

    // Effective velocity relative to air (wind shifts vx)
    const vRelX = vx - windX;
    const vRelY = vy;
    const speed = Math.sqrt(vRelX * vRelX + vRelY * vRelY);

    // Drag acceleration magnitude
    const dragAcc = k * speed * speed;

    // Drag components (oppose relative velocity)
    const ax = -dragAcc * (vRelX / (speed || 1));
    const ay = -dragAcc * (vRelY / (speed || 1)) - g;

    vx += ax * dt;
    vy += ay * dt;
    x  += vx * dt;
    y  += vy * dt;
  }

  return points;
}

function getWindX() {
  if (!weatherData || !weatherEnabled) return 0;
  // Meteorological: direction wind comes FROM. Flip to get motion direction.
  const towardDeg = (weatherData.windDir + 180) % 360;
  const rad = towardDeg * Math.PI / 180;
  return Math.sin(rad) * weatherData.windSpeedMS;
}

function getAirDensity() {
  if (!weatherData || !weatherEnabled) return 1.225; // ISA standard
  return weatherData.density;
}

// ── Launch ────────────────────────────────────────────────────────────
function launch() {
  const rawV  = parseFloat(document.getElementById("velocity").value);
  const unit  = document.getElementById("vel-unit").value;
  const v     = toMS(rawV, unit);
  const deg   = parseFloat(document.getElementById("angle").value);
  const angle = deg * Math.PI / 180;
  const g     = parseFloat(document.getElementById("gravity").value);
  const Cd    = parseFloat(document.getElementById("cd").value) || 0;
  const mass  = parseFloat(document.getElementById("mass").value) || 1;
  const area  = parseFloat(document.getElementById("area").value) || 0.01;

  if (isNaN(v) || isNaN(deg) || v <= 0 || deg <= 0 || deg >= 90) return;

  const vx0 = v * Math.cos(angle);
  const vy0 = v * Math.sin(angle);

  const airDensity = getAirDensity();
  const windX      = getWindX();

  const points = simulate(vx0, vy0, g, Cd, area, mass, airDensity, windX);

  const range        = points[points.length - 1].x;
  const maxHeight    = Math.max(...points.map(p => p.y));
  const timeOfFlight = points.length * 0.02;
  const color        = COLORS[trails.length % COLORS.length];
  const hasWind      = Math.abs(windX) > 0.01 && weatherEnabled;
  const windDesc     = hasWind
    ? `${(weatherData.windSpeedMS * 3.6).toFixed(1)} km/h ${degToCompass(weatherData.windDir)}`
    : "—";

  trails.push({
    points, range, maxHeight, timeOfFlight,
    vx: vx0, vy: vy0, deg, rawV, unit, color,
    Cd, mass, area, airDensity, hasWind, windDesc, windX
  });

  updateBadges(Cd, airDensity, windX);
  drawAll();
  updateTable();
}

function updateBadges(Cd, airDensity, windX) {
  const el = document.getElementById("physics-badges");
  el.innerHTML = "";

  if (Cd > 0) {
    const b = document.createElement("span");
    b.className = "badge badge-drag";
    b.textContent = `Cd ${Cd}`;
    el.appendChild(b);
  }

  const b2 = document.createElement("span");
  b2.className = "badge badge-density";
  b2.textContent = `ρ ${airDensity.toFixed(3)} kg/m³`;
  el.appendChild(b2);

  if (Math.abs(windX) > 0.01 && weatherEnabled) {
    const b3 = document.createElement("span");
    b3.className = "badge badge-wind";
    b3.textContent = `Wind ${(weatherData.windSpeedMS * 3.6).toFixed(1)} km/h`;
    el.appendChild(b3);
  }
}

// ── Clear ─────────────────────────────────────────────────────────────
function clearAll() {
  trails = [];
  document.getElementById("physics-badges").innerHTML = "";
  drawAll();
  document.getElementById("stats-body").innerHTML =
    `<tr class="empty-row"><td colspan="10">No launches yet — hit Launch to begin.</td></tr>`;
}

// ── Draw ──────────────────────────────────────────────────────────────
function drawAll() {
  const W = canvas.width, H = canvas.height;
  const padL = 50, padB = 36, padT = 24, padR = 20;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, 0, W, H);

  // Grid
  const cols = 8, rows = 5;
  ctx.strokeStyle = "#ebebeb";
  ctx.lineWidth = 1;
  for (let i = 0; i <= cols; i++) {
    const x = padL + (i / cols) * innerW;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, H - padB); ctx.stroke();
  }
  for (let i = 0; i <= rows; i++) {
    const y = padT + (i / rows) * innerH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
  }

  // Axes
  ctx.strokeStyle = "#c8c8c8";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.stroke();

  if (trails.length === 0) {
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#aaa";
    ctx.textAlign = "center";
    ctx.fillText("Set parameters and click Launch", W / 2, H / 2);
    ctx.textAlign = "left";
    return;
  }

  const allX  = trails.flatMap(t => t.points.map(p => p.x));
  const allY  = trails.flatMap(t => t.points.map(p => p.y));
  const minX  = Math.min(...allX);
  const maxX  = Math.max(...allX);
  const maxH  = Math.max(...allY);
  const spanX = (maxX - minX) || 1;

  const toCanvasX = x => padL + ((x - minX) / spanX) * innerW;
  const toCanvasY = y => (H - padB) - (y / (maxH || 1)) * innerH;

  // Axis labels
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = "#aaa";

  ctx.textAlign = "right";
  for (let i = 0; i <= rows; i++) {
    const val = maxH * (1 - i / rows);
    ctx.fillText(val.toFixed(0), padL - 5, padT + (i / rows) * innerH + 4);
  }

  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const val = minX + spanX * (i / 4);
    ctx.fillText(val.toFixed(0), padL + (i / 4) * innerW, H - padB + 14);
  }
  ctx.fillText("m →", W - padR, H - padB + 14);

  ctx.textAlign = "left";
  ctx.fillText("↑ m", padL + 4, padT - 6);

  // Wind indicator
  if (weatherData && weatherEnabled && trails.length > 0) {
    const windX = getWindX();
    if (Math.abs(windX) > 0.01) {
      const arrowLen = Math.min(50, Math.abs(windX) * 3 + 12);
      const dir = windX > 0 ? 1 : -1;
      const ax = padL + innerW * 0.88;
      const ay = padT + 16;
      ctx.save();
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle   = "#2563eb";
      ctx.globalAlpha = 0.5;
      ctx.lineWidth   = 1.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ax + arrowLen * dir, ay); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ax + arrowLen * dir, ay);
      ctx.lineTo(ax + (arrowLen - 7) * dir, ay - 4);
      ctx.lineTo(ax + (arrowLen - 7) * dir, ay + 4);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = dir > 0 ? "left" : "right";
      ctx.fillText(`wind ${(weatherData.windSpeedMS * 3.6).toFixed(0)} km/h`, ax - (dir < 0 ? arrowLen + 4 : 0), ay - 7);
      ctx.restore();
    }
  }

  // Draw trajectories
  trails.forEach(trail => {
    const pts = trail.points;

    ctx.beginPath();
    pts.forEach((p, i) => {
      const dx = toCanvasX(p.x);
      const dy = toCanvasY(p.y);
      i === 0 ? ctx.moveTo(dx, dy) : ctx.lineTo(dx, dy);
    });
    ctx.strokeStyle = trail.color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = "round";
    ctx.stroke();

    // Start and end dots
    [pts[0], pts[pts.length - 1]].forEach(p => {
      ctx.beginPath();
      ctx.arc(toCanvasX(p.x), toCanvasY(p.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = trail.color;
      ctx.fill();
    });

    // Apex (hollow)
    const apexIdx = pts.reduce((best, p, i) => p.y > pts[best].y ? i : best, 0);
    const apex    = pts[apexIdx];
    ctx.beginPath();
    ctx.arc(toCanvasX(apex.x), toCanvasY(apex.y), 4, 0, Math.PI * 2);
    ctx.strokeStyle = trail.color;
    ctx.lineWidth   = 1.5;
    ctx.fillStyle   = "#fafafa";
    ctx.fill();
    ctx.stroke();
  });
}

// ── Table ─────────────────────────────────────────────────────────────
function updateTable() {
  const tbody = document.getElementById("stats-body");
  tbody.innerHTML = "";

  trails.forEach(t => {
    const ul = unitLabel(t.unit);
    const vl = velLabel(t.unit);
    const f  = t.unit === "fts" ? 3.28084 : 1;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="color-dot" style="background:${t.color}"></span></td>
      <td>${t.deg}°</td>
      <td>${t.rawV} ${vl}</td>
      <td>${(t.maxHeight * f).toFixed(2)} ${ul}</td>
      <td>${(t.range * f).toFixed(2)} ${ul}</td>
      <td>${t.timeOfFlight.toFixed(3)} s</td>
      <td>${(t.vx * f).toFixed(2)} ${ul}/s</td>
      <td>${(t.vy * f).toFixed(2)} ${ul}/s</td>
      <td>${t.airDensity.toFixed(3)} kg/m³</td>
      <td class="${t.hasWind ? "wind-cell" : "no-wind-cell"}">${t.windDesc}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Init ──────────────────────────────────────────────────────────────
drawAll();
fetchWeather();