const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2"];

let trails = [];

// Wire up buttons via addEventListener — no inline onclick needed
document.getElementById("btn-launch").addEventListener("click", launch);
document.getElementById("btn-clear").addEventListener("click", clearAll);

function toMS(val, unit) {
  if (unit === "kmh") return val / 3.6;
  if (unit === "mph") return val * 0.44704;
  if (unit === "fts") return val * 0.3048;
  return val;
}

function unitLabel(unit) {
  return unit === "fts" ? "ft" : "m";
}

function velLabel(unit) {
  const map = { ms: "m/s", kmh: "km/h", mph: "mph", fts: "ft/s" };
  return map[unit] || "m/s";
}

function launch() {
  const rawV  = parseFloat(document.getElementById("velocity").value);
  const unit  = document.getElementById("vel-unit").value;
  const v     = toMS(rawV, unit);
  const deg   = parseFloat(document.getElementById("angle").value);
  const angle = deg * Math.PI / 180;
  const g     = parseFloat(document.getElementById("gravity").value);

  if (isNaN(v) || isNaN(deg) || v <= 0 || deg <= 0 || deg >= 90) return;

  const vx = v * Math.cos(angle);
  const vy = v * Math.sin(angle);

  const timeOfFlight = (2 * vy) / g;
  const maxHeight    = (vy * vy) / (2 * g);
  const range        = vx * timeOfFlight;

  const dt = 0.02;
  const points = [];
  for (let t = 0; t <= timeOfFlight + dt; t += dt) {
    const x = vx * t;
    const y = vy * t - 0.5 * g * t * t;
    points.push({ x, y: Math.max(0, y) });
    if (y < 0) break;
  }

  const color = COLORS[trails.length % COLORS.length];
  trails.push({ points, range, maxHeight, timeOfFlight, vx, vy, deg, rawV, unit, color });

  drawAll();
  updateTable();
}

function clearAll() {
  trails = [];
  drawAll();
  const tbody = document.getElementById("stats-body");
  tbody.innerHTML = `<tr class="empty-row"><td colspan="8">No launches yet — hit Launch to begin.</td></tr>`;
}

function drawAll() {
  const W = canvas.width;
  const H = canvas.height;
  const padL = 48, padB = 36, padT = 24, padR = 24;

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = "#fafaf9";
  ctx.fillRect(0, 0, W, H);

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // Grid
  const cols = 8, rows = 5;
  ctx.strokeStyle = "#e8e8e6";
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
  ctx.strokeStyle = "#c9c9c6";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(padL, H - padB); ctx.lineTo(W - padR, H - padB); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, H - padB); ctx.stroke();

  if (trails.length === 0) {
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "#a8a8a4";
    ctx.textAlign = "center";
    ctx.fillText("Set parameters and click Launch", W / 2, H / 2);
    ctx.textAlign = "left";
    return;
  }

  const maxR = Math.max(...trails.map(t => t.range));
  const maxH = Math.max(...trails.map(t => t.maxHeight));
  const scaleX = innerW / (maxR || 1);
  const scaleY = innerH / (maxH || 1);

  // Axis labels
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "#a8a8a4";
  ctx.textAlign = "right";
  ctx.fillText("0", padL - 6, H - padB + 4);
  ctx.textAlign = "left";
  ctx.fillText(`${maxR.toFixed(1)} m`, padL + innerW - 2, H - padB + 14);
  ctx.fillText(`${maxH.toFixed(1)} m`, padL + 4, padT + 4);

  trails.forEach((trail) => {
    const pts = trail.points;

    // Trajectory line
    ctx.beginPath();
    pts.forEach((p, i) => {
      const dx = padL + p.x * scaleX;
      const dy = (H - padB) - p.y * scaleY;
      i === 0 ? ctx.moveTo(dx, dy) : ctx.lineTo(dx, dy);
    });
    ctx.strokeStyle = trail.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.stroke();

    // Endpoint dots
    [pts[0], pts[pts.length - 1]].forEach(p => {
      ctx.beginPath();
      ctx.arc(padL + p.x * scaleX, (H - padB) - p.y * scaleY, 4, 0, Math.PI * 2);
      ctx.fillStyle = trail.color;
      ctx.fill();
    });

    // Apex dot (hollow)
    const apexIdx = pts.reduce((best, p, i) => p.y > pts[best].y ? i : best, 0);
    const apex = pts[apexIdx];
    ctx.beginPath();
    ctx.arc(padL + apex.x * scaleX, (H - padB) - apex.y * scaleY, 4, 0, Math.PI * 2);
    ctx.strokeStyle = trail.color;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = "#fafaf9";
    ctx.fill();
    ctx.stroke();
  });
}

function updateTable() {
  const tbody = document.getElementById("stats-body");
  tbody.innerHTML = "";

  trails.forEach((t, i) => {
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
    `;
    tbody.appendChild(tr);
  });
}

// Initial draw
drawAll();