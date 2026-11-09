"use strict";

/* News Signal Trader dashboard. Read-only views over the server's /api endpoints. */

const ROUTES = [
  { id: "overview", label: "Overview", icon: "layout-dashboard", sub: "The last session, the model's current read, and whether its calls are holding up" },
  { id: "ideas", label: "Trade ideas", icon: "crosshair", sub: "What the morning model suggests, with stops" + (window.TRADER_STATIC ? "" : " and position sizes") },
  { id: "themes", label: "Themes", icon: "layers", sub: "Where the news on each market theme is pointing" },
  { id: "headlines", label: "Headlines", icon: "newspaper", sub: "Every headline the model scored as market-relevant" },
  { id: "why", label: "Why it moved", icon: "search-check", sub: "Post-market recap: what moved, why, and how the morning calls held up" },
  { id: "track", label: "Track record", icon: "chart-no-axes-column", sub: "How past ideas have done against SPY, and which themes the model reads well" },
  { id: "paper", label: "Paper trading", icon: "flask-conical", sub: "Every morning idea traded by fixed rules on real prices, to see whether it makes money" },
];

const state = {
  meta: null, morning: null, recaps: [], recap: null, scorecard: [],
  track: null, trackError: null, trackLoading: false,
  paper: null, paperError: null, paperLoading: false,
  loading: true, error: null,
  sort: {}, ideaIdx: 0, themeKey: null,
  hq: "", minRel: 0.3, hTheme: "",
  run: { on: false, reachable: null, status: null, menu: false, phase: "idle", message: "" },
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $("#main");
let priceChart = null;
let chartSlots = [];

/* SVG charts are drawn at the slot's real width so text stays at its true size. */
function chartSlot(draw) {
  chartSlots.push(draw);
  return `<div class="svg-slot" data-slot="${chartSlots.length - 1}"></div>`;
}
function fillCharts() {
  document.querySelectorAll(".svg-slot").forEach((el) => {
    const draw = chartSlots[Number(el.dataset.slot)];
    if (draw) el.innerHTML = draw(Math.max(280, Math.floor(el.clientWidth)));
  });
}

/* ---------- Formatting ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeUrl(u) { return /^https?:\/\//i.test(u || "") ? u : null; }
function icon(name) { return ICONS[name] || ""; }
function signed(x, d = 2) { return x == null ? "–" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d); }
function pct(x, d = 2) { return x == null ? "–" : signed(x * 100, d) + "%"; }
function money(x, d = 2) { return x == null ? "–" : "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function tone(x) { return x > 0 ? "up" : x < 0 ? "down" : ""; }
function moveText(m) { return m.is_yield ? `${signed(m.ret * 100, 0)} bp` : pct(m.ret); }
function etTime(iso) {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
}
function sessionDate(ymd, long = false) {
  const d = new Date(ymd + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: long ? "long" : "short", month: long ? "long" : "short", day: "numeric", year: long ? "numeric" : undefined });
}
/* Idea return minus the same-direction bet on SPY (a short is compared with shorting SPY). */
function excess(r) { return r.return - (r.side === "SHORT" ? -r.spy_return : r.spy_return); }
function hoursSince(iso) { return (Date.now() - new Date(iso).getTime()) / 36e5; }
function themeName(k) { return state.meta?.axes[k]?.name || k; }
function friendly(text) {
  let t = String(text || "");
  for (const [k, v] of Object.entries(state.meta?.axes || {})) t = t.split(k).join(v.name);
  return t;
}
function sourceName(s) { return String(s || "").replace(/\s*\(via Google News\)$/, ""); }

/* ---------- Small components ---------- */

function confidence(level) {
  const shapes = {
    confirmed: '<circle cx="5" cy="5" r="4.2" fill="currentColor"/>',
    likely: '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M5 1a4 4 0 0 1 0 8z" fill="currentColor"/>',
    speculative: '<circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  };
  return `<span class="conf ${esc(level)}"><svg viewBox="0 0 10 10" aria-hidden="true">${shapes[level] || shapes.speculative}</svg>${esc(level)}</span>`;
}
/* "growth_labor -0.3" -> chip with the label and a signed, coloured value. */
function valueChip(text, nameFn = (x) => x) {
  const m = String(text).match(/^(.*?)\s*([+-]\d+(?:\.\d+)?)$/);
  if (!m) return `<span class="chip">${esc(nameFn(text))}</span>`;
  const v = parseFloat(m[2]);
  return `<span class="chip">${esc(nameFn(m[1]))} <b class="${tone(v)}">${signed(v, 1)}</b></span>`;
}
function sidePill(side) { return `<span class="pill ${side === "LONG" ? "long" : "short"}">${esc(side)}</span>`; }
function meter(v, max = 1) {
  if (v == null) return '<span class="muted">–</span>';
  const w = Math.max(0, Math.min(1, v / max)) * 100;
  return `<span class="meter"><span class="meter-track"><span class="meter-fill" style="width:${w}%"></span></span><span>${v.toFixed(2)}</span></span>`;
}
function importance(v) {
  const on = Math.round(v * 5);
  return `<span class="importance" title="Importance ${v.toFixed(1)}">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= on ? "on" : ""}"></i>`).join("")}</span>`;
}
function panel(title, body, { meta = "", more = "", cls = "", flush = false, note = "" } = {}) {
  return `<section class="panel ${cls}">
    <div class="panel-head"><h2>${title}</h2>${meta ? `<span class="meta">${meta}</span>` : ""}${more}</div>
    <div class="panel-body ${flush ? "flush" : ""}">${body}</div>
    ${note ? `<div class="panel-note">${note}</div>` : ""}
  </section>`;
}
function moreLink(route, label) { return `<a class="more" href="#/${route}">${esc(label)} ${icon("chevron-right").replace('class="icon"', 'class="icon" style="width:14px;height:14px"')}</a>`; }
function empty(title, text) { return `<div class="empty"><strong>${title}</strong><span>${text}</span></div>`; }
function skeleton(n = 5) { return `<div class="skeleton" aria-label="Loading">${"<i></i>".repeat(n)}</div>`; }

/* Sortable table. cols: {key, label, num, html(row), val(row), cls} */
function table(id, cols, rows, { rowAttrs = () => "", defaultSort = null, maxHeight = false } = {}) {
  const s = state.sort[id] || defaultSort;
  let data = rows.slice();
  if (s) {
    const col = cols.find((c) => c.key === s.key);
    if (col) {
      const v = col.val || ((r) => r[col.key]);
      data.sort((a, b) => {
        const x = v(a), y = v(b);
        if (x == null) return 1;
        if (y == null) return -1;
        return (x > y ? 1 : x < y ? -1 : 0) * (s.dir === "asc" ? 1 : -1);
      });
    }
  }
  const head = cols.map((c) => {
    const sorted = s && s.key === c.key ? (s.dir === "asc" ? "ascending" : "descending") : null;
    const label = c.sortable === false ? esc(c.label) : `<button type="button" data-sort="${id}:${c.key}">${esc(c.label)}</button>`;
    return `<th class="${c.num ? "num" : ""}" ${sorted ? `aria-sort="${sorted}"` : ""} scope="col">${label}</th>`;
  }).join("");
  const body = data.map((r) => `<tr ${rowAttrs(r)}>${cols.map((c) => `<td class="${c.num ? "num" : ""} ${c.cls || ""}">${c.html ? c.html(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("");
  return `<div class="table-wrap ${maxHeight ? "scroll-y" : ""}"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- Charts (SVG) ---------- */

/* Signature: morning call vs what moved prices, per theme, on the theme's -1..+1 scale. */
function callVsHappened(rc) {
  const run = rc?.morning?.run;
  if (!run) return empty("No morning call for this session", "The model didn't run between the previous close and this session's close, so there's nothing to grade.");
  const realized = Object.fromEntries((rc.analysis.axis_realized || []).map((a) => [a.axis, a]));
  const keys = Object.keys(state.meta.axes).filter((k) => realized[k] || Math.abs(run.axes[k] || 0) >= 0.1);
  if (!keys.length) return empty("Quiet on every theme", "The model made no strong theme calls and no theme clearly drove prices.");
  const legend = `<div class="chart-legend">
    <span><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>Morning call</span>
    <span><svg viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" style="fill:var(--up)"/></svg>What moved prices (bigger = more)</span>
    <span class="legend-note">Each theme's own −1 to +1 scale. Hover a row for what + and − mean.</span></div>`;
  const tally = {};
  for (const k of keys) { const v = verdictFor(run.axes[k] || 0, realized[k]).label; tally[v] = (tally[v] || 0) + 1; }
  const order = ["Called it", "Wrong way", "Missed", "Didn't matter"];
  const summary = `<div class="verdict-tally">${order.filter((v) => tally[v]).map((v) => `<span><b>${tally[v]}</b> ${v.toLowerCase()}</span>`).join("")}<span class="muted">Morning call made ${etTime(run.run_at)}</span></div>`;
  return legend + chartSlot((w) => callVsHappenedSvg(run, realized, keys, w)) + summary;
}
function verdictFor(call, r) {
  const mattered = r && r.strength >= 0.3;
  if (mattered && Math.abs(call) >= 0.1 && Math.abs(r.direction) >= 0.1) {
    return (call > 0) === (r.direction > 0) ? { label: "Called it", cls: "v-hit" } : { label: "Wrong way", cls: "v-miss" };
  }
  if (mattered) return { label: "Missed", cls: "v-missed" };
  return { label: "Didn't matter", cls: "v-quiet" };
}
/* Shorten at a word boundary, never ending on "&" or "/". */
function fitLabel(name, maxChars) {
  if (name.length <= maxChars) return name;
  const words = name.split(" ");
  let out = "";
  for (const w of words) { if ((out + " " + w).trim().length > maxChars - 1) break; out = (out + " " + w).trim(); }
  out = out.replace(/\s*[&/,]$/, "");
  return (out || name.slice(0, maxChars - 1)) + "…";
}
function callVsHappenedSvg(run, realized, keys, W) {
  const rows = keys.map((k) => {
    const call = run.axes[k] || 0, r = realized[k], v = verdictFor(call, r);
    return { k, call, r, verdict: v.label, vcls: v.cls, order: (r ? r.strength : 0) * 10 + Math.abs(call) };
  }).sort((a, b) => b.order - a.order);

  const longest = Math.max(...rows.map((r) => state.meta.axes[r.k].name.length));
  const L = Math.min(Math.round(W * 0.38), Math.round(longest * 6.7 + 20)), R = W < 440 ? 70 : 92;
  const maxChars = Math.floor((L - 20) / 6.7), rowH = 30, top = 24, H = top + rows.length * rowH + 8;
  const x = (v) => L + ((v + 1) / 2) * (W - L - R);
  const ticks = [-1, -0.5, 0, 0.5, 1].map((t) => `
    <line class="${t === 0 ? "zero" : "grid-line"}" x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${H - 4}"/>
    <text x="${x(t)}" y="${top - 10}" text-anchor="middle">${t === 0 ? "0" : signed(t, 1)}</text>`).join("");
  const body = rows.map((row, i) => {
    const y = top + i * rowH + rowH / 2;
    const a = state.meta.axes[row.k];
    const cx = x(row.call);
    const rx = row.r ? x(row.r.direction) : null;
    const rr = row.r ? 3 + row.r.strength * 4 : 0;
    const tip = `${a.name}. Morning call ${signed(row.call)}` + (row.r ? `; moved prices ${signed(row.r.direction, 1)} (strength ${row.r.strength.toFixed(1)}). ${row.r.note}` : "; didn't clearly move prices.") + ` +1 = ${a.plus}; −1 = ${a.minus}.`;
    return `<g class="row-hit"><title>${esc(tip)}</title>
      <rect class="hover-bg" x="0" y="${y - rowH / 2}" width="${W}" height="${rowH}" rx="3"/>
      <text class="lbl" x="${L - 12}" y="${y + 4}" text-anchor="end">${esc(fitLabel(a.name, maxChars))}</text>
      ${rx != null ? `<line class="link" x1="${cx}" x2="${rx}" y1="${y}" y2="${y}"/>` : ""}
      <circle class="call" cx="${cx}" cy="${y}" r="5"/>
      ${rx != null ? `<circle class="${row.r.direction >= 0 ? "real-pos" : "real-neg"}" cx="${rx}" cy="${y}" r="${rr}"/>` : ""}
      <text class="verdict ${row.vcls}" x="${W - 4}" y="${y + 4}" text-anchor="end">${row.verdict}</text>
    </g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Morning theme calls compared with what moved prices">${ticks}${body}</svg>`;
}

function returnBars(rows) { return chartSlot((w) => returnBarsSvg(rows, w)); }
function returnBarsSvg(rows, W) {
  const rowH = 26, top = 22, H = top + rows.length * rowH + 6;
  const narrow = W < 480, L = narrow ? 96 : Math.min(190, Math.round(W * 0.32)), R = 64;   // narrow: no date in the label
  const vals = rows.map((r) => r.return);
  // Round tick step (1%, 2%, 2.5%, 5%, 10%, ...) so two steps cover the biggest move.
  const need = Math.max(0.01, ...vals.map(Math.abs)) / 2;
  const tick = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1].find((s) => s >= need) || 1;
  const lim = tick * 2;
  const x = (v) => L + ((v + lim) / (2 * lim)) * (W - L - R);
  const grid = [-lim, -tick, 0, tick, lim].map((v) => `<line class="${v === 0 ? "zero" : "grid-line"}" x1="${x(v)}" x2="${x(v)}" y1="${top - 6}" y2="${H - 2}"/><text x="${x(v)}" y="${top - 10}" text-anchor="middle">${pct(v, tick < 0.01 ? 1 : 0)}</text>`).join("");
  const bars = rows.map((r, i) => {
    const y = top + i * rowH + rowH / 2, v = r.return;
    const x0 = Math.min(x(0), x(v)), w = Math.max(1.5, Math.abs(x(v) - x(0)));
    const label = `${r.side === "LONG" ? "Long" : "Short"} ${r.ticker}`;
    return `<g><title>${esc(`${label} · ${etTime(r.made_at)} · ${pct(v)}` + (r.spy_return != null ? ` (SPY ${pct(r.spy_return)})` : ""))}</title>
      <text class="lbl" x="${L - 12}" y="${y + 4}" text-anchor="end">${esc(label)}${narrow ? "" : ` <tspan class="muted-svg">${esc(new Date(r.made_at).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }))}</tspan>`}</text>
      <rect class="${v >= 0 ? "bar-pos" : "bar-neg"}" x="${x0}" y="${y - 7}" width="${w}" height="14" rx="2"/>
      <text class="lbl" x="${v >= 0 ? x(v) + 6 : x(v) - 6}" y="${y + 4}" text-anchor="${v >= 0 ? "start" : "end"}">${pct(v)}</text></g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Return per idea">${grid}${bars}</svg>`;
}

/* Cross-asset tiles: colour strength = how unusual the move was (|z| up to 3). */
const SHORT_LABELS = {
  "IWM": "Russell 2000", "^TNX": "10Y yield", "TLT": "Long Treasuries", "UUP": "Dollar", "^VIX": "VIX",
  "XLY": "Consumer disc.", "XLP": "Staples", "XLC": "Comm. services", "XLV": "Health care", "CL=F": "Crude oil",
};
function tiles(tickers, moves) {
  // Dark theme: deep tiles carry white text. Light theme: tiles stay lighter and keep dark text.
  const light = document.documentElement.dataset.theme === "light";
  return tickers.filter((t) => moves[t]).map((t) => {
    const m = moves[t];
    const k = Math.round(Math.min(Math.abs(m.z) / 3, 1) * (light ? 52 : 72));
    const label = SHORT_LABELS[t] || m.label || t;
    const strongAt = light ? 999 : 40;
    return `<div class="tile ${m.z < 0 ? "neg" : ""} ${k > strongAt ? "strong" : ""}" style="--k:${k}" title="${esc(`${m.label || t} (${t}): ${moveText(m)}, ${signed(m.z, 1)}× a normal day`)}">
      <span class="t-label">${esc(label)}</span>
      <span class="t-move">${moveText(m)}</span>
      <span class="t-z">${signed(m.z, 1)}σ · ${esc(t)}</span></div>`;
  }).join("");
}
function tileLegend() {
  const top = document.documentElement.dataset.theme === "light" ? 52 : 72;
  const steps = [top, top * 0.66, top * 0.33, 0, top * 0.33, top * 0.66, top].map((k, i) => `<i style="background:color-mix(in oklab, var(${i < 3 ? "--down" : "--up"}) ${k}%, var(--panel-2))"></i>`).join("");
  return `<div class="legend"><span>Colour = how unusual the move was for that asset</span><span class="legend-ramp">${steps}</span><span>−3σ … normal … +3σ</span></div>`;
}

function drawPriceChart(el, ticker, rec) {
  if (priceChart) { priceChart.remove(); priceChart = null; }
  getJSON(`/api/history/${encodeURIComponent(ticker)}`).then((data) => {
    if (!el.isConnected) return;
    if (!data.length) { el.innerHTML = empty("No price history", "Yahoo returned nothing for this ticker."); return; }
    const css = getComputedStyle(document.documentElement);
    const c = (n) => css.getPropertyValue(n).trim();
    // The chart lives in an absolutely positioned layer so its size can't feed back into the box's height.
    el.innerHTML = '<div class="price-chart-host"></div>';
    priceChart = LightweightCharts.createChart(el.firstChild, {
      autoSize: true,
      layout: { background: { type: "solid", color: "transparent" }, textColor: c("--text-3"), fontFamily: c("--font"), fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: c("--line") }, horzLines: { color: c("--line") } },
      rightPriceScale: { borderColor: c("--line-2") },
      timeScale: { borderColor: c("--line-2") },
      crosshair: { mode: 1 },
    });
    const up = c("--up");
    const series = priceChart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: up, lineWidth: 2, topColor: up + "40", bottomColor: up + "00", priceLineVisible: false,
      // Always keep the entry, stop and target lines in view, even when price never reached them.
      autoscaleInfoProvider: (base) => {
        const r = base();
        if (!r) return r;
        const lines = [rec.price, rec.stop, rec.stock_play?.target].filter((x) => x != null);
        return { ...r, priceRange: {
          minValue: Math.min(r.priceRange.minValue, ...lines),
          maxValue: Math.max(r.priceRange.maxValue, ...lines),
        } };
      },
    });
    series.setData(data);
    series.createPriceLine({ price: rec.price, color: c("--text-3"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Entry" });
    series.createPriceLine({ price: rec.stop, color: c("--down"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Stop" });
    if (rec.stock_play) series.createPriceLine({ price: rec.stock_play.target, color: c("--up"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Target" });
    priceChart.timeScale().fitContent();
  }).catch(() => { el.innerHTML = empty("Couldn't load prices", "The price service didn't respond. Try again in a minute."); });
}

/* ---------- Pages ---------- */

/* The strategist writes "1) ... 2) ... 3) ...". Show each point as its own item, lead sentence first. */
function summaryList(text) {
  if (!text) return `<p class="prose muted">The strategist review didn't run, so there's no written summary. Ideas are ranked by model score.</p>`;
  const parts = text.split(/(?:^|\s)\d\)\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return `<p class="prose">${esc(text)}</p>`;
  return `<ol class="summary-list">${parts.map((p) => {
    const cut = p.search(/[.:]\s/);
    const lead = cut > 0 ? p.slice(0, cut + 1) : p, rest = cut > 0 ? p.slice(cut + 2) : "";
    return `<li><b>${esc(lead)}</b> ${esc(rest)}</li>`;
  }).join("")}</ol>`;
}

function rejectedStrip(m) {
  const v = m.review?.vetoed || [];
  if (!v.length) return "";
  return `<div class="rejected"><span class="muted small">Considered and rejected by the strategist</span>
    <div>${v.map((x) => `<span class="chip" title="${esc(x.reason)}">${esc(x.ticker)}</span>`).join("")}</div></div>`;
}

function noMorning() {
  return empty("No morning run yet", "Run <code>python main.py run</code> (or use the Streamlit app) to generate theme scores and trade ideas.");
}
function noRecap() {
  return empty("No post-market recap yet", "After the close, run <code>python main.py recap</code>. It works out why the market moved and grades the morning's calls.");
}

function pageOverview() {
  const m = state.morning, rc = state.recap;
  // One row: the market's core gauges, then the session's most unusual sectors and mega caps.
  let tapeTickers = [];
  if (rc) {
    const core = ["SPY", "QQQ", "DIA", "IWM", "^TNX", "UUP", "^VIX", "CL=F", "GC=F", "BTC-USD"];
    const rest = state.meta.watchlist.map((w) => w.ticker)
      .filter((t) => !core.includes(t) && t !== "TLT" && rc.moves[t])
      .sort((a, b) => Math.abs(rc.moves[b].z) - Math.abs(rc.moves[a].z))
      .slice(0, 12 - core.filter((t) => rc.moves[t]).length);   // always 12 tiles, even when one gauge has no data
    tapeTickers = core.concat(rest);
  }
  const tapePanel = panel(rc ? `Last session · ${sessionDate(rc.trade_date)}` : "Last session",
    rc ? `<div class="tape tape-row">${tiles(tapeTickers, rc.moves)}</div><div style="margin-top:10px">${tileLegend()}</div>` : noRecap(),
    { more: rc ? moreLink("why", "Every asset") : "" });

  const why = rc ? panel("Why it moved", `
      <div class="detail-head" style="margin-bottom:8px"><span class="pill ${esc(rc.analysis.regime)}">${esc(rc.analysis.regime)}</span><span class="muted small">${sessionDate(rc.trade_date, true)}</span></div>
      <p class="lede">${esc(rc.analysis.headline)}</p>
      <ul class="driver-list" style="margin-top:12px">${rc.analysis.drivers.slice(0, 3).map((d) => `
        <li><span class="d-title">${esc(d.driver)}</span><span class="d-meta">${confidence(d.confidence)}${importance(d.importance)}</span></li>`).join("")}</ul>`,
    { more: moreLink("why", "Full recap") }) : panel("Why it moved", noRecap());

  let read = panel("Model read", noMorning());
  if (m) {
    const active = Object.entries(m.axes).filter(([, v]) => v.heat > 0);
    const strongest = active.sort((a, b) => Math.abs(b[1].score) - Math.abs(a[1].score))[0];
    const longs = m.recs.filter((r) => r.side === "LONG").length;
    read = panel("Model read", `
      ${summaryList(m.review?.market_summary)}
      <dl class="kv" style="margin-top:14px">
        <dt>Run</dt><dd>${etTime(m.run_at)}</dd>
        <dt>Headlines analyzed</dt><dd>${m.n_articles}</dd>
        <dt>Trade ideas</dt><dd>${m.recs.length} <span class="muted">(${longs} long, ${m.recs.length - longs} short)</span></dd>
        ${strongest ? `<dt>Strongest theme</dt><dd>${esc(themeName(strongest[0]))} <span class="${tone(strongest[1].score)}">${signed(strongest[1].score)}</span></dd>` : ""}
      </dl>`, { more: moreLink("themes", "All themes") });
  }

  const calls = panel("Called vs happened", rc ? callVsHappened(rc) : noRecap(), { flush: true, cls: "fill", meta: rc ? sessionDate(rc.trade_date) : "" });

  const ideas = panel("Trade ideas", m ? (m.recs.length ? `<ul class="idea-list">${m.recs.map((r, i) => `
      <li><button type="button" class="idea-card" data-idea="${i}">
        <span class="idea-top">${sidePill(r.side)}<span class="ticker">${esc(r.ticker)}</span>
          <span class="muted small">${esc(r.horizon || "")}</span>
          <span class="idea-conv" title="Conviction from the strategist review">${r.conviction != null ? `Conviction <b>${r.conviction.toFixed(2)}</b>` : ""}</span></span>
        <span class="idea-nums small"><span>Entry <b>${money(r.price)}</b></span><span>Stop <b>${money(r.stop)}</b></span>${r.stock_play ? `<span>Target <b>${money(r.stock_play.target)}</b></span>` : ""}<span>5-day <b class="${tone(r.ret_5d)}">${pct(r.ret_5d, 1)}</b></span></span>
        ${r.stock_play ? `<span class="idea-play small"><b>${esc(r.stock_play.action)}</b>${r.options_play?.name ? `<span class="muted"> or </span>${esc(r.options_play.name)}` : ""}</span>` : ""}
        <span class="idea-thesis">${esc(r.thesis || r.rationale)}</span>
      </button></li>`).join("")}</ul>${rejectedStrip(m)}`
    : empty("No trade ideas", "No signal was strong enough last run. No trade beats a weak one.")) : noMorning(),
  { flush: true, more: m ? moreLink("ideas", "Details") : "" });

  return `<div class="page stack">
    ${tapePanel}
    <div class="grid cols-2">${why}${calls}</div>
    <div class="grid cols-2">${read}${ideas}</div>
    ${trackSummaryPanel()}
  </div>`;
}

function trackSummaryPanel() {
  if (state.trackError) return panel("Track record", `<div class="empty error">${esc(state.trackError)}</div>`);
  if (!state.track) return panel("Track record", skeleton(4), { meta: "Checking current prices…" });
  const t = state.track;
  if (!t.length) return panel("Track record", empty("Nothing to grade yet", "Ideas are logged every run. Check back after a few sessions."));
  const wins = t.filter((r) => r.return > 0).length;
  const avg = t.reduce((s, r) => s + r.return, 0) / t.length;
  const graded = t.filter((r) => r.spy_return != null);
  const edge = graded.length ? graded.reduce((s, r) => s + excess(r), 0) / graded.length : null;
  return panel("Track record", `
    <dl class="stat-row">
      <div class="stat"><dt>Ideas graded</dt><dd>${t.length}</dd></div>
      <div class="stat"><dt>Win rate</dt><dd>${Math.round((wins / t.length) * 100)}%<small>${wins} of ${t.length}</small></dd></div>
      <div class="stat"><dt>Average return</dt><dd class="${tone(avg)}">${pct(avg)}</dd></div>
      <div class="stat" title="Each idea's return minus the same long or short bet on SPY over the same period"><dt>vs same bet on SPY</dt><dd class="${tone(edge)}">${pct(edge)}</dd></div>
    </dl>
    <div style="padding:12px 16px 4px">${returnBars(t.slice(-30))}</div>`,
  { flush: true, more: moreLink("track", "All ideas"), note: t.length < 20 ? "Too few ideas to judge yet. Beating SPY over many weeks is the bar that matters." : "" });
}

function pageIdeas() {
  const m = state.morning;
  if (!m) return `<div class="page">${panel("Trade ideas", noMorning())}</div>`;
  if (!m.recs.length) return `<div class="page">${panel("Trade ideas", empty("No trade ideas this run", "No signal was strong enough. That's a valid answer."))}</div>`;
  state.ideaIdx = Math.min(state.ideaIdx, m.recs.length - 1);
  const r = m.recs[state.ideaIdx];
  const sized = r.shares != null && m.account_size != null;
  const list = panel("Ideas", table("ideas", [
    { key: "side", label: "Side", html: (x) => sidePill(x.side) },
    { key: "ticker", label: "Ticker", html: (x) => `<span class="ticker">${esc(x.ticker)}</span>` },
    { key: "price", label: "Entry", num: true, html: (x) => money(x.price) },
    { key: "stop", label: "Stop", num: true, html: (x) => money(x.stop) },
    ...(sized ? [
      { key: "shares", label: "Shares", num: true },
      { key: "pos", label: "Position", num: true, val: (x) => x.shares * x.price, html: (x) => money(x.shares * x.price, 0) },
    ] : []),
    { key: "conviction", label: "Conviction", html: (x) => meter(x.conviction) },
    { key: "score", label: "Model score", num: true, html: (x) => `<span class="${tone(x.score)}">${signed(x.score)}</span>` },
    { key: "horizon", label: "Horizon", html: (x) => esc(x.horizon || "–") },
    { key: "ret_5d", label: "5-day move", num: true, html: (x) => `<span class="${tone(x.ret_5d)}">${pct(x.ret_5d, 1)}</span>` },
  ], m.recs, { rowAttrs: (x) => `class="selectable ${x === r ? "selected" : ""}" data-idea="${m.recs.indexOf(x)}" tabindex="0" aria-selected="${x === r}"` }),
  { flush: true, meta: `${etTime(m.run_at)}`, note: (sized ? `Sized for a ${money(m.account_size, 0)} account risking ${(m.risk_per_trade * 100).toFixed(2).replace(/\.?0+$/, "")}% per trade. ` : "")
    + "Stop = 2× the average daily range. Click a row for details." });

  const chart = panel(`<span class="detail-head">${sidePill(r.side)}<span>${esc(r.ticker)}</span></span>`,
    `<div class="price-chart" id="price-chart">${skeleton(6)}</div>`, { meta: "Last 6 months · entry, stop and target marked", cls: "fill" });
  const detail = panel("Why this trade", `
    <p class="section-label">Thesis</p><p class="prose">${esc(r.thesis || r.rationale)}</p>
    ${r.key_risk ? `<p class="section-label">What would prove it wrong</p><p class="prose">${esc(r.key_risk)}</p>` : ""}
    <p class="section-label">What drove the signal</p>
    <ul class="bullets">${r.drivers.map((d) => `<li>${esc(friendly(d))}</li>`).join("")}</ul>
    <dl class="kv" style="margin-top:14px">
      <dt>Entry · stop</dt><dd>${money(r.price)} · ${money(r.stop)} <span class="muted">(${pct(Math.abs(r.stop / r.price - 1), 1).replace("+", "")} away)</span></dd>
      ${sized ? `<dt>Size</dt><dd>${r.shares} shares · ${money(r.shares * r.price, 0)}</dd>
      <dt>Risk if stopped</dt><dd>${money(Math.abs(r.stop - r.price) * r.shares, 0)}</dd>` : ""}
      <dt>Horizon</dt><dd>${esc(r.horizon || "–")}</dd>
    </dl>`);

  const vetoed = m.review?.vetoed?.length ? panel("Rejected by the strategist review", table("vetoed", [
    { key: "ticker", label: "Ticker", html: (v) => `<span class="ticker">${esc(v.ticker)}</span>` },
    { key: "reason", label: "Why it was rejected", cls: "wrap", sortable: false },
  ], m.review.vetoed), { flush: true }) : "";

  return `<div class="page stack">${list}${playsPanel(r, m)}<div class="grid cols-3-2">${chart}${detail}</div>${vetoed}</div>`;
}

function shortDate(iso) {
  return new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function playsPanel(r, m) {
  const sp = r.stock_play, op = r.options_play;
  const title = `How to trade ${esc(r.ticker)}`;
  if (!sp) return panel(title, empty("No plays for this run", "Ideas get stock and options plays from the next run on."));
  const sized = r.shares != null && m.account_size != null;
  const budget = sized ? m.account_size * m.risk_per_trade : null;
  const pctOf = (x) => (x * 100).toFixed(0) + "%";

  const stock = `<section class="play" aria-label="Stock play">
      <p class="section-label">Stock</p>
      <p class="play-action">${esc(sp.action)} <span class="muted small">limit order</span></p>
      <dl class="kv">
        <dt>Last price</dt><dd>${money(sp.last)}</dd>
        <dt>Stop</dt><dd>${money(sp.stop)} <span class="muted">(${pct(Math.abs(sp.stop / sp.last - 1), 1).replace("+", "")} away)</span></dd>
        <dt>Target</dt><dd>${money(sp.target)} <span class="muted">(${pct(Math.abs(sp.target / sp.last - 1), 1).replace("+", "")} away)</span></dd>
        <dt>Reward : risk</dt><dd>${sp.reward_risk} : 1</dd>
        ${sized ? `<dt>Shares</dt><dd>${r.shares} <span class="muted">(${money(r.shares * sp.last, 0)})</span></dd>` : ""}
      </dl>
      <p class="small play-note">${esc(sp.exit)}</p>
      <p class="muted small">${esc(sp.chase_note)}</p>
    </section>`;

  let options;
  if (!op) options = "";
  else if (op.none) options = `<section class="play" aria-label="Options play"><p class="section-label">Options</p><p class="muted">${esc(op.none)}</p></section>`;
  else {
    const maxGain = op.max_gain_per_contract != null ? `${money(op.max_gain_per_contract, 0)} per contract`
      : (r.side === "LONG" ? `Unlimited above ${money(op.breakeven)}` : `Grows as ${esc(r.ticker)} falls below ${money(op.breakeven)}`);
    const contracts = !sized || op.contracts == null ? ""
      : op.contracts ? `<dt>Contracts</dt><dd>${op.contracts} <span class="muted">(${money(op.total_cost, 0)} at risk)</span></dd>`
      : `<dt>Contracts</dt><dd class="down-text">None fit. 1 contract risks ${money(op.cost_per_contract, 0)}, ${pctOf(op.cost_per_contract / m.account_size)} of the account vs your ${money(budget, 0)} budget.</dd>`;
    options = `<section class="play" aria-label="Options play">
      <p class="section-label">Options</p>
      <p class="play-action">${esc(op.action)}</p>
      <dl class="kv">
        <dt>Cost = max loss</dt><dd>${money(op.cost_per_contract, 0)} per contract</dd>
        <dt>Max gain</dt><dd>${maxGain}</dd>
        <dt>Breakeven at expiry</dt><dd>${money(op.breakeven)}</dd>
        <dt>If it hits the target</dt><dd class="${tone(op.gain_at_target)}">${op.gain_at_target >= 0 ? "+" : "−"}${money(Math.abs(op.gain_at_target), 0)} per contract</dd>
        <dt>Expires</dt><dd>${shortDate(op.expiry)} <span class="muted">(${op.dte} days) · exit by ${shortDate(op.exit_by)}</span></dd>
        <dt>Implied vol</dt><dd>${pctOf(op.iv)}${op.hv != null ? ` <span class="muted">vs ${pctOf(op.hv)} actual</span>` : ""}</dd>
        ${contracts}
      </dl>
      <table class="legs"><thead><tr><th>Leg</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Delta</th><th class="num">Open int.</th></tr></thead><tbody>
        ${op.legs.map((l) => `<tr><td>${l.action === "BUY" ? "Buy" : "Sell"} $${l.strike} ${l.kind}</td><td class="num">${money(l.bid)}</td><td class="num">${money(l.ask)}</td><td class="num">${l.delta.toFixed(2)}</td><td class="num">${l.open_interest.toLocaleString("en-US")}</td></tr>`).join("")}
      </tbody></table>
      ${op.why ? `<p class="muted small">${esc(op.why)}</p>` : ""}
      <p class="small play-note">${esc(op.exit)}</p>
    </section>`;
  }
  return panel(title, `<div class="play-grid">${stock}${options}</div>`, {
    flush: true,
    meta: op?.quoted_at ? `Option quotes ${etTime(op.quoted_at)}` : "",
    note: "Prices are Yahoo quotes, about 15 minutes delayed (before the open, they're the previous close). Check the live bid and ask, and use limit orders.",
  });
}

function pageThemes() {
  const m = state.morning;
  if (!m) return `<div class="page">${panel("Themes", noMorning())}</div>`;
  const entries = Object.entries(m.axes).sort((a, b) => b[1].heat - a[1].heat);
  if (!state.themeKey || !m.axes[state.themeKey]) state.themeKey = entries[0][0];
  const k = state.themeKey, v = m.axes[k], a = state.meta.axes[k];
  const reading = v.score > 0.05 ? a.plus : v.score < -0.05 ? a.minus : "neutral";
  const rows = entries.map(([key, val]) => {
    const w = Math.min(Math.abs(val.score), 1) * 50;
    return `<button type="button" class="tbar ${val.heat > 0 ? "" : "quiet"}" data-axis="${key}" aria-pressed="${key === k}">
      <span>${esc(themeName(key))}</span>
      <span class="tbar-track"><span class="tbar-fill ${val.score >= 0 ? "pos" : "neg"}" style="width:${w}%"></span></span>
      <span class="num ${tone(val.score)}">${val.heat > 0 ? signed(val.score) : "–"}</span>
      <span class="num">${val.heat > 0 ? val.heat.toFixed(2) : "–"}</span></button>`;
  }).join("");
  const list = panel("Theme scores", `
    <div class="tbar tbar-head" aria-hidden="true"><span>Theme</span><span style="display:flex;justify-content:space-between"><span>−1</span><span>0</span><span>+1</span></span><span class="num">Score</span><span class="num">Volume</span></div>
    <div class="tbars">${rows}</div>`,
  { flush: true, meta: etTime(m.run_at), note: "Score = net direction of the news on that theme. Volume = how much news, weighted by source quality, recency and surprise. Pick a theme for its headlines." });

  const detail = panel(esc(a.name), `
    <dl class="kv">
      <dt>Score</dt><dd class="${tone(v.score)}">${v.heat > 0 ? signed(v.score) : "no news"}</dd>
      <dt>Reading</dt><dd>${esc(reading)}</dd>
      <dt>+1 means</dt><dd>${esc(a.plus)}</dd>
      <dt>−1 means</dt><dd>${esc(a.minus)}</dd>
    </dl>
    <p class="section-label" style="margin-top:16px">Headlines driving it</p>
    ${v.drivers.length ? `<ul class="driver-list">${v.drivers.map((d) => `<li>
      <span class="d-title">${safeUrl(d.link) ? `<a href="${esc(d.link)}" target="_blank" rel="noopener noreferrer">${esc(d.title)}</a>` : esc(d.title)}</span>
      <span class="d-meta"><span class="${tone(d.direction)}">${signed(d.direction, 1)}</span><span class="muted small">${esc(sourceName(d.source))}</span></span>
      <span class="d-evidence">${esc(d.why)}</span></li>`).join("")}</ul>` : empty("No headlines", "Nothing touched this theme in the last 48 hours.")}`);
  return `<div class="page grid cols-2">${list}${detail}</div>`;
}

function pageHeadlines() {
  const m = state.morning;
  if (!m) return `<div class="page">${panel("Headlines", noMorning())}</div>`;
  const all = m.headlines || [];
  const q = state.hq.trim().toLowerCase();
  const themeLabel = state.hTheme ? themeName(state.hTheme) : "";
  const rows = all.filter((h) => h.relevance >= state.minRel
    && (!q || `${h.title} ${h.axes} ${h.tickers} ${h.why} ${h.source}`.toLowerCase().includes(q))
    && (!state.hTheme || h.axes.includes(state.hTheme)));
  const themeOpts = Object.entries(state.meta.axes).map(([k, a]) => `<option value="${k}" ${k === state.hTheme ? "selected" : ""}>${esc(a.name)}</option>`).join("");
  const relOpts = [0, 0.3, 0.5, 0.7].map((v) => `<option value="${v}" ${v === state.minRel ? "selected" : ""}>${v === 0 ? "Any relevance" : `Relevance ≥ ${v}`}</option>`).join("");
  const toolbar = `<div class="toolbar">
    <label class="search">${icon("search")}<span class="visually-hidden">Search headlines</span>
      <input class="input" id="hq" type="search" placeholder="Search headlines, tickers, sources" value="${esc(state.hq)}"></label>
    <label class="field"><span class="visually-hidden">Theme</span><select class="select" id="htheme"><option value="">All themes</option>${themeOpts}</select></label>
    <label class="field"><span class="visually-hidden">Minimum relevance</span><select class="select" id="hrel">${relOpts}</select></label>
    <span class="count">${rows.length} of ${all.length}</span></div>`;
  const tbl = rows.length ? table("headlines", [
    { key: "relevance", label: "Relevance", html: (h) => meter(h.relevance) },
    { key: "title", label: "Headline", cls: "title", html: (h) => (safeUrl(h.link) ? `<a href="${esc(h.link)}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>` : esc(h.title))
      + `<div class="muted small">${esc(sourceName(h.source))}</div>` },
    { key: "axes", label: "Themes", sortable: false, html: (h) => h.axes ? h.axes.split(", ").map((s) => valueChip(s, friendly)).join("") : '<span class="muted">–</span>' },
    { key: "tickers", label: "Tickers", sortable: false, html: (h) => h.tickers ? h.tickers.split(", ").map((s) => valueChip(s)).join("") : '<span class="muted">–</span>' },
    { key: "why", label: "Why it matters", cls: "wrap", sortable: false },
    { key: "published", label: "Published", html: (h) => `<span class="nowrap small muted">${etTime(h.published)}</span>` },
  ], rows, { defaultSort: { key: "relevance", dir: "desc" }, maxHeight: true })
    : empty("No headlines match", `Nothing matches${q ? ` “${esc(state.hq)}”` : ""}${themeLabel ? ` in ${esc(themeLabel)}` : ""} at this relevance. Loosen the filters.`);
  return `<div class="page">${panel("Scored headlines", toolbar + tbl, { flush: true, meta: `From the run at ${etTime(m.run_at)}` })}</div>`;
}

function pageWhy() {
  const rc = state.recap;
  if (!rc) return `<div class="page">${panel("Why it moved", noRecap())}</div>`;
  const a = rc.analysis, moves = rc.moves;
  const picker = state.recaps.length > 1 ? `<label class="field">Session <select class="select" id="recap-pick">${state.recaps.map((r) => `<option value="${r.trade_date}" ${r.trade_date === rc.trade_date ? "selected" : ""}>${sessionDate(r.trade_date)}</option>`).join("")}</select></label>` : "";

  const summary = panel("Summary", `
    ${rc.partial ? `<div class="callout" style="margin-bottom:12px">${icon("circle-alert")}<span>Written before the close, so the numbers are intraday. Re-run after 4:15pm ET for the final read.</span></div>` : ""}
    <div class="detail-head" style="margin-bottom:8px"><span class="pill ${esc(a.regime)}">${esc(a.regime)}</span><span class="muted small">${sessionDate(rc.trade_date, true)} · ${rc.n_headlines} headlines${rc.used_web ? " + web research" : ""} · written ${etTime(rc.created_at)}</span></div>
    <p class="lede">${esc(a.headline)}</p>
    <div class="prose" style="margin-top:12px">${a.narrative.split(/\n\s*\n/).map((p) => `<p>${esc(p)}</p>`).join("")}</div>`,
  { more: picker });

  const drivers = panel("Main drivers", `<ul class="driver-list">${a.drivers.map((d) => `<li>
      <span class="d-title">${esc(d.driver)}</span>
      <span class="d-meta">${confidence(d.confidence)}${importance(d.importance)}<span class="chip">${esc(themeName(d.theme).replace(/_/g, " "))}</span></span>
      <span class="d-evidence">${esc(d.evidence)}</span>
      <span>${d.assets.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</span></li>`).join("")}</ul>`,
  { note: "Confirmed = a dated report from the session states the cause. Likely = timing and other markets fit. Speculative = plausible, unproven." });

  const groups = [...new Set(state.meta.watchlist.map((w) => w.group))];
  const heat = panel("How unusual was each move?", groups.map((g) => `<div class="tape-group"><h3>${esc(g)}</h3><div class="tape">${tiles(state.meta.watchlist.filter((w) => w.group === g).map((w) => w.ticker), moves)}</div></div>`).join("") + `<div style="margin-top:12px">${tileLegend()}</div>`,
    { meta: "Move ÷ the asset's normal daily move (σ = standard deviations)" });

  const movers = panel("Big movers explained", table("movers", [
    { key: "ticker", label: "Ticker", html: (x) => `<span class="ticker">${esc(x.ticker)}</span>` },
    { key: "move", label: "Move", num: true, val: (x) => moves[x.ticker]?.ret, html: (x) => moves[x.ticker] ? `<span class="${tone(moves[x.ticker].ret)}">${moveText(moves[x.ticker])}</span>` : "–" },
    { key: "z", label: "vs normal", num: true, val: (x) => moves[x.ticker] ? Math.abs(moves[x.ticker].z) : null, html: (x) => moves[x.ticker] ? `${signed(moves[x.ticker].z, 1)}σ` : "–" },
    { key: "cause", label: "Cause", html: (x) => esc(x.cause.replace(/_/g, " ")) },
    { key: "confidence", label: "Confidence", html: (x) => confidence(x.confidence) },
    { key: "explanation", label: "Why", cls: "wrap", sortable: false },
  ], a.movers), { flush: true });

  const unexplained = a.unexplained.length ? panel("Moves without a clear explanation", `<ul class="bullets">${a.unexplained.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>`) : "";
  const cross = panel("Across markets", `<p class="prose">${esc(a.cross_asset_read)}</p>`);

  const g = a.model_grade;
  const ideas = rc.morning.ideas;
  const grade = panel("How the morning model did", `
    <div style="padding:14px 16px;border-bottom:1px solid var(--line)"><p class="prose">${esc(friendly(g.summary))}</p></div>
    <div class="grade-cols">
      <div><h3><span class="up">Got right</span></h3><ul>${(g.got_right.length ? g.got_right : ["Nothing"]).map((x) => `<li>${esc(friendly(x))}</li>`).join("")}</ul></div>
      <div><h3><span class="down">Got wrong</span></h3><ul>${(g.got_wrong.length ? g.got_wrong : ["Nothing"]).map((x) => `<li>${esc(friendly(x))}</li>`).join("")}</ul></div>
      <div><h3><span style="color:var(--amber-text)">Missed</span></h3><ul>${(g.missed.length ? g.missed : ["Nothing"]).map((x) => `<li>${esc(friendly(x))}</li>`).join("")}</ul></div>
    </div>
    ${ideas.length ? `<div style="border-top:1px solid var(--line)">${table("graded", [
      { key: "idea", label: "Idea", val: (i) => i.ticker, html: (i) => `${sidePill(i.side)} <span class="ticker">${esc(i.ticker)}</span>` },
      { key: "day_return", label: "That session", num: true, html: (i) => `<span class="${tone(i.day_return)}">${pct(i.day_return)}</span>` },
      { key: "vs_spy", label: "vs same bet on SPY", num: true, html: (i) => `<span class="${tone(i.vs_spy)}">${pct(i.vs_spy)}</span>` },
      { key: "thesis", label: "Thesis", cls: "wrap", sortable: false },
    ], ideas)}</div>` : ""}`, { flush: true });

  const calls = panel("Called vs happened", callVsHappened(rc), { flush: true });
  const lessons = panel("Lessons for the model", `<ul class="bullets">${a.lessons.map((x) => `<li>${esc(friendly(x))}</li>`).join("")}</ul>`);
  const watch = panel("Watch next session", `<ul class="bullets">${a.watch_next.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`);

  return `<div class="page stack">
    <div class="grid cols-2"><div class="stack">${summary}${cross}</div>${drivers}</div>
    ${heat}
    ${movers}
    ${unexplained}
    ${grade}
    <div class="grid cols-3-2">${calls}<div class="stack">${lessons}${watch}</div></div>
  </div>`;
}

function pageTrack() {
  const scorecard = panel("Theme scorecard", state.scorecard.length ? table("scorecard", [
    { key: "axis", label: "Theme", val: (r) => themeName(r.axis), html: (r) => esc(themeName(r.axis)) },
    { key: "days_mattered", label: "Days it moved markets", num: true },
    { key: "called", label: "Days the model had a call", num: true },
    { key: "hits", label: "Called right", num: true },
    { key: "hit_rate", label: "Hit rate", num: true, html: (r) => r.hit_rate == null ? '<span class="muted">–</span>' : `${Math.round(r.hit_rate * 100)}%` },
  ], state.scorecard, { defaultSort: { key: "days_mattered", dir: "desc" } })
    : empty("No recaps yet", "Each post-market recap adds a day to this table."),
  { flush: true, note: `Built from ${state.recaps.length} recap${state.recaps.length === 1 ? "" : "s"}. A hit = the morning score pointed the same way the theme pushed prices. Needs a few weeks before it means much.` });

  let ideas;
  if (state.trackError) ideas = panel("Every idea", `<div class="empty error">${esc(state.trackError)}</div>`);
  else if (!state.track) ideas = panel("Every idea", skeleton(8), { meta: "Checking current prices…" });
  else if (!state.track.length) ideas = panel("Every idea", empty("Nothing to grade yet", "Ideas are logged every run."));
  else ideas = panel("Every idea", table("track", [
    { key: "made_at", label: "Made", html: (r) => `<span class="nowrap">${etTime(r.made_at)}</span>` },
    { key: "side", label: "Side", html: (r) => sidePill(r.side) },
    { key: "ticker", label: "Ticker", html: (r) => `<span class="ticker">${esc(r.ticker)}</span>` },
    { key: "entry", label: "Entry", num: true, html: (r) => money(r.entry) },
    { key: "now", label: "Now", num: true, html: (r) => money(r.now) },
    { key: "stop", label: "Stop", num: true, html: (r) => money(r.stop) },
    { key: "return", label: "Return", num: true, html: (r) => `<span class="${tone(r.return)}">${pct(r.return)}</span>` },
    { key: "spy_return", label: "SPY same period", num: true, html: (r) => `<span class="${tone(r.spy_return)}">${pct(r.spy_return)}</span>` },
    { key: "excess", label: "vs same bet on SPY", num: true, val: (r) => r.spy_return == null ? null : excess(r), html: (r) => r.spy_return == null ? "–" : `<span class="${tone(excess(r))}">${pct(excess(r))}</span>` },
    { key: "past_stop", label: "Status", html: (r) => r.past_stop ? '<span class="pill short">Past stop</span>' : '<span class="muted small">Open</span>' },
  ], state.track, { defaultSort: { key: "made_at", dir: "desc" }, maxHeight: true }),
  { flush: true, note: "Returns run from the recommended price to now, flipped for shorts. Very recent ideas will show near zero." });

  return `<div class="page stack">${trackSummaryPanel()}${ideas}${scorecard}</div>`;
}

function rText(x) { return x == null ? "–" : `${signed(x)}R`; }

function curveSvg(points, W) {
  const H = 200, L = 52, R = 16, top = 14, bottom = 26;
  const pts = [{ date: null, r: 0 }, ...points];
  const vals = pts.map((p) => p.r);
  const need = Math.max(1, ...vals.map(Math.abs));
  const tick = [0.5, 1, 2, 2.5, 5, 10, 20, 25, 50].find((s) => s * 2 >= need) || 50;
  const lo = Math.min(0, ...vals) < 0 ? -tick * Math.ceil(-Math.min(...vals) / tick) : 0;
  const hi = Math.max(tick, tick * Math.ceil(Math.max(...vals) / tick));
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v) => top + ((hi - v) / (hi - lo)) * (H - top - bottom);
  const grid = [];
  for (let v = lo; v <= hi + 1e-9; v += tick) {
    grid.push(`<line class="${Math.abs(v) < 1e-9 ? "zero" : "grid-line"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${Math.abs(v) < 1e-9 ? "0R" : signed(v, Number.isInteger(v) ? 0 : 1) + "R"}</text>`);
  }
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const dots = points.map((p, i) => `<circle class="${p.r >= (pts[i].r) ? "dot-pos" : "dot-neg"}" cx="${x(i + 1)}" cy="${y(p.r)}" r="3"><title>${esc(`${shortDate(p.date)}: ${p.side === "LONG" ? "Long" : "Short"} ${p.ticker} closed · total ${rText(p.r)}`)}</title></circle>`).join("");
  const dateLbl = (i, anchor) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}">${shortDate(pts[i].date)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Cumulative result of closed paper trades, in R">
    ${grid.join("")}<polyline class="curve ${last.r >= 0 ? "pos" : "neg"}" points="${line}"/>${dots}
    ${dateLbl(1, "start")}${pts.length > 2 ? dateLbl(pts.length - 1, "end") : ""}</svg>`;
}

function optionCell(t) {
  const o = t.option;
  if (!t.option_name) return '<span class="muted">–</span>';
  if (o?.skipped) return `<span class="muted">${esc(t.option_name)} · skipped</span>`;
  if (o?.ret == null) return `<span class="muted">${esc(t.option_name)}</span>`;
  return `${esc(t.option_name)} <span class="${tone(o.ret)}">${pct(o.ret, 0)}</span>`;
}

function statusPill(t) {
  const label = { pending: "Waiting for the open", open: "Open", closed: "Closed", skipped: "Skipped" }[t.status] || t.status;
  return `<span class="status ${esc(t.status)}">${label}</span>`;
}

function pagePaper() {
  if (state.paperError) return `<div class="page">${panel("Paper trading", `<div class="empty error">${esc(state.paperError)}</div>`)}</div>`;
  if (!state.paper) return `<div class="page">${panel("Paper trading", skeleton(8), { meta: "Checking current prices…" })}</div>`;
  const p = state.paper, s = p.stats, c = p.counts;
  const local = p.account_size != null;
  if (!p.trades.length) return `<div class="page">${panel("Paper trading", empty("No paper trades yet", "The next morning run adds its ideas here."))}</div>`;
  const wins = s.filled ? Math.round(s.win_rate * s.filled) : 0;
  const bt = p.backtest;
  const stats = `<dl class="stat-row">
      <div class="stat"><dt>Closed trades</dt><dd>${c.closed}<small>${c.skipped} skipped</small></dd></div>
      <div class="stat"><dt>Win rate</dt><dd>${s.filled ? Math.round(s.win_rate * 100) + "%" : "–"}${s.filled ? `<small>${wins} of ${s.filled}</small>` : ""}</dd></div>
      <div class="stat" title="R = the amount risked on a trade (entry to stop). +1R means it made what it risked."><dt>Average per trade</dt><dd class="${tone(s.avg_r)}">${rText(s.avg_r)}</dd></div>
      ${local
        ? `<div class="stat"><dt>Closed P&amp;L</dt><dd class="${tone(s.pnl)}">${s.filled ? (s.pnl >= 0 ? "+" : "−") + money(Math.abs(s.pnl), 0) : "–"}${s.filled ? `<small>${pct(s.pnl / p.account_size, 1)} of account</small>` : ""}</dd></div>`
        : `<div class="stat"><dt>Total</dt><dd class="${tone(s.total_r)}">${rText(s.total_r)}</dd></div>`}
    </dl>`;
  const notes = [
    `Started ${shortDate(p.started)}. ${c.open} open (${rText(p.open_r)} so far)${c.pending ? `, ${c.pending} waiting for the open` : ""}.`,
    bt ? `Backtest for comparison (${shortDate(bt.start)}–${shortDate(bt.end)}): ${bt.trades} trades, ${Math.round(bt.win_rate * 100)}% win rate, ${rText(bt.avg_r)} per trade.` : "",
    s.filled < 30 ? "Needs about 30+ closed trades before the numbers mean much." : "",
  ].filter(Boolean).join(" ");
  const summary = panel("Paper account", stats, { flush: true, note: notes });

  const curve = panel("Cumulative result", p.curve.length
    ? chartSlot((w) => curveSvg(p.curve, w))
    : empty("Starts when the first trade closes", "Each closed trade adds its result in R."),
  { meta: p.curve.length ? `${p.curve.length} closed` : "" });

  const live = p.trades.filter((t) => t.status === "open" || t.status === "pending");
  const done = p.trades.filter((t) => t.status === "closed" || t.status === "skipped");
  const open = panel("Open and waiting", live.length ? table("paper-open", [
    { key: "trade_day", label: "Entered", html: (t) => `<span class="nowrap">${shortDate(t.session || t.trade_day)}</span>` },
    { key: "side", label: "Side", html: (t) => sidePill(t.side) },
    { key: "ticker", label: "Ticker", html: (t) => `<span class="ticker">${esc(t.ticker)}</span>` },
    { key: "status", label: "Status", html: statusPill },
    { key: "entry", label: "Entry", num: true, html: (t) => t.entry == null ? `<span class="muted">limit ${money(t.limit)}</span>` : money(t.entry) },
    { key: "exit", label: "Now", num: true, html: (t) => money(t.exit) },
    { key: "stop", label: "Stop", num: true, html: (t) => money(t.stop) },
    { key: "target", label: "Target", num: true, html: (t) => money(t.target) },
    { key: "r", label: "So far", num: true, html: (t) => `<span class="${tone(t.r)}">${rText(t.r)}</span>` },
    { key: "ret", label: "Return", num: true, html: (t) => `<span class="${tone(t.ret)}">${pct(t.ret)}</span>` },
    { key: "option_name", label: "Options play", sortable: false, html: optionCell },
  ], live, { defaultSort: { key: "trade_day", dir: "desc" } }) : empty("Nothing open", "New ideas are added after each morning run."),
  { flush: true });

  const reasons = { stop: "Stopped out", target: "Hit target", time: "Time's up" };
  const closed = panel("Closed and skipped", done.length ? table("paper-closed", [
    { key: "trade_day", label: "Entered", html: (t) => `<span class="nowrap">${shortDate(t.session || t.trade_day)}</span>` },
    { key: "side", label: "Side", html: (t) => sidePill(t.side) },
    { key: "ticker", label: "Ticker", html: (t) => `<span class="ticker">${esc(t.ticker)}</span>` },
    { key: "reason", label: "Outcome", html: (t) => t.status === "skipped" ? `<span class="muted">Skipped: ${esc(t.skip || "")}</span>` : esc(reasons[t.reason] || t.reason || "") },
    { key: "entry", label: "Entry", num: true, html: (t) => money(t.entry) },
    { key: "exit", label: "Exit", num: true, html: (t) => money(t.exit) },
    { key: "days_held", label: "Days", num: true, html: (t) => t.days_held ?? "–" },
    { key: "r", label: "Result", num: true, html: (t) => `<span class="${tone(t.r)}">${rText(t.r)}</span>` },
    { key: "ret", label: "Return", num: true, html: (t) => `<span class="${tone(t.ret)}">${pct(t.ret)}</span>` },
    { key: "spy", label: "vs SPY same bet", num: true, val: (t) => t.ret == null || t.spy_same_side == null ? null : t.ret - t.spy_same_side, html: (t) => t.ret == null || t.spy_same_side == null ? "–" : `<span class="${tone(t.ret - t.spy_same_side)}">${pct(t.ret - t.spy_same_side)}</span>` },
    { key: "option_name", label: "Options play", sortable: false, html: optionCell },
  ], done, { defaultSort: { key: "trade_day", dir: "desc" }, maxHeight: true }) : empty("Nothing closed yet", "Trades close at their stop, their target, or the end of their holding period."),
  { flush: true, note: "Rules: limit entry on the first session after the idea (skipped if it opens past the limit), exit at the stop, the target or the close after the holding period, 0.05% cost each way. Options are approximate: bought at the quoted price, valued at each contract's daily close." });

  return `<div class="page stack"><div class="grid cols-3-2">${summary}${curve}</div>${open}${closed}</div>`;
}

const PAGES = { overview: pageOverview, ideas: pageIdeas, themes: pageThemes, headlines: pageHeadlines, why: pageWhy, track: pageTrack, paper: pagePaper };

/* ---------- Shell ---------- */

function currentRoute() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
  return ROUTES.find((r) => r.id === id) || ROUTES[0];
}

function renderNav(route) {
  const badges = { ideas: state.morning?.recs.length, headlines: state.morning?.headlines?.length, paper: state.paper?.counts.open };
  $("#nav").innerHTML = ROUTES.map((r) => `<li><a href="#/${r.id}" ${r.id === route.id ? 'aria-current="page"' : ""}>${icon(r.icon)}<span>${r.label}</span>${badges[r.id] ? `<span class="badge">${badges[r.id]}</span>` : ""}</a></li>`).join("");
}

function renderFreshness() {
  const m = state.morning, rc = state.recap;
  const chip = (label, iso, staleH) => {
    if (!iso) return `<span class="fresh"><span class="dot"></span>${label} <b>none yet</b></span>`;
    const stale = hoursSince(iso) > staleH;
    return `<span class="fresh" title="${stale ? "Older than " + staleH + " hours" : "Recent"}"><span class="dot ${stale ? "stale" : "ok"}"></span>${label} <b>${etTime(iso)}</b></span>`;
  };
  $("#freshness").innerHTML = chip("Model run", m?.run_at, 24) + chip("Recap", rc?.created_at, 30)
    + `<button class="icon-btn${state.reloading ? " spinning" : ""}" id="reload" type="button" title="Reload data" aria-label="Reload data"${state.reloading ? " disabled" : ""}>${icon("refresh-cw")}</button>`
    + runControl();
}

/* ---------- Run button ----------
   Starts a run on this PC through the local dashboard server (server.py), which starts the
   same Windows scheduled task the timetable uses. The published site only shows the button
   after visiting it once with ?runner=on, so other visitors never see it. */

const RUNNER = window.TRADER_STATIC ? "http://127.0.0.1:8600" : "";
const RUN_MODES = {
  morning: { label: "Morning analysis", desc: "Read the news, suggest trades · about 5 min" },
  recap: { label: "Post-market recap", desc: "Explain why the market moved · 5 to 10 min" },
};

function runnerWanted() {
  if (!window.TRADER_STATIC) return true;
  const q = new URLSearchParams(location.search).get("runner");
  try {
    if (q === "on" || q === "off") localStorage.setItem("runner", q);
    return localStorage.getItem("runner") === "on";
  } catch (e) { return q === "on"; }
}

async function runnerFetch(method, body) {
  const r = await fetch(RUNNER + "/api/runner", {
    method, cache: "no-store", targetAddressSpace: "loopback",
    headers: body ? { "Content-Type": "application/json", "X-Trader-Run": "1" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `The server returned ${r.status}`);
  return data;
}

function runControl() {
  const run = state.run;
  if (!run.on) return "";
  const s = run.status;
  if (run.phase === "running" || run.phase === "publishing") {
    const what = RUN_MODES[s?.mode]?.label || "Run";
    const step = run.phase === "publishing" ? "Updating the public site..." : (s?.progress || "Starting...");
    return `<span class="run-status" role="status">${icon("loader-circle").replace('class="icon"', 'class="icon spin"')}<b>${what}</b><span>${esc(step)}</span></span>`;
  }
  const note = run.phase === "done" ? `<span class="run-status ok" role="status">${icon("check")}<span>${esc(run.message)}</span></span>`
    : run.phase === "failed" ? `<span class="run-status bad" role="status" title="${esc(run.message)}">${icon("circle-x")}<span>${esc(run.message)}</span></span>` : "";
  if (run.reachable === null) {
    return note + `<button class="run-btn" type="button" disabled title="Connecting to this PC. If Chrome asks to access devices on your local network, click Allow.">${icon("loader-circle").replace('class="icon"', 'class="icon spin"')}<span>Connecting...</span></button>`;
  }
  if (run.reachable === false) {
    return note + `<button class="run-btn" type="button" disabled title="Can't reach the dashboard server on this PC. Run start_web.bat, then reload.">${icon("play")}<span>Run analysis</span></button>`;
  }
  const menu = run.menu ? `<div class="run-menu" role="menu">${Object.entries(RUN_MODES).map(([k, m]) =>
    `<button type="button" role="menuitem" data-run="${k}"><b>${m.label}</b><span>${m.desc}</span></button>`).join("")}</div>` : "";
  return note + `<div class="run-wrap"><button class="run-btn" id="run-btn" type="button" aria-haspopup="menu" aria-expanded="${run.menu}">${icon("play")}<span>Run analysis</span>${icon("chevron-down")}</button>${menu}</div>`;
}

function setRun(patch) { Object.assign(state.run, patch); renderFreshness(); }

let runTimer = null;
async function pollRunner() {
  clearTimeout(runTimer);
  try {
    const s = await runnerFetch("GET");
    const was = state.run.phase;
    setRun({ reachable: true, status: s });
    if (s.running) {
      setRun({ phase: "running" });
      runTimer = setTimeout(pollRunner, 4000);
    } else if (was === "running") {
      finishRun(s);
    }
  } catch (e) {
    setRun({ reachable: false });
    if (state.run.phase === "running") runTimer = setTimeout(pollRunner, 8000);
  }
}

async function finishRun(s) {
  if (!s.ok) {
    setRun({ phase: "failed", message: "Run failed. See reports/logs on this PC." + (s.error ? " " + s.error : "") });
    return;
  }
  if (s.note) { setRun({ phase: "done", message: s.note }); return; }
  if (window.TRADER_STATIC) {
    // The run pushed new data to GitHub; wait for GitHub Pages to serve it.
    setRun({ phase: "publishing" });
    const deadline = Date.now() + 10 * 60e3;
    while (Date.now() < deadline) {
      try {
        const meta = await fetch("data/meta.json", { cache: "no-store" }).then((r) => r.json());
        if (meta.published_at && meta.published_at > s.started_at) break;
      } catch (e) { /* keep waiting */ }
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  await loadAll();
  setRun({ phase: "done", message: `${RUN_MODES[s.mode]?.label || "Run"} finished` });
  setTimeout(() => { if (state.run.phase === "done") setRun({ phase: "idle" }); }, 15000);
}

async function startRun(mode) {
  setRun({ menu: false, phase: "running", status: { mode, progress: "Starting..." } });
  try {
    const s = await runnerFetch("POST", { mode });
    setRun({ status: s });
    runTimer = setTimeout(pollRunner, 3000);
  } catch (e) {
    setRun({ phase: "failed", message: "Couldn't start: " + e.message });
  }
}

function renderThemeToggle() {
  const dark = document.documentElement.dataset.theme === "dark";
  $("#theme-toggle").innerHTML = `${icon(dark ? "sun" : "moon")}<span>${dark ? "Light theme" : "Dark theme"}</span>`;
}

function render() {
  const route = currentRoute();
  renderNav(route);
  renderFreshness();
  $("#page-title").textContent = route.label;
  $("#page-sub").textContent = route.sub;
  document.title = `${route.label} · News Signal Trader`;
  if (priceChart) { priceChart.remove(); priceChart = null; }
  if (state.loading) { main.innerHTML = `<div class="page grid cols-2">${panel("Loading", skeleton(6))}${panel("Loading", skeleton(6))}</div>`; return; }
  if (state.error) { main.innerHTML = panel("Couldn't load data", `<div class="empty"><strong class="error">${esc(state.error)}</strong><span>${window.TRADER_STATIC ? "The data files didn't load. Try reloading in a minute." : "Is the server running? Start it with <code>python server.py</code>, then reload."}</span></div>`); return; }
  chartSlots = [];
  main.innerHTML = PAGES[route.id]() + `<p class="page-foot">${esc(state.meta.disclaimer)}${state.meta.published_at ? ` Published ${etTime(state.meta.published_at)}.` : ""}</p>`;
  fillCharts();
  const chartEl = $("#price-chart");
  if (chartEl && state.morning?.recs.length) drawPriceChart(chartEl, state.morning.recs[state.ideaIdx].ticker, state.morning.recs[state.ideaIdx]);
}

/* ---------- Data ---------- */

/* Live mode reads the local API. The published site (window.TRADER_STATIC) reads JSON files instead. */
function apiUrl(path) {
  if (!window.TRADER_STATIC) return path;
  const p = path.replace(/^\/api\//, "");
  return `data/${p}.json`;
}
async function getJSON(url) {
  const r = await fetch(apiUrl(url), { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

async function loadAll() {
  state.loading = !state.meta;
  state.reloading = true;
  render();
  try {
    const [meta, morning, recaps, scorecard] = await Promise.all([
      getJSON("/api/meta"), getJSON("/api/morning"), getJSON("/api/recaps"), getJSON("/api/scorecard")]);
    Object.assign(state, { meta, morning, recaps, scorecard, error: null });
    const want = state.recap?.trade_date && recaps.some((r) => r.trade_date === state.recap.trade_date) ? state.recap.trade_date : recaps[0]?.trade_date;
    state.recap = want ? await getJSON(`/api/recaps/${want}`) : null;
  } catch (e) {
    state.error = e.message;
  }
  state.loading = false;
  state.reloading = false;
  render();
  loadTrack();
  loadPaper();
}

async function loadPaper() {
  if (state.paperLoading) return;
  state.paperLoading = true;
  state.paperError = null;
  try { state.paper = await getJSON("/api/paper"); }
  catch (e) { state.paperError = "Couldn't load paper trades: " + e.message; }
  state.paperLoading = false;
  render();
}

async function loadTrack() {
  if (state.trackLoading) return;
  state.trackLoading = true;
  state.track = null; state.trackError = null;
  try { state.track = await getJSON("/api/track-record"); }
  catch (e) { state.trackError = "Couldn't check current prices: " + e.message; }
  state.trackLoading = false;
  const id = currentRoute().id;
  if (id === "overview" || id === "track") render();
}

/* ---------- Events ---------- */

document.addEventListener("click", (e) => {
  const sortBtn = e.target.closest("[data-sort]");
  if (sortBtn) {
    const [id, key] = sortBtn.dataset.sort.split(":");
    const cur = state.sort[id];
    state.sort[id] = { key, dir: cur && cur.key === key && cur.dir === "desc" ? "asc" : "desc" };
    render();
    return;
  }
  const idea = e.target.closest("[data-idea]");
  if (idea && !e.target.closest("a")) {
    state.ideaIdx = Number(idea.dataset.idea);
    if (currentRoute().id !== "ideas") location.hash = "#/ideas"; else render();
    return;
  }
  const th = e.target.closest("[data-axis]");
  if (th) { state.themeKey = th.dataset.axis; render(); return; }
  const runItem = e.target.closest("[data-run]");
  if (runItem) { startRun(runItem.dataset.run); return; }
  if (e.target.closest("#run-btn")) { setRun({ menu: !state.run.menu }); $(".run-menu button")?.focus(); return; }
  if (state.run.menu && !e.target.closest(".run-menu")) setRun({ menu: false });
  if (e.target.closest("#reload")) {
    loadAll();
    return;
  }
  if (e.target.closest("#theme-toggle")) {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (err) { /* private mode */ }
    renderThemeToggle();
    render();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.run.menu) { setRun({ menu: false }); $("#run-btn")?.focus(); return; }
  const row = e.target.closest?.("tr[data-idea]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); row.click(); }
});

let searchTimer;
document.addEventListener("input", (e) => {
  if (e.target.id === "hq") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.hq = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const box = $("#hq"); box.focus(); box.setSelectionRange(pos, pos);
    }, 150);
  }
});

document.addEventListener("change", async (e) => {
  if (e.target.id === "hrel") { state.minRel = Number(e.target.value); render(); $("#hrel").focus(); }
  if (e.target.id === "htheme") { state.hTheme = e.target.value; render(); $("#htheme").focus(); }
  if (e.target.id === "recap-pick") {
    try { state.recap = await getJSON(`/api/recaps/${e.target.value}`); } catch (err) { state.error = err.message; }
    render();
  }
});

let resizeTimer;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fillCharts, 120); });

window.addEventListener("hashchange",() => { render(); window.scrollTo(0, 0); main.focus({ preventScroll: true }); });

renderThemeToggle();
loadAll();
if (runnerWanted()) { state.run.on = true; pollRunner(); }
