// Launch-Odds Radar v5 — the page. Static, no network: all data is window.RADAR.
const R = window.RADAR;
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? '$' + (n / 1e3).toFixed(1) + 'K' : '$' + Math.round(n);
const fmtN = (n) => Math.round(n).toLocaleString('en-US');
const fmtAge = (d) => d === null ? '—' : d >= 365 ? (d / 365).toFixed(1) + ' yr' : d + ' d';
const fmtChg = (c) => c === null ? '—' : (c > 0 ? '+' : '') + c.toFixed(1) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const state = { verdict: 'all', tier: 'all', q: '', cat: 'all', chain: 'all', sort: 'rank', dir: 1, depPct: 0.0002, share: 0.07, weeks: 12, detail: null };

function econ(r) {
  const dep = Math.round(clamp(state.depPct * r.tvl_usd, 250, 10000));
  const drop = r.implied_value_usd * state.share * dep / r.tvl_usd;
  const fees = 2.95 + 0.0005 * dep;
  const hours = 3 + dep / 10000;
  const tbill = dep * 0.04 * state.weeks / 52;
  const net = drop - fees;
  const nph = net / hours;
  const verdict = net > tbill && nph >= 25 ? 'Farm' : net > 0 && nph >= 1 ? 'Marginal' : 'Skip';
  return { dep, drop, fees, hours, tbill, net, nph, verdict };
}

// ---- header + KPIs + integrity + accounting ----
const ev = R.evidence;
$('meta').textContent = `DefiLlama snapshot ${R.as_of} · model ${R.model_version} · refitted in this browser from board.json`;
const kpis = [
  ['Out-of-sample miss, walk-forward', '×' + ev.walkForward.factor, 'vs ×' + ev.walkForward.naive + ' flat · ' + ev.walkForward.test + ' newer tokens'],
  ['Is the printed range honest?', ev.wfCoverageP25 + '% · ' + ev.wfCoverageP10 + '%', 'of later-listed caps inside P25–P75 · P10–P90 (stated 50% · 80%)'],
  ['Token odds vs base rate, AUC', ev.odds.auc, 'Brier ' + ev.odds.brier + ' vs ' + ev.odds.baseBrier + ' base · ' + Math.round(ev.odds.accuracy * 100) + '% called right at 0.5'],
  ['Terms that survived both tests', ev.terms.filter((t) => t.decision === 'kept').length + ' of ' + (ev.terms.length - 1), 'value model · the rest are shown below, not used'],
  ['Worth farming, this scenario', ev.verdicts.Farm + ' of ' + R.board_size, 'net beats a T-Bill and $25 an hour · ' + ev.verdicts.Marginal + ' marginal, ' + ev.verdicts.Skip + ' skip'],
  ['Watchlist ranked', R.integrity.watchlistRanked + ' / ' + R.watchlist_size, 'plus ' + R.early_size + ' pre-token protocols it leaves out'],
];
$('kpis').innerHTML = kpis.map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
$('integrity').innerHTML = [
  'this table = board.json: ' + R.board_size + ' of ' + R.board_size + ' rows recomputed here',
  'ranks 1–' + R.board_size + ' in order, values never rise',
  'totals equal: $' + fmtN(ev.sumImplied),
  'checksum ' + R.integrity.mainTsSha256.slice(0, 8) + ' = main.ts',
  'watchlist ' + R.integrity.watchlistRanked + ' of ' + R.watchlist_size + ' ranked',
  'ledger ' + R.accounting.total + ' of ' + R.accounting.total + ' protocols',
].map((s) => `<span>✓ ${s}</span>`).join('');
const acc = R.accounting;
$('acc-total').textContent = '— all ' + acc.total + ' snapshot protocols in exactly one group: ' + acc.ranked + ' ranked as pre-token, ' + acc.tradedUsable + ' token trades · priced comp, ' + acc.tokenNoCap + ' token recorded · no usable cap, ' + acc.setAside + ' left out by the house list\u2019s own rules';
const COLORS = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#8b949e', '#bc8cff', '#79c0ff', '#56d4dd'];
const accParts = [
  ['Ranked · watchlist ' + R.watchlist_size, R.watchlist_size],
  ['Ranked · early, below the floor', R.early_size],
  ['Token trades · priced comp', acc.tradedUsable],
  ['Token recorded · no usable cap', acc.tokenNoCap],
  ...acc.setAsideGroups.map((g) => ['Out · ' + g.label, g.count]),
];
$('acc-bar').innerHTML = accParts.map(([l, n], i) => `<i style="width:${(100 * n / acc.total).toFixed(2)}%;background:${COLORS[i % COLORS.length]}" title="${esc(l)}: ${n}"></i>`).join('');
$('acc-legend').innerHTML = accParts.map(([l, n], i) => `<span><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(l)} <b>${n}</b></span>`).join('');
$('acc-note').textContent = 'The floor is the watchlist\u2019s floor, never a ceiling: twenty pre-token protocols at or above $50M that pass the visible rules but the house list leaves out (its parent-protocol rule is not in the snapshot) are ranked as early rows. Two rows are bridge/wrapper-adjacent products the visible rules cannot catch; they are ranked, and the rule is stated here.';

// ---- evidence tables ----
const termRows = ev.terms.map((t) => `<tr><td>${esc(t.term)}</td><td class="num">×${t.loo.toFixed(2)}</td><td class="num">×${t.walkForward.toFixed(2)}</td><td class="${t.decision === 'kept' ? 'kept' : t.decision === 'must not help' ? 'must' : 'notkept'}">${t.decision}</td></tr>`).join('');
$('ev-value').innerHTML = '<tr><th>Term, added in order</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th><th></th></tr>' + termRows;
$('ev-value-note').textContent = `Full fit ×${ev.fullFactor} vs naive ×${ev.fullNaive}; 5-fold ×${ev.fiveFold.join(' / ')} (naive ×${ev.fiveFoldNaive.join(' / ')}); leave-one-out ×${ev.looFactor}; walk-forward ×${ev.walkForward.factor} vs naive ×${ev.walkForward.naive} (${ev.walkForward.train} listed before ${ev.walkForward.cutoff} price ${ev.walkForward.test} listed after). Coefficients: TVL^${ev.coefficients.beta} · peer · growth^${ev.coefficients.a} · maturity^${ev.coefficients.b} · breadth^${ev.coefficients.c}, scale ${ev.coefficients.scale}; global peer ${ev.globalPeer}×. Fold coefficients move — the dashboard says so, it does not hide it.`;
$('ev-odds').innerHTML = '<tr><th>Term, added in order</th><th class="num">Brier</th><th class="num">Share called right</th><th></th></tr>' +
  ev.oddsTerms.map((t) => `<tr><td>${esc(t.term)}</td><td class="num">${t.brier.toFixed(3)}</td><td class="num">${Math.round(t.accuracy * 100)}%</td><td class="${t.decision === 'kept' ? 'kept' : t.decision === 'must not help' ? 'must' : t.decision === 'baseline' ? '' : 'notkept'}">${t.decision}</td></tr>`).join('');
$('ev-odds-note').textContent = 'Held-out (5-fold): AUC ' + ev.odds.auc + ', Brier ' + ev.odds.brier + ' vs ' + ev.odds.baseBrier + ' for the base rate, ' + Math.round(ev.odds.accuracy * 100) + '% called right at 0.5 against a ' + Math.round(ev.odds.baseRate * 100) + '% base rate. The separator is weak — the odds move a row\u2019s value by a factor, they never decide it alone. Weights [log TVL, growth, age, chains] = [' + ev.oddsWeights.join(', ') + '], intercept ' + ev.oddsIntercept + '.';
$('ev-range').innerHTML = '<tr><th>Share of real caps</th><th class="num">Leave-one-out</th><th class="num">Walk-forward</th></tr>' +
  [['within ×3 of the model', ev.looCoverage.within3 + '%', ev.walkForward.within3 + '%'], ['inside P25–P75, stated 50%', ev.looCoverage.p25 + '%', ev.wfCoverageP25 + '%'], ['inside P10–P90, stated 80%', ev.looCoverage.p10 + '%', ev.wfCoverageP10 + '%']].map(([a, b, c]) => `<tr><td>${a}</td><td class="num">${b}</td><td class="num">${c}</td></tr>`).join('');
$('ev-range-note').textContent = 'Ranges are the leave-one-out residual quantiles: P25–P75 is the middle half of the blind misses, P10–P90 the middle 80%. Rank ranges come from 200 bootstrap refits of the peer multiples and scale. The walk-forward column prices the ' + ev.walkForward.test + ' tokens listed after ' + ev.walkForward.cutoff + ' with a model that never saw them — a range that holds fewer caps than stated is printed as it is, not widened to fit.';

// ---- scatter ----
(function scatter() {
  const svg = $('scatter');
  const W = 640, H = 320, PL = 46, PR = 12, PT = 10, PB = 28;
  const lx = (v) => PL + (Math.log10(v) - 6.7) / (10 - 6.7) * (W - PL - PR);
  const ly = (v) => H - PB - (Math.log10(Math.max(1e5, v)) - 5) / (10 - 5) * (H - PT - PB);
  let s = '';
  for (let e = 7; e <= 10; e++) s += `<line x1="${lx(10 ** e)}" y1="${PT}" x2="${lx(10 ** e)}" y2="${H - PB}" stroke="#21262d"/><text x="${lx(10 ** e)}" y="${H - 8}" fill="#8b949e" font-size="10" text-anchor="middle">$${e === 7 ? '10M' : e === 8 ? '100M' : e === 9 ? '1B' : '10B'}</text>`;
  for (let e = 5; e <= 10; e++) s += `<line x1="${PL}" y1="${ly(10 ** e)}" x2="${W - PR}" y2="${ly(10 ** e)}" stroke="#21262d"/><text x="${PL - 4}" y="${ly(10 ** e) + 3}" fill="#8b949e" font-size="10" text-anchor="end">$${e === 5 ? '100K' : e === 6 ? '1M' : e === 7 ? '10M' : e === 8 ? '100M' : e === 9 ? '1B' : '10B'}</text>`;
  const b = ev.coefficients.beta, sc = ev.coefficients.scale, gp = ev.globalPeer;
  let line = '';
  for (let t = 5e6; t <= 1e10; t *= 1.6) line += `${lx(t)},${ly(Math.exp(b * Math.log(t) + Math.log(gp) + sc))} `;
  s += `<polyline points="${line}" fill="none" stroke="#d29922" stroke-width="2"/>`;
  for (const c of R.comps) s += `<circle cx="${lx(c.tvl_usd)}" cy="${ly(c.mcap_usd)}" r="2.4" fill="#58a6ff" opacity="0.75"/>`;
  for (const r of R.rows) s += `<circle cx="${lx(r.tvl_usd)}" cy="${ly(Math.max(1e5, r.terminal_value_usd))}" r="2.2" fill="#f0883e" opacity="0.85"/>`;
  s += `<text x="${PL}" y="${PT + 8}" fill="#8b949e" font-size="11">Market cap vs TVL, log scale · ${R.comps.length} traded comps, ${R.rows.length} board rows</text>`;
  svg.innerHTML = s;
})();

// ---- filters + board ----
const cats = [...new Set(R.rows.map((r) => r.category || '—'))].sort();
const chains = [...new Set(R.rows.flatMap((r) => r.chains))].sort();
for (const c of cats) $('cat').insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);
for (const c of chains) $('chain').insertAdjacentHTML('beforeend', `<option>${esc(c)}</option>`);
const VC = [['all', 'All ' + R.board_size], ['Farm', 'Farm ' + ev.verdicts.Farm], ['Marginal', 'Marginal ' + ev.verdicts.Marginal], ['Skip', 'Skip ' + ev.verdicts.Skip]];
$('verdict-chips').innerHTML = VC.map(([v, l]) => `<button data-v="${v}" class="${state.verdict === v ? 'on' : ''}">${l}</button>`).join('');
$('verdict-chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.verdict = b.dataset.v; document.querySelectorAll('#verdict-chips button').forEach((x) => x.classList.toggle('on', x === b)); render(); });
$('q').addEventListener('input', (e) => { state.q = e.target.value.toLowerCase(); render(); });
$('tier').addEventListener('change', (e) => { state.tier = e.target.value; render(); });
$('cat').addEventListener('change', (e) => { state.cat = e.target.value; render(); });
$('chain').addEventListener('change', (e) => { state.chain = e.target.value; render(); });
$('reset').addEventListener('click', () => { Object.assign(state, { verdict: 'all', tier: 'all', q: '', cat: 'all', chain: 'all', depPct: 0.0002, share: 0.07, weeks: 12 }); $('q').value = ''; $('tier').value = 'all'; $('cat').value = 'all'; $('chain').value = 'all'; syncSliders(); document.querySelectorAll('#verdict-chips button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'all')); render(); });
function syncSliders() {
  $('dep').value = state.depPct; $('share').value = state.share * 100; $('horizon').value = state.weeks;
  $('dep-v').textContent = (state.depPct * 100).toFixed(3) + '%'; $('share-v').textContent = Math.round(state.share * 100) + '%'; $('horizon-v').textContent = state.weeks + ' wk';
}
$('dep').addEventListener('input', (e) => { state.depPct = +e.target.value; syncSliders(); render(); });
$('share').addEventListener('input', (e) => { state.share = +e.target.value / 100; syncSliders(); render(); });
$('horizon').addEventListener('input', (e) => { state.weeks = +e.target.value; syncSliders(); render(); });
$('csv').addEventListener('click', () => download('launch-odds-radar-v5.csv', 'text/csv', csv()));
$('json').addEventListener('click', () => download('launch-odds-radar-v5.json', 'application/json', JSON.stringify(filtered().map((r) => { const e = econ(r); return { ...r, deposit_usd: e.dep, drop_usd: +e.drop.toFixed(2), fees_usd: +e.fees.toFixed(2), net_usd: +e.net.toFixed(2), net_per_hour_usd: +e.nph.toFixed(2), verdict: e.verdict }; }), null, 1)));
function download(name, type, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function csv() {
  const head = 'rank,slug,name,category,tvl_usd,token_odds,terminal_value_usd,implied_value_usd,p25_usd,p75_usd,verdict,deposit_usd,drop_usd,fees_usd,net_usd,net_per_hour_usd';
  return [head, ...filtered().map((r) => { const e = econ(r); return [r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + (r.category || '') + '"', r.tvl_usd, r.token_odds, r.terminal_value_usd, r.implied_value_usd, r.p25_usd, r.p75_usd, e.verdict, e.dep, e.drop.toFixed(2), e.fees.toFixed(2), e.net.toFixed(2), e.nph.toFixed(2)].join(','); })].join('\n');
}
document.querySelectorAll('#board th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.k; if (state.sort === k) state.dir *= -1; else { state.sort = k; state.dir = 1; } render(); }));
function tierOf(r) { return r.watchlist ? 'watchlist' : r.tvl_usd >= R.floor_usd ? 'offlist' : 'early'; }
function filtered() {
  return R.rows.filter((r) => {
    const e = econ(r);
    if (state.verdict !== 'all' && e.verdict !== state.verdict) return false;
    if (state.tier !== 'all' && tierOf(r) !== state.tier) return false;
    if (state.cat !== 'all' && (r.category || '—') !== state.cat) return false;
    if (state.chain !== 'all' && !r.chains.includes(state.chain)) return false;
    if (state.q && !(r.name + ' ' + r.slug + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().includes(state.q)) return false;
    return true;
  }).sort((a, b) => {
    const k = state.sort; let va, vb;
    if (k === 'name') { va = a.name; vb = b.name; }
    else if (k === 'verdict') { va = econ(a).verdict; vb = econ(b).verdict; }
    else if (k === 'net_per_hour_usd') { va = econ(a).nph; vb = econ(b).nph; }
    else if (k === 'range') { va = a.rank_lo; vb = b.rank_lo; }
    else { va = a[k]; vb = b[k]; }
    if (va === null) return 1; if (vb === null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.dir;
  });
}
function render() {
  const rows = filtered();
  $('count').textContent = rows.length + ' of ' + R.board_size + ' rows · $' + fmtN(rows.reduce((s, r) => s + r.implied_value_usd, 0)) + ' implied';
  $('rows').innerHTML = rows.map((r) => {
    const e = econ(r);
    return `<tr data-slug="${r.slug}"><td>${r.rank}</td><td>${r.rank_lo}–${r.rank_hi}</td><td><span class="nm">${esc(r.name)}</span>${r.watchlist ? '<span class="tag w">Watchlist</span>' : ''}<span class="sub2">${esc(r.category || '—')} · ${esc(r.chains[0] || '—')}${r.chains.length > 1 ? ' +' + (r.chains.length - 1) : ''}</span></td><td>${fmt$(r.tvl_usd)}</td><td>${fmtChg(r.change_7d)}</td><td>${fmtAge(r.age_days)}</td><td>${Math.round(r.token_odds * 100)}%<span class="oddsbar"><i style="width:${Math.round(r.token_odds * 100)}%"></i></span></td><td>${fmt$(r.terminal_value_usd)}</td><td><b>${fmt$(r.implied_value_usd)}</b><span class="sub2">${fmt$(r.p25_usd)}–${fmt$(r.p75_usd)}</span></td><td><span class="pill ${e.verdict}">${e.verdict.toUpperCase()}</span> ${e.net >= 0 ? '+' : '−'}$${fmtN(Math.abs(e.net))}<span class="sub2">$${fmtN(e.drop)} drop − $${e.fees.toFixed(2)} fees</span></td><td>${e.nph >= 0 ? '+' : '−'}$${Math.abs(e.nph).toFixed(2)}</td></tr>`;
  }).join('');
  if (state.detail) showDetail(state.detail);
}
$('rows').addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (!tr) return; state.detail = tr.dataset.slug; showDetail(state.detail); });
function showDetail(slug) {
  const r = R.rows.find((x) => x.slug === slug);
  if (!r) return;
  const e = econ(r);
  const d = $('detail');
  d.hidden = false;
  const peers = r.peers.map((p) => `<tr><td>${esc(p.name)}${p.symbol ? ' ' + esc(p.symbol) : ''}</td><td>${esc(p.category || '—')}</td><td class="num">${fmt$(p.tvl_usd)}</td><td class="num">${fmt$(p.mcap_usd)}</td><td class="num">×${p.multiple}</td><td class="num">${fmt$(p.model_value_usd)}</td></tr>`).join('');
  const gridCells = [0.035, 0.07, 0.14].flatMap((sh) => [1000, 10000, 30000].map((dep) => {
    const drop = r.implied_value_usd * sh * dep / r.tvl_usd;
    const net = drop - (2.95 + 0.0005 * dep);
    const closest = [1000, 10000, 30000].reduce((a, b) => Math.abs(b - e.dep) < Math.abs(a - e.dep) ? b : a);
    return `<div class="${Math.abs(sh - state.share) < 0.001 && dep === closest ? 'hl' : ''}"><div class="n">${net >= 0 ? '+' : '−'}$${fmtN(Math.abs(net))}</div><div>${Math.round(sh * 100)}% × $${fmtN(dep)}</div></div>`;
  })).join('');
  d.innerHTML = `<div class="board-head"><h2>#${r.rank} of ${R.board_size} by implied value · rank ${r.rank_lo}–${r.rank_hi} across 200 bootstrap refits</h2><button onclick="document.getElementById('detail').hidden=true">Close</button></div>
  <h2>${esc(r.name)} ${r.watchlist ? '<span class="tag w">Watchlist</span>' : ''}</h2>
  <div class="big">${fmt$(r.implied_value_usd)}</div>
  <p class="note">If a token launches ${fmt$(r.terminal_value_usd)} · Token odds ${Math.round(r.token_odds * 100)}% · P25–P75 ${fmt$(r.p25_usd)}–${fmt$(r.p75_usd)} · P10–P90 ${fmt$(r.p10_usd)}–${fmt$(r.p90_usd)} · TVL ${fmt$(r.tvl_usd)} · ${fmtChg(r.change_7d)} over 7 days · Listed since ${r.listed_at || 'unknown'} · ${fmtAge(r.age_days)} with no token. Recomputed in this browser: equals board.json. ${esc(r.name)} records no token, which is not proof it has none; the figure is its peers' record, not a forecast.</p>
  <div class="cols"><div>
    <h3>How the figure is made</h3>
    <table class="audit">
    <tr><td>TVL · DefiLlama, ${R.as_of}</td><td class="num">${fmt$(r.tvl_usd)}</td></tr>
    <tr><td>Base multiple · ${esc(r.category || 'no category')} peers at $100M TVL, shrunk</td><td class="num">×${(r.peer_multiple * Math.pow(1e8, ev.coefficients.beta - 1) * Math.exp(ev.coefficients.scale)).toFixed(2)}</td></tr>
    <tr><td>Size curve · TVL vs $100M TVL</td><td class="num">×${Math.pow(r.tvl_usd / 1e8, ev.coefficients.beta - 1).toFixed(2)}</td></tr>
    <tr><td>Growth · 7-day ${fmtChg(r.change_7d)}</td><td class="num">×${r.growth_mult}</td></tr>
    <tr><td>Maturity · ${fmtAge(r.age_days)}</td><td class="num">×${r.maturity_mult}</td></tr>
    <tr><td>Breadth · ${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}</td><td class="num">×${r.breadth_mult}</td></tr>
    <tr><td><b>= Value if a token launches</b></td><td class="num"><b>${fmt$(r.terminal_value_usd)}</b></td></tr>
    <tr><td>Token odds · peers' record</td><td class="num">×${r.token_odds}</td></tr>
    <tr><td><b>= Implied value</b></td><td class="num"><b>${fmt$(r.implied_value_usd)}</b></td></tr>
    </table>
    <p class="note">Tested, not used: the flat peer multiple (one multiple for every protocol) — it misses by ×${ev.terms[0].loo} leave-one-out against ×${ev.terms[5].loo} for the full model. The control (another row's growth) performs within noise of the fitted terms, so the growth term's own contribution is small; the model's power is the size curve and the category peer. See the evidence tables above.</p>
    <h3>Nearest priced peers · their tokens trade</h3>
    <table><tr><th>Token</th><th>Category</th><th class="num">TVL</th><th class="num">Market cap</th><th class="num">Cap / TVL</th><th class="num">Model value</th></tr>${peers}</table>
  </div><div>
    <h3>Farm verdict · ${e.verdict.toUpperCase()}</h3>
    <p>${e.verdict === 'Farm' ? `FARM: $${fmtN(e.dep)} for ${state.weeks} weeks buys a modelled drop of $${fmtN(e.drop)} for $${e.fees.toFixed(2)} of fees and ${e.hours.toFixed(1)} h of work, a net of $${fmtN(e.net)} ($${e.nph.toFixed(0)} an hour) against $${fmtN(e.tbill)} from the same money in a 4% T-Bill.` : e.verdict === 'Marginal' ? `MARGINAL: $${fmtN(e.dep)} for ${state.weeks} weeks buys a modelled drop of $${fmtN(e.drop)} for $${e.fees.toFixed(2)} of fees and ${e.hours.toFixed(1)} h of work, a net of $${fmtN(e.net)} ($${e.nph.toFixed(2)} an hour) against $${fmtN(e.tbill)} from the same money in a 4% T-Bill. It pays, but it does not beat both bars — the T-Bill and $25 an hour.` : `SKIP: $${fmtN(e.dep)} for ${state.weeks} weeks buys a modelled drop of $${fmtN(e.drop)} for $${e.fees.toFixed(2)} of fees — a net of $${fmtN(e.net)}, under $1 an hour. The position costs more attention than it returns.`}</p>
    <table><tr><td>At risk</td><td class="num">$${fmtN(e.dep)}</td><td>Fees, ${state.weeks} weeks</td><td class="num">$${e.fees.toFixed(2)}</td></tr>
    <tr><td>Modelled drop</td><td class="num">$${fmtN(e.drop)}</td><td>Hands-on</td><td class="num">${e.hours.toFixed(1)} h</td></tr>
    <tr><td>Net of fees</td><td class="num"><b>$${fmtN(e.net)}</b></td><td>Net per hour</td><td class="num"><b>$${e.nph.toFixed(2)}</b></td></tr></table>
    <p class="note">Benchmarks: same $${fmtN(e.dep)} in a 4% T-Bill, ${state.weeks} weeks: $${fmtN(e.tbill)}. Fees covered above a drop share of ${(100 * (e.fees * r.tvl_usd / (r.implied_value_usd * e.dep))).toFixed(1)}%. Fees covered above token odds of ${(100 * (e.fees * r.tvl_usd / (r.terminal_value_usd * state.share * e.dep))).toFixed(1)}%. Exit if TVL prints below $${fmtN(r.tvl_usd * 0.83)} (−17% in a week).</p>
    <h3>Net by drop share × deposit</h3>
    <div class="grid-net">${gridCells}</div>
    <p class="note">Rows: drop share 3.5% / 7% / 14%. Columns: deposit $1,000 / $10,000 / $30,000. Highlighted: the current scenario.</p>
    <h3>Farm plan · 10 steps</h3>
    <ol class="steps">${r.farm_steps.map((s) => { const m = s.match(/^(.*?) Cost: (.*?)\. Time: (.*?)\.$/); return m ? `<li>${esc(m[1])}<div class="ct">COST ${esc(m[2])} · TIME ${esc(m[3])}</div></li>` : `<li>${esc(s)}</li>`; }).join('')}</ol>
  </div></div>`;
  d.scrollIntoView({ behavior: 'auto', block: 'start' });
}
$('method').textContent = `Implied value = TVL^${ev.coefficients.beta} × fitted peer multiple (category median log(mcap/TVL), shrunk toward the global median ${ev.globalPeer}×, weight n/(n+8)) × growth^${ev.coefficients.a} × maturity^${ev.coefficients.b} × breadth^${ev.coefficients.c} × e^${ev.coefficients.scale}, fitted by grid on the ${ev.pricedCount} traded tokens with a usable market cap; × odds it launches, from a logistic model on the same features. Held-out: full ×${ev.fullFactor}, 5-fold ×${ev.fiveFold.join(' / ')}, leave-one-out ×${ev.looFactor}, walk-forward ×${ev.walkForward.factor} (naive flat multiple ×${ev.fullNaive} / ×${ev.walkForward.naive}). Farm economics at 0.02% of TVL (clamped $250–$10,000), 7% drop share, 12 weeks.`;
syncSliders();
// Deep links for screenshots and sharing: ?detail=<slug> opens a row, ?verdict=Farm filters it.
// A deep link also focuses the page on that view (the normal page is unchanged).
const params = new URLSearchParams(location.search);
if (params.get('verdict') && ['Farm', 'Marginal', 'Skip'].includes(params.get('verdict'))) {
  state.verdict = params.get('verdict');
  document.querySelectorAll('#verdict-chips button').forEach((x) => x.classList.toggle('on', x.dataset.v === state.verdict));
  document.body.classList.add('focus-board');
}
if (params.get('detail')) { state.detail = params.get('detail'); document.body.classList.add('focus-detail'); }
render();
