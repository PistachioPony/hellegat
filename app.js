(() => {
  const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  // NOAA stations. All three give predictions, so the whole day is known ahead.
  // The two water level stations also report what the water actually did; Hell Gate has no live meter.
  const API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const BATTERY = "8518750", KINGS_POINT = "8516945", HELL_GATE = "NYH1924";

  const SLACK_KNOTS = 0.5;        // it's slack while the current is slower than this (same as slack.py)
  const HALF_WINDOW = 6.5 * HOUR; // time shown on each side of the centered slack
  const REFRESH = 6 * MINUTE;
  const READING = 6 * MINUTE;     // NOAA reports the actual water this often
  const FRESH = 30 * MINUTE;       // a reading older than this is no longer shown as live
  const TREND = 18 * MINUTE;       // rising or falling compares readings this far apart, because neighbors can wobble
  const STEADY = 0.05;             // a change smaller than this, in feet, counts as steady
  const CHOOSE_LEAD = 12 * MINUTE; // the river chooses from a reading this long before slack begins
  const GET_READY = 5 * MINUTE;   // how early the page starts asking, so the image is ready when slack begins
  const TRIES = 10;               // places to try before giving up on an image
  const IMAGE_WAIT = 15e3;        // how long one image gets to load
  const ARRIVAL_PACE = 500;       // how long the arrival takes to draw one hour of river
  const FUTURE_FADE = 0.3;        // how faint the predicted water ahead of now is
  const SINK = 4e3;               // how long the image takes to sink back in (same as .sinking in style.css)

  const pad = n => String(n).padStart(2, "0");
  const noaaDate = ms => { const d = new Date(ms); return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()); };
  const noaaStamp = ms => { const d = new Date(ms); return noaaDate(ms) + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()); };
  const icsStamp = ms => { const d = new Date(ms); return noaaDate(ms) + "T" + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + "00Z"; };
  // We ask NOAA for GMT, so "2026-10-29 16:37" is read as UTC and shown in New York time.
  const parseTime = s => Date.parse(s.replace(" ", "T") + ":00Z");
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format;
  const clockSeconds = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", second: "2-digit" }).format;
  const nyHour = ms => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(ms));
  const nyDay = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format;
  const fmtFt = v => (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(1) + " ft";
  // fmtCount turns the time left into the countdown you see
  const fmtCount = ms => {
    const total = Math.ceil(ms / 1e3), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60;
    return (h ? h + ":" + pad(m) : m) + ":" + pad(total % 60);
  };

  async function fetchNoaa(params) {
    const url = new URL(API);
    const all = {
      application: "hellgate_art", time_zone: "gmt", units: "english", format: "json", interval: "6",
      begin_date: noaaDate(Date.now() - DAY), end_date: noaaDate(Date.now() + 2 * DAY), ...params
    };
    for (const k in all) url.searchParams.set(k, all[k]);
    const res = await fetch(url);
    if (!res.ok) throw new Error("NOAA answered " + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  // The water actually measured, oldest first, reaching back past the left edge of the chart. Empty if NOAA has nothing to give.
  async function recentLevels(station) {
    const now = Date.now();
    const data = await fetchNoaa({ product: "water_level", station, datum: "NAVD", begin_date: noaaStamp(now - 8 * HOUR), end_date: noaaStamp(now) }).catch(() => null);
    const readings = data && data.data ? data.data : [];
    return readings.filter(r => r.v !== "").map(r => ({ t: parseTime(r.t), v: parseFloat(r.v) }));
  }

  async function loadRiver() {
    const [bat, kp, cur, measuredBat, measuredKp] = await Promise.all([
      fetchNoaa({ product: "predictions", station: BATTERY, datum: "NAVD" }),
      fetchNoaa({ product: "predictions", station: KINGS_POINT, datum: "NAVD" }),
      fetchNoaa({ product: "currents_predictions", station: HELL_GATE }),
      recentLevels(BATTERY),
      recentLevels(KINGS_POINT)
    ]);
    const levels = d => d.predictions.map(p => ({ t: parseTime(p.t), v: parseFloat(p.v) }));
    const current = cur.current_predictions.cp.map(p => ({ t: parseTime(p.Time), v: p.Velocity_Major }));
    return { bat: levels(bat), kp: levels(kp), cur: current, slacks: findSlacks(current), measured: { bat: measuredBat, kp: measuredKp } };
  }

  // The current turns where it changes sign (flood is positive, ebb is negative, zero counts as not ebb).
  // Find a pair of readings that switches sides, then work out how far between them zero falls.
  // The last line, slacks.push(...), saves the time of the turn along with when slack begins and ends.
  // Working those out is slackEdge's job.
  function findSlacks(cur) {
    const slacks = [];
    for (let i = 1; i < cur.length; i++) {
      const a = cur[i - 1], b = cur[i];
      if ((a.v < 0) === (b.v < 0)) continue;
      const t = a.t + (b.t - a.t) * (a.v / (a.v - b.v));
      slacks.push({ t, begins: slackEdge(cur, i - 1, -1, t), ends: slackEdge(cur, i, 1, t) });
    }
    return slacks;
  }

  // slackEdge finds how long slack lasts, one direction at a time. It walks the 6 minute
  // readings away from the turn until the next one is over .5 knots, then works out
  // when between those two readings the current passed .5 and declares slack ended (or begun).
  function slackEdge(cur, i, step, turn) {
    if (Math.abs(cur[i].v) >= SLACK_KNOTS) return turn;
    while (cur[i + step] && Math.abs(cur[i + step].v) < SLACK_KNOTS) i += step;
    const a = cur[i], b = cur[i + step];
    if (!b) return a.t;
    const f = (SLACK_KNOTS - Math.abs(a.v)) / (Math.abs(b.v) - Math.abs(a.v));
    return a.t + (b.t - a.t) * f;
  }

  // valueAt is findSlacks flipped around. There, we knew the speeds and wanted a time.
  // Here, we know a time, like right now, and want the value at that moment.
  function valueAt(series, t) {
    const i = series.findIndex(p => p.t >= t);
    if (i < 0) return series[series.length - 1].v;
    if (i === 0) return series[0].v;
    const a = series[i - 1], b = series[i];
    return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
  }

  // below are the functions to create a seed that let's the river pick the Slack water image.
  function residual(observed, predicted) {
    return (observed - predicted).toFixed(3);
  }

  function riverText(battery, kingsPoint) {
    return `${battery},${kingsPoint}`
  }

  async function riverHash(text) {
    const bytes = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return new DataView(hash).getUint32(0);
  }

  function riverPlace(hashNumber, count) {
    return hashNumber % count;
  }

  // The newest reading, or null if it's too old to count as live.
  const freshest = (measured, now) => {
    const latest = measured.at(-1);
    return latest && now - latest.t <= FRESH ? latest : null;
  };

  // The line one side draws: the water as measured, then NOAA's prediction ahead.
  // Where the two meet there's a jump, and that jump is how far the river strayed from its prediction.
  function waterLine(predicted, measured, now) {
    const latest = freshest(measured, now);
    if (!latest) return predicted;
    return [...measured, ...predicted.filter(p => p.t > latest.t)];
  }

  // The slack the page points at: the next one that hasn't ended yet.
  const focusSlack = now => river.slacks.find(s => s.ends > now);

  const chart = document.getElementById("chart"), ctx = chart.getContext("2d");
  let chartW = 600, chartH = 300, C = {}, river = null;
  let arrival = null; // when the arrival started, while it's running
  let slacksHtml = ""; // the slack list as last written, so it's only rewritten when it changes

  function sizeChart() {
    const dpr = window.devicePixelRatio || 1;
    chartW = chart.parentElement.clientWidth - 24;
    chartH = chartW < 500 ? 240 : 320;
    chart.width = Math.round(chartW * dpr); chart.height = Math.round(chartH * dpr); chart.style.height = chartH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    for (const k of ["paper", "card", "ink", "muted", "rule", "harbor", "sound", "flow", "slack"]) C[k] = cs.getPropertyValue("--" + k).trim();
  }

  function label(text, x, y, font, color, align) {
    ctx.font = font; ctx.textAlign = align; ctx.textBaseline = "middle";
    ctx.lineWidth = 4; ctx.strokeStyle = C.card; ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function line(points, X, Y) {
    ctx.beginPath();
    points.forEach((p, i) => i ? ctx.lineTo(X(p.t), Y(p.v)) : ctx.moveTo(X(p.t), Y(p.v)));
  }

  // draw repaints the whole chart every second
  function draw() {
    if (!river) return;
    const now = Date.now(), slack = focusSlack(now);
    if (!slack) return; // ran past the data; the next refresh fetches more
    readColors();

    const t0 = slack.t - HALF_WINDOW, t1 = slack.t + HALF_WINDOW;
    // reach is how far the bright lines have got: now, or on the way there during the arrival
    const reach = arrival === null ? now : Math.min(now, t0 + (performance.now() - arrival) / ARRIVAL_PACE * HOUR);
    if (reach === now) arrival = null;
    const inWindow = s => s.filter(p => p.t >= t0 - 6 * MINUTE && p.t <= t1 + 6 * MINUTE);
    const batLine = waterLine(river.bat, river.measured.bat, now), kpLine = waterLine(river.kp, river.measured.kp, now);
    const bat = inWindow(batLine), kp = inWindow(kpLine);

    // Vertical scale: whole feet that hold both waves and zero
    const vals = [...bat, ...kp].map(p => p.v);
    const step = Math.max(...vals) - Math.min(...vals) > 8 ? 2 : 1;
    const hi = Math.ceil(Math.max(0, ...vals) / step) * step, lo = Math.floor(Math.min(0, ...vals) / step) * step;

    const W = chartW, H = chartH, L = 40, R = 10, Tp = 26, B = 26;
    const pw = W - L - R, ph = H - Tp - B;
    const X = t => L + (t - t0) / (t1 - t0) * pw;
    const Y = v => Tp + (hi - v) / (hi - lo) * ph;
    ctx.clearRect(0, 0, W, H);

    // Slack: a soft band for every slack in view, so the now line can be seen arriving at it
    ctx.fillStyle = C.slack; ctx.globalAlpha = 0.3;
    for (const s of river.slacks) {
      const from = Math.max(s.begins, t0), to = Math.min(s.ends, t1);
      if (from < to) ctx.fillRect(X(from), Tp, X(to) - X(from), ph);
    }
    ctx.globalAlpha = 1;

    // Grid and axes
    ctx.font = "11px 'IBM Plex Mono', ui-monospace, monospace";
    ctx.strokeStyle = C.rule; ctx.lineWidth = 1; ctx.fillStyle = C.muted;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let v = lo; v <= hi; v += step) {
      ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(W - R, Y(v)); ctx.stroke();
      ctx.fillText((v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v), L - 6, Y(v));
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let t = Math.ceil(t0 / HOUR) * HOUR; t <= t1; t += HOUR) {
      if (nyHour(t) % 2) continue;
      ctx.fillText(clock(t).replace(":00", "").replace(" ", "").toLowerCase(), X(t), H - B + 8);
    }

    // The two waves, faint all the way across, then bright up to reach, or to the newest reading if that's sooner
    ctx.lineWidth = 2.5; ctx.lineJoin = "round";
    const sides = [
      { points: bat, whole: batLine, color: C.harbor, dash: [], latest: freshest(river.measured.bat, now) },
      { points: kp, whole: kpLine, color: C.sound, dash: [9, 5], latest: freshest(river.measured.kp, now) }
    ];
    for (const side of sides) {
      side.end = side.latest ? Math.min(reach, side.latest.t) : reach;
      ctx.strokeStyle = side.color; ctx.setLineDash(side.dash);
      for (const [right, alpha] of [[W - R, FUTURE_FADE], [X(side.end), 1]]) {
        ctx.save();
        ctx.beginPath(); ctx.rect(L, 0, Math.max(0, right - L), H); ctx.clip();
        ctx.globalAlpha = alpha; line(side.points, X, Y); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.setLineDash([]);

    // Name each wave near the left edge, just above its line
    const tag = t0 + HALF_WINDOW * 0.18;
    const lf = "600 13px 'Public Sans', system-ui, sans-serif";
    label("The Battery", X(tag), Y(valueAt(batLine, tag)) - 14, lf, C.harbor, "left");
    label("Kings Point", X(tag), Y(valueAt(kpLine, tag)) - 14, lf, C.sound, "left");

    label("Slack water", X(slack.t), Tp - 12, "500 12px 'IBM Plex Mono', ui-monospace, monospace", C.ink, "center");

    // Now, or the moment the arrival has reached
    if (reach >= t0 && reach <= t1) {
      ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(X(reach), Tp); ctx.lineTo(X(reach), H - B); ctx.stroke(); ctx.setLineDash([]);
      for (const side of sides) {
        ctx.fillStyle = side.color; ctx.beginPath(); ctx.arc(X(side.end), Y(valueAt(side.whole, side.end)), 4.5, 0, Math.PI * 2); ctx.fill();
      }
      label(clockSeconds(reach) + " ET", X(reach), H - B - 10, "12px 'IBM Plex Mono', ui-monospace, monospace", C.ink, "center");
    }
  }

  // On arrival the last hours of river rush in up to now. Not near slack, where the image has the page.
  function startArrival() {
    const now = Date.now(), slack = focusSlack(now);
    if (!slack || now >= slack.begins - GET_READY || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    arrival = performance.now();
    const frame = () => { draw(); if (arrival !== null) requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }

  const el = id => document.getElementById(id);
  function updateReadout() {
    if (!river) return;
    const now = Date.now();
    for (const [key, side] of [["bat", "harbor side"], ["kp", "Sound side"]]) {
      const readings = river.measured[key], latest = freshest(readings, now);
      // A box that says measured never falls back to a prediction
      if (!latest) {
        el("v-" + key).textContent = "No reading";
        el("s-" + key).textContent = "no recent reading · " + side;
        continue;
      }
      el("v-" + key).textContent = fmtFt(latest.v);
      const earlier = readings.filter(r => r.t <= latest.t - TREND).at(-1);
      const change = earlier ? latest.v - earlier.v : 0;
      const trend = !earlier ? "" : Math.abs(change) < STEADY ? "steady · " : change > 0 ? "rising · " : "falling · ";
      el("s-" + key).textContent = trend + side;
    }
    const c = valueAt(river.cur, now), slack = focusSlack(now);
    el("v-cur").textContent = Math.abs(c).toFixed(1) + " knots";
    const state = Math.abs(c) < SLACK_KNOTS ? "slack" : c > 0 ? "flood" : "ebb";
    el("s-cur").textContent = state + (slack && state !== "slack" ? " · slack at " + clock(slack.begins) : "");
  }

  // One slack as a calendar event, in the .ics format. Times are written in UTC (the Z), and each calendar shows them in its own time zone.
  // The lines are kept in an array and joined with \r\n, the line ending the format asks for.
  function calendarText(slack) {
    return [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Hellegat//Remind Me//EN",
      "BEGIN:VEVENT",
      "UID:" + icsStamp(slack.begins) + "@hellegat.mariasaha.com",
      "DTSTAMP:" + icsStamp(Date.now()),
      "DTSTART:" + icsStamp(slack.begins),
      "DTEND:" + icsStamp(slack.ends),
      "SUMMARY:Hellegat Slack",
      "DESCRIPTION:RIVER REVEALS TREASURE SOON STOP DO NOT MISS CHANCE STOP MAY NEVER REVEAL AGAIN STOP GOTO https://hellegat.mariasaha.com STOP 73",
      "URL:https://hellegat.mariasaha.com",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Hellegat Slack",
      "TRIGGER:-PT5M",
      "END:VALARM",
      "END:VEVENT",
      "END:VCALENDAR"
    ].join("\r\n");
  }

  // The user can save a slack to their calendar. The ICS format is a simple text file, and the browser downloads it.
  function saveCalendarFile(name, text) {
    const blob = new Blob([text], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }

  // The countdown to the next edge of slack, and the list of today's slacks in New York time.
  function updateSlack() {
    if (!river) return;
    const now = Date.now(), slack = focusSlack(now);
    if (!slack) return;
    const begun = slack.begins <= now;
    el("slack-label").textContent = begun ? "Slack ends in" : "The river holds its breath in";
    el("slack-count").textContent = fmtCount((begun ? slack.ends : slack.begins) - now);
    if (begun) el("reveal-count").textContent = fmtCount(slack.ends - now);
    el("slack-when").textContent = begun ? "Until " + clock(slack.ends) : "The unseen surfaces, until the river exhales.";

    // The list shows the day of the next slack: today until the last one ends, then tomorrow.
    const day = nyDay(slack.t);
    el("slack-day").textContent = day === nyDay(now) ? "Today's slack" : "Tomorrow's slack";
    const shown = river.slacks.filter(s => nyDay(s.t) === day);
    // Past and current slacks are labeled; every future slack gets a button that remembers its own times.
    // The list is rebuilt every second but only written to the page when it changes, so a click on a button isn't lost mid-rebuild.
    const html = shown.map(s => {
      const state = s.ends <= now ? "past" : s !== slack ? "later" : begun ? "now" : "next";
      const label = state === "past" || state === "now" ? state
        : `<button type="button" data-begins="${s.begins}" data-ends="${s.ends}">remind me</button>`;
      return `<li class="${state}"><span>${clock(s.begins)} to ${clock(s.ends)}</span><span>${label}</span></li>`;
    }).join("");
    if (html !== slacksHtml) el("slacks").innerHTML = slacksHtml = html;
  }

  // What the water actually did at time t, or null if NOAA hasn't reported it yet.
  async function actualLevel(station, t) {
    const stamp = noaaStamp(t);
    const data = await fetchNoaa({ product: "water_level", station, datum: "NAVD", begin_date: stamp, end_date: stamp }).catch(() => null);
    const reading = data && data.data && data.data[0];
    return reading && reading.v !== "" ? parseFloat(reading.v) : null;
  }

  // The river's choice for a slack: a place in the list, or null while it hasn't reported.
  async function riverChoice(slack, count) {
    const t = Math.floor((slack.begins - CHOOSE_LEAD) / READING) * READING; // NOAA's reports lag, so this one is in before slack begins
    const [battery, kingsPoint] = await Promise.all([actualLevel(BATTERY, t), actualLevel(KINGS_POINT, t)]);
    if (battery === null || kingsPoint === null) return null;
    const text = riverText(residual(battery, valueAt(river.bat, t)), residual(kingsPoint, valueAt(river.kp, t)));
    return riverPlace(await riverHash(text), count);
  }

  const imageUrl = id => `https://images.nypl.org/index.php?id=${encodeURIComponent(id)}&t=w`;
  // The item's own page at NYPL, where the image lives with its description. Not the image file, which is imageUrl.
  const itemPage = uuid => `https://digitalcollections.nypl.org/items/${encodeURIComponent(uuid)}`;

  // Waits for an image to load, and gives up after IMAGE_WAIT so a slow link can't hang the reveal.
  function imageLoads(url) {
    return new Promise(resolve => {
      const img = new Image(), timer = setTimeout(() => resolve(false), IMAGE_WAIT);
      img.onload = () => { clearTimeout(timer); resolve(true); };
      img.onerror = () => { clearTimeout(timer); resolve(false); };
      img.src = url;
    });
  }

  // The river picks a position from 0 to one less than the number of images and the code works out which shelf holds it (position ÷ 2,000) and loads only that one file. Tries the river's place, then the places after it, up to TRIES, so a dead link can't loop forever.
  async function findImage(place, meta) {
    for (let i = 0; i < TRIES; i++) {
      const n = (place + i) % meta.count;
      const piece = await (await fetch(`data/${Math.floor(n / meta.shardSize)}.json`)).json();
      const [id, itemIndex] = piece.images[n % meta.shardSize];
      const url = imageUrl(id);
      if (await imageLoads(url)) return { url, item: piece.items[itemIndex] };
    }
    return null;
  }

  function showImage(found) {
    const [title, date, maker, uuid] = found.item;
    el("reveal-img").src = found.url;
    el("reveal-img").alt = title;
    // The title is a link to the item at NYPL. It opens in a new tab so the slack, and the image, stay here.
    el("reveal-link").textContent = title || "Untitled";
    el("reveal-link").href = itemPage(uuid);
    el("reveal-info").textContent = [date, maker].filter(Boolean).join(" · ");
    el("reveal-found").hidden = false;
    el("reveal").hidden = false;
  }

  // When slack ends the image sinks back in, and only then is it cleared.
  function hideReveal() {
    const box = el("reveal");
    if (box.hidden) return;
    box.classList.add("sinking");
    setTimeout(() => {
      box.hidden = true;
      box.classList.remove("sinking");
      el("reveal-found").hidden = true;
      el("reveal-missing").hidden = true;
      el("reveal-img").removeAttribute("src");
      el("reveal-link").removeAttribute("href");
    }, SINK);
  }

  // One attempt to get the image ready. If the river hasn't reported or the network fails, the next minute tries again.
  async function tryReveal(current, slack) {
    current.busy = true;
    try {
      const meta = await (await fetch("data/meta.json")).json();
      const place = await riverChoice(slack, meta.count);
      if (place === null) return;
      current.found = await findImage(place, meta);
      current.ready = true;
    } catch (err) {
      console.warn("Reveal will try again:", err.message);
    } finally {
      current.busy = false;
    }
  }

  // The image exists only while it's slack. Nothing is kept.
  let reveal = null;
  function updateReveal() {
    if (!river) return;
    const now = Date.now(), slack = focusSlack(now);
    if (!slack || now < slack.begins - GET_READY) {
      if (reveal) { reveal = null; hideReveal(); }
      return;
    }
    if (reveal && reveal.t !== slack.t) { reveal = null; hideReveal(); }
    if (!reveal) reveal = { t: slack.t, asked: 0, busy: false, ready: false, found: null, shown: false };
    if (reveal.ready) {
      if (reveal.shown || now < slack.begins) return;
      reveal.shown = true;
      if (reveal.found) showImage(reveal.found);
      else { el("reveal-missing").hidden = false; el("reveal").hidden = false; }
      return;
    }
    if (reveal.busy || now - reveal.asked < MINUTE) return;
    reveal.asked = now;
    tryReveal(reveal, slack);
  }

  function tick() { draw(); updateReadout(); updateSlack(); updateReveal(); }

  async function refresh() {
    try {
      const first = !river;
      river = await loadRiver();
      if (first) startArrival();
      el("updated").textContent = "Updated " + clock(Date.now()) + " · refreshes every 6 minutes";
      tick();
    } catch (err) {
      el("updated").textContent = "Couldn't reach NOAA (" + err.message + "). Trying again in 6 minutes.";
    }
  }

  // One listener on the slack list handles every remind me button. The buttons are replaced whenever the list changes,
  // but the list itself stays, and a click on a button bubbles up to it.
  const remind = slack => saveCalendarFile("hellegat-slack-" + nyDay(slack.begins) + ".ics", calendarText(slack));
  el("slacks").addEventListener("click", e => {
    const button = e.target.closest("button");
    if (!button) return;
    remind({ begins: Number(button.dataset.begins), ends: Number(button.dataset.ends) });
  });

  // The intro's reminder is for the next slack that hasn't begun, so during slack it skips ahead to the following one.
  el("remind-next").addEventListener("click", () => {
    const next = river && river.slacks.find(s => s.begins > Date.now());
    if (next) remind(next);
  });

  new ResizeObserver(sizeChart).observe(document.querySelector(".wrap"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
  refresh();
  setInterval(refresh, REFRESH);
  setInterval(tick, 1e3); // ticks the clock and keeps "now" moving between refreshes
})();
