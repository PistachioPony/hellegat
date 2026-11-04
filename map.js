// The tide map under the chart: one ocean tide splits around Long Island and reaches
// Hell Gate from both ends. It's a diagram of how the tide moves, not the river right now.
(() => {
  const WEST = -74.35, EAST = -71.75, SOUTH = 40.25, NORTH = 41.4;
  const ASPECT = 1.7;              // width over height, about true for this latitude
  const GRID = 900, CELL = 2;      // the water is worked out on a 900 wide grid, then painted at half that
  const TIDE = 12.42;              // hours in one tide
  const PACE = 1.8;                // hours of tide per second on screen
  const ROAD_GAP = 3;              // hours between the crest reaching the Battery and Kings Point
  const MOMENTUM = 0.75;           // hours the current lags the push. A round figure for the diagram
  const BATTERY_RANGE = 2.3, KINGS_POINT_RANGE = 3.6; // simplified, so this map shows no numbers
  const PARTICLES = 420;
  const HARBOR_SOFTEN = 0.35;       // the harbor road's water leans this far toward the pale crest, so it reads as water
  const FRONT_UP = 0.94, FRONT_WEST = 0.34; // the ocean front's direction: north, tilted about 20° west. Chosen by eye for the diagram, not measured

  const BATTERY = [-74.0142, 40.7006], KINGS_POINT = [-73.7649, 40.8103], HELL_GATE = [-73.938, 40.778];
  const EAST_RIVER = [BATTERY, [-73.997, 40.706], [-73.973, 40.713], [-73.969, 40.744], [-73.955, 40.757],
    HELL_GATE, [-73.89, 40.792], [-73.83, 40.801], [-73.795, 40.803], KINGS_POINT];
  // The crests stop here, one from each side, because this is where the two roads meet
  const HELL_GATE_WALL = [[-73.926, 40.772], [-73.9, 40.806]];
  // Rough outlines of each road's water. Past these the tide is still the open ocean, with no color of its own.
  const HARBOR_ROAD = [[-74.45, 40.42], [-74.0, 40.42], [-73.9, 40.56], [-73.88, 40.8], [-73.96, 40.8], [-74.0, 40.71], [-74.1, 40.68], [-74.45, 40.6]];
  const SOUND_ROAD = [[-73.91, 40.8], [-73.7, 40.72], [-72.9, 40.82], [-72.24, 41.17], [-71.84, 41.33], [-71.7, 41.6], [-73.8, 41.6]];

  const fig = document.getElementById("tide-map-fig");
  const canvas = document.getElementById("tide-map"), ctx = canvas.getContext("2d");
  const button = document.getElementById("tide-pause");
  const reveal = document.getElementById("reveal");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");

  const gridH = Math.round(GRID / ASPECT), gridX = lon => (lon - WEST) / (EAST - WEST) * GRID, gridY = lat => (NORTH - lat) / (NORTH - SOUTH) * gridH;
  const paintW = GRID / CELL | 0, paintH = gridH / CELL | 0;
  const paint = document.createElement("canvas"); paint.width = paintW; paint.height = paintH;
  const paintCtx = paint.getContext("2d"), pixels = paintCtx.createImageData(paintW, paintH);

  let land = null, water = null, distance = null, roads = null, slope = null, speed = 1, arriveBattery = 0;
  let width = 0, height = 0, landLayer = null, colors = null, particles = [];
  let hours = 0, last = 0, paused = calm.matches, onScreen = true, dash = 0;

  const shade = new Float32Array(1024); // how bright the water is at each point of the tide's passing
  for (let i = 0; i < shade.length; i++) {
    const x = i / shade.length, behind = x, ahead = 1 - x;
    const crest = Math.exp(-((Math.min(behind, ahead) / 0.02) ** 2));
    const ripples = behind < 0.17 ? 0.38 * (1 - behind / 0.17) * ((Math.cos(2 * Math.PI * behind / 0.038) + 1) / 2) ** 3 : 0;
    shade[i] = Math.min(1, crest + ripples + 0.06 * (Math.cos(2 * Math.PI * x) + 1) / 2);
  }

  function tracePath(c, ring, X, Y) {
    c.moveTo(X(ring[0]), Y(ring[1]));
    for (let i = 2; i < ring.length; i += 2) c.lineTo(X(ring[i]), Y(ring[i + 1]));
    c.closePath();
  }

  // The county shapes count rivers and bays as land, so the water layer is cut back out of them.
  function drawLand(c, X, Y) {
    c.beginPath();
    for (const ring of land.land) tracePath(c, ring, X, Y);
    c.fill(); c.lineWidth = 0.6; c.stroke(); // the thin stroke hides the seams between counties
    c.globalCompositeOperation = "destination-out";
    for (const shape of land.water) {
      c.beginPath();
      for (const ring of shape) tracePath(c, ring, X, Y);
      c.fill("evenodd");
    }
    c.globalCompositeOperation = "source-over";
  }

  // Land becomes false and water true on the grid.
  function makeWater() {
    const c = document.createElement("canvas"); c.width = GRID; c.height = gridH;
    const x = c.getContext("2d", { willReadFrequently: true });
    drawLand(x, gridX, gridY);
    const data = x.getImageData(0, 0, GRID, gridH).data;
    const open = new Uint8Array(GRID * gridH);
    for (let i = 0; i < open.length; i++) open[i] = data[i * 4 + 3] < 128 ? 1 : 0;
    return open;
  }

  function wall(open, [[lonA, latA], [lonB, latB]]) {
    const copy = open.slice(), ax = gridX(lonA), ay = gridY(latA), bx = gridX(lonB), by = gridY(latB);
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(ax + (bx - ax) * i / steps), y = Math.round(ay + (by - ay) * i / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) copy[(y + dy) * GRID + x + dx] = 0;
    }
    return copy;
  }

  function nearestWater(open, [lon, lat]) {
    const x = Math.round(gridX(lon)), y = Math.round(gridY(lat));
    for (let r = 0; r < 40; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const i = (y + dy) * GRID + x + dx;
      if (open[i]) return i;
    }
    return -1;
  }

  // How far the water has to travel to reach each cell, going around the land.
  // Buckets by whole distance keep this fast enough to run when the page loads.
  function travel(open, sources, start = () => 0) {
    const far = new Float32Array(open.length).fill(Infinity), done = new Uint8Array(open.length), buckets = [];
    for (const s of sources) {
      far[s] = start(s);
      (buckets[Math.floor(far[s])] ||= []).push(s);
    }
    const steps = [[1, 1], [-1, 1], [GRID, 1], [-GRID, 1], [GRID + 1, Math.SQRT2], [GRID - 1, Math.SQRT2], [-GRID + 1, Math.SQRT2], [-GRID - 1, Math.SQRT2]];
    for (let b = 0; b < buckets.length; b++) {
      const list = buckets[b];
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (done[c]) continue; // every step costs at least 1, so the first visit is the shortest
        done[c] = 1;
        for (const [step, cost] of steps) {
          const n = c + step, d = far[c] + cost;
          if (!open[n] || d >= far[n]) continue;
          far[n] = d;
          (buckets[Math.floor(d)] ||= []).push(n);
        }
      }
    }
    return far;
  }

  // Cut the fine grid down to the painted one, then soften it, so the fronts sweep smoothly.
  function shrink(far) {
    const out = new Float32Array(paintW * paintH);
    const sum = (x, y) => far[y * GRID + x];
    for (let y = 0; y < paintH; y++) for (let x = 0; x < paintW; x++) {
      let total = 0, n = 0;
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const d = sum(x * CELL + ox, Math.min(gridH - 1, y * CELL + oy));
        if (d < Infinity) { total += d; n++; }
      }
      out[y * paintW + x] = n ? total / n : -1;
    }
    for (let pass = 0; pass < 2; pass++) {
      const from = out.slice();
      for (let y = 2; y < paintH - 2; y++) for (let x = 2; x < paintW - 2; x++) {
        const i = y * paintW + x;
        if (from[i] < 0) continue;
        let total = 0, n = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const d = from[i + dy * paintW + dx];
          if (d >= 0 && Math.abs(d - from[i]) < 30) { total += d; n++; }
        }
        out[i] = total / n;
      }
    }
    return out;
  }

  // How much each painted cell belongs to a road, 0 to 1, soft where it meets the open ocean.
  function roadWeight(outline) {
    const c = document.createElement("canvas"); c.width = paintW; c.height = paintH;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.beginPath();
    outline.forEach(([lon, lat], i) => i ? x.lineTo(gridX(lon) / CELL, gridY(lat) / CELL) : x.moveTo(gridX(lon) / CELL, gridY(lat) / CELL));
    x.fill();
    const data = x.getImageData(0, 0, paintW, paintH).data, out = new Float32Array(paintW * paintH);
    for (let i = 0; i < out.length; i++) out[i] = data[i * 4 + 3] / 255;
    for (let pass = 0; pass < 4; pass++) {
      const from = out.slice();
      for (let y = 4; y < paintH - 4; y++) for (let x = 4; x < paintW - 4; x++) {
        let total = 0;
        for (let d = -4; d <= 4; d++) total += from[y * paintW + x + d];
        out[y * paintW + x] = total / 9;
      }
      const across = out.slice();
      for (let y = 4; y < paintH - 4; y++) for (let x = 4; x < paintW - 4; x++) {
        let total = 0;
        for (let d = -4; d <= 4; d++) total += across[(y + d) * paintW + x];
        out[y * paintW + x] = total / 9;
      }
    }
    return out;
  }

  function buildWater() {
    water = makeWater();
    const walled = wall(water, HELL_GATE_WALL);
    // The ocean tide comes in as one long front, slanted, moving up from the south and a little west
    const ocean = [], start = i => (gridH - Math.floor(i / GRID)) * FRONT_UP + (GRID - i % GRID) * FRONT_WEST;
    for (let x = 1; x < GRID - 1; x++) if (walled[(gridH - 2) * GRID + x]) ocean.push((gridH - 2) * GRID + x);
    for (let y = Math.round(gridY(41.2)); y < gridH - 1; y++) if (walled[y * GRID + GRID - 2]) ocean.push(y * GRID + GRID - 2);
    const far = travel(walled, ocean, start);

    const battery = nearestWater(walled, BATTERY), kings = nearestWater(walled, KINGS_POINT);
    speed = (far[kings] - far[battery]) / ROAD_GAP;
    arriveBattery = far[battery] / speed;
    distance = shrink(far);
    roads = { harbor: roadWeight(HARBOR_ROAD), sound: roadWeight(SOUND_ROAD) };

    slope = new Float32Array(paintW * paintH * 2);
    for (let y = 1; y < paintH - 1; y++) for (let x = 1; x < paintW - 1; x++) {
      const i = y * paintW + x, here = distance[i];
      if (here < 0) continue;
      const side = o => distance[i + o] < 0 ? here : distance[i + o];
      const gx = side(1) - side(-1), gy = side(paintW) - side(-paintW), run = Math.hypot(gx, gy) || 1;
      slope[i * 2] = gx / run; slope[i * 2 + 1] = gy / run;
    }
    particles = Array.from({ length: PARTICLES }, () => newParticle({}));
  }

  // A particle is born. The particles are the little streaks of water that show the tide moving. Each one has a random life span and is reborn somewhere else when it dies.
  // At each spot's own slack the specks fade out, then come back as the water starts moving again. So the whole map quietly does exactly what the site is about, everywhere, all the time.
  function newParticle(p) {
    for (let tries = 0; tries < 60; tries++) {
      const x = Math.random() * paintW | 0, y = Math.random() * paintH | 0;
      if (distance[y * paintW + x] < 0 || !water[y * CELL * GRID + x * CELL]) continue;
      p.x = x; p.y = y; p.age = 0; p.life = 2 + Math.random() * 3;
      return p;
    }
    p.x = 0; p.y = 0; p.age = 0; p.life = 0;
    return p;
  }

  const rgb = hex => { const n = parseInt(hex.trim().slice(1), 16); return [n >> 16, n >> 8 & 255, n & 255]; };

  function readColors() {
    const cs = getComputedStyle(document.documentElement), get = k => cs.getPropertyValue("--" + k);
    const pale = rgb(get("crest"));
    colors = {
      water: rgb(get("water")), crest: rgb(get("crest")), harbor: rgb(get("harbor")).map((c, i) => c + (pale[i] - c) * HARBOR_SOFTEN), sound: rgb(get("sound")),
      land: get("land").trim(), rule: get("rule").trim(), ink: get("ink").trim(), muted: get("muted").trim(), slack: get("slack").trim(),
      harborLine: get("harbor").trim(), soundLine: get("sound").trim()
    };
  }

  function sizeMap() {
    const dpr = window.devicePixelRatio || 1;
    width = canvas.parentElement.clientWidth - 24; height = Math.round(width / ASPECT);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr); canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!land) return;
    readColors();
    landLayer = document.createElement("canvas"); landLayer.width = canvas.width; landLayer.height = canvas.height;
    const c = landLayer.getContext("2d"), X = lon => (lon - WEST) / (EAST - WEST) * width, Y = lat => (NORTH - lat) / (NORTH - SOUTH) * height;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.lineJoin = "round";
    c.fillStyle = c.strokeStyle = colors.land;
    drawLand(c, X, Y);
    draw();
  }

  const X = lon => (lon - WEST) / (EAST - WEST) * width, Y = lat => (NORTH - lat) / (NORTH - SOUTH) * height;

  function paintWater() {
    const { water: base, crest, harbor, sound } = colors, data = pixels.data, wave = hours / TIDE, perCell = 1 / (speed * TIDE);
    for (let i = 0; i < distance.length; i++) {
      const d = distance[i], j = i * 4;
      if (d < 0) { data[j] = base[0]; data[j + 1] = base[1]; data[j + 2] = base[2]; data[j + 3] = 255; continue; }
      const x = wave - d * perCell, a = shade[((x - Math.floor(x)) * 1024) | 0] * 0.85;
      const h = roads.harbor[i], s = roads.sound[i], o = Math.max(0, 1 - h - s);
      for (let k = 0; k < 3; k++) {
        const c = (crest[k] * 0.62 + base[k] * 0.38) * o + harbor[k] * h + sound[k] * s;
        data[j + k] = base[k] + (c - base[k]) * a;
      }
      data[j + 3] = 255;
    }
    paintCtx.putImageData(pixels, 0, 0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
    ctx.drawImage(paint, 0, 0, width, height);
  }

  // How the particles move, and how they are drawn. The flow is fastest at the crest and low water, and pauses in between, as in a tide that travels.
  function moveParticles(dt) {
    const wave = hours / TIDE, perCell = 1 / (speed * TIDE), scale = width / paintW;
    ctx.lineCap = "round"; ctx.lineWidth = 1; ctx.strokeStyle = colors.ink;
    for (const p of particles) {
      const i = (p.y | 0) * paintW + (p.x | 0);
      p.age += dt;
      if (p.age > p.life || distance[i] < 0) { newParticle(p); continue; }
      // At each spot, water moves onward fastest at that spot's high water and back fastest at its low water, pausing in between, as in a tide that travels
      const flow = Math.sin(2 * Math.PI * (wave - distance[i] * perCell + 0.25));
      const vx = slope[i * 2] * flow, vy = slope[i * 2 + 1] * flow;
      p.x += vx * dt * 26; p.y += vy * dt * 26;
      const next = (p.y | 0) * paintW + (p.x | 0);
      if (distance[next] < 0 || !water[(p.y | 0) * CELL * GRID + (p.x | 0) * CELL]) { newParticle(p); continue; }
      // globalAlpha is how see through it is. 1 is fully opaque, 0 is fully transparent. The particles are drawn as short lines, and the alpha is scaled by how long the particle has been alive and how fast the water is moving at that spot.
      ctx.globalAlpha = 0.24 * Math.min(1, p.age * 2, (p.life - p.age) * 2) * Math.abs(flow);
      ctx.beginPath(); ctx.moveTo(p.x * scale, p.y * scale);
      ctx.lineTo((p.x - vx * 4) * scale, (p.y - vy * 4) * scale); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Levels on each side, and the current they push, late by MOMENTUM
  const tideAt = (t, range, arrives) => range * Math.cos(2 * Math.PI * (t - arrives) / TIDE);
  const levelBattery = t => tideAt(t, BATTERY_RANGE, arriveBattery), levelKings = t => tideAt(t, KINGS_POINT_RANGE, arriveBattery + ROAD_GAP);
  // The 1.45 scales the current so its strongest flow comes out at about 1
  const currentAt = t => (levelBattery(t - MOMENTUM) - levelKings(t - MOMENTUM)) / (BATTERY_RANGE + KINGS_POINT_RANGE) * 1.45;

  function text(words, x, y, font, color, align) {
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = colors.land; // a halo, so words stay readable as a crest passes
    ctx.strokeText(words, x, y);
    ctx.fillStyle = color; ctx.fillText(words, x, y);
  }

  function drawRiver(dt) {
    // Slack while the current is under a tenth of its strongest. The page's real rule is 0.5 knots, and NOAA's
    // peaks at Hell Gate average about 3.4 knots flooding and 4.3 ebbing (November 2026), so the map's slack is a little shorter
    const current = currentAt(hours), still = Math.abs(current) < 0.1;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    EAST_RIVER.forEach(([lon, lat], i) => i ? ctx.lineTo(X(lon), Y(lat)) : ctx.moveTo(X(lon), Y(lat)));
    dash -= current * dt * 46;
    ctx.setLineDash([7, 13]); ctx.lineDashOffset = dash; ctx.lineWidth = 1.7; ctx.strokeStyle = colors.ink;
    ctx.globalAlpha = Math.min(1, 0.25 + Math.abs(current)); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;

    const hx = X(HELL_GATE[0]), hy = Y(HELL_GATE[1]), small = width < 560;
    const glow = still ? 1 - Math.abs(current) / 0.1 : 0;
    if (glow) {
      ctx.fillStyle = colors.slack; ctx.globalAlpha = 0.28 * glow;
      ctx.beginPath(); ctx.arc(hx, hy, 11 + 7 * glow, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = glow ? colors.slack : colors.ink; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(hx, hy, 6.5, 0, Math.PI * 2); ctx.stroke();

    for (const [spot, color, level, range] of [[BATTERY, colors.harborLine, levelBattery(hours), BATTERY_RANGE], [KINGS_POINT, colors.soundLine, levelKings(hours), KINGS_POINT_RANGE]]) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(X(spot[0]), Y(spot[1]), 3.5 + 2 * (level / range + 1) / 2, 0, Math.PI * 2); ctx.fill();
    }

    const sans = (small ? 11 : 13), name = `600 ${sans}px 'Public Sans', system-ui, sans-serif`, serif = `italic ${sans}px 'Libre Caslon Text', Georgia, serif`;
    const state = still ? "slack" : current > 0 ? "flowing to the Sound" : "flowing to the harbor", stateColor = glow ? colors.slack : colors.ink;
    if (small) { // not enough room left of the harbor on a phone, so the labels sit on the land to the right
      text("Hell Gate", hx - 2, hy - 15, name, colors.ink, "center");
      text(state, hx + 10, hy + 13, serif, stateColor, "left");
      text("The Battery", X(BATTERY[0]) + 8, Y(BATTERY[1]) + 13, name, colors.harborLine, "left");
    } else {
      text("Hell Gate", hx - 11, hy - 11, name, colors.ink, "right");
      text(state, hx - 11, hy + 5, serif, stateColor, "right");
      text("The Battery", X(BATTERY[0]) - 8, Y(BATTERY[1]) + 6, name, colors.harborLine, "right");
    }
    text("Kings Point", X(KINGS_POINT[0]) + 7, Y(KINGS_POINT[1]) - 12, name, colors.soundLine, "left");
    text("Long Island Sound", X(-72.82), Y(41.11), serif, colors.ink, "center");
    text("Long Island", X(-72.95), Y(40.84), `500 ${sans}px 'Public Sans', system-ui, sans-serif`, colors.muted, "center");
    text("Atlantic Ocean", X(-72.65), Y(40.47), serif, colors.ink, "center");
  }

  function draw(dt = 0) {
    if (!distance || !landLayer) return;
    paintWater();
    moveParticles(dt);
    ctx.drawImage(landLayer, 0, 0, width, height);
    drawRiver(dt);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (paused || !onScreen || !reveal.hidden || now - last < 30) { if (paused || !onScreen || !reveal.hidden) last = now; return; }
    const dt = Math.min(0.1, (now - last) / 1e3);
    last = now;
    hours += dt * PACE;
    draw(dt);
  }

  function showPaused() {
    button.textContent = paused ? "Play" : "Pause";
    button.setAttribute("aria-pressed", String(paused));
  }

  button.addEventListener("click", () => { paused = !paused; showPaused(); });
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(canvas);
  new ResizeObserver(sizeMap).observe(document.querySelector(".wrap"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", sizeMap);

  fetch("map-land.json").then(res => {
    if (!res.ok) throw new Error(res.status);
    return res.json();
  }).then(rings => {
    land = rings;
    buildWater();
    hours = arriveBattery + 0.6; // opens with the crest in the harbor and still on its way down the Sound
    showPaused();
    sizeMap();
    requestAnimationFrame(frame);
  }).catch(() => { fig.hidden = true; });
})();
