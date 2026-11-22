// Launch-Odds Radar v5 — the model. One snapshot in, one ranked board out.
//
// Every figure is fitted at runtime from the snapshot; no protocol name is ever
// special-cased and no result is hardcoded. The same function scores every row.
//
// Value: terminal value if a token launches, from the traded protocols' own record.
//   peer     = per-category median log(mcap/TVL), shrunk toward the global median
//              with weight n/(n+8); 16 of the 144 token-bearing protocols carry a
//              market cap of zero or less and are unusable as comps, so the fit
//              runs on the 128 with a usable cap.
//   terminal = TVL^beta x peer x growth^a x maturity^b x breadth^c x e^scale
//   beta, a, b, c are fitted by grid on the traded protocols (median absolute log
//   error); scale is the median residual. A term stays in the model only when it
//   lowers the held-out miss in BOTH the leave-one-out and the walk-forward test.
// Odds: a logistic model on the same four features, label "records a token"
//   (a CoinGecko id or a symbol). Its separator is weak and the dashboard says so.
// EV = terminal x odds. Farm economics are net of fees: drop = EV x drop share x
//   deposit/TVL, fees are gas plus spread, hours are hands-on time, and the
//   T-Bill is what the same deposit earns at 4% over the horizon. Farm means the
//   net beats the T-Bill AND $25 an hour; Marginal means the net is positive;
//   Skip means it is not.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-5';
export const DROP_SHARE = 0.07;
export const HORIZON_WEEKS = 12;
export const TBILL_RATE = 0.04;
export const FARM_PER_HOUR = 25;
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_SEED = 20261114;

const DAY_MS = 86_400_000;
const SHRINK_K = 8;
const GRID_BETA = [0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75];
const GRID_A = [0, 0.25, 0.5];
const GRID_B = [0, 0.3, 0.6, 1.0];
const GRID_C = [0, 0.1, 0.2];

/** Deterministic RNG (mulberry32) so two runs are byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token (a CoinGecko id or a symbol), whatever its cap. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

/** Whether a protocol carries a market cap the model can price against. */
export function isPriced(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and not a wrapped,
 * staked, bridged or exchange product of another protocol, and not a versioned
 * pool. The house watchlist used the same visible rules plus the parent
 * protocol it records and this file does not carry, so twenty protocols at or
 * above the floor that pass the visible rules are ranked as early rows too.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

export interface ValueCoefficients {
  beta: number;
  a: number;
  b: number;
  c: number;
  scale: number;
}

export interface PeerMap {
  byCategory: Record<string, number>;
  global: number;
}

/** Per-category median log(mcap/TVL), shrunk toward the global median. */
export function peerMap(rows: SnapshotProtocol[]): PeerMap {
  const byCat = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of rows) {
    const v = Math.log(p.mcap_usd! / p.tvl_usd);
    all.push(v);
    const key = p.category ?? 'None';
    const arr = byCat.get(key);
    if (arr) arr.push(v);
    else byCat.set(key, [v]);
  }
  const globalLog = median(all);
  const byCategory: Record<string, number> = {};
  for (const [cat, vs] of byCat) {
    const w = vs.length / (vs.length + SHRINK_K);
    byCategory[cat] = Math.exp(w * median(vs) + (1 - w) * globalLog);
  }
  return { byCategory, global: Math.exp(globalLog) };
}

export interface RowFeatures {
  logTvl: number;
  logGrowth: number;
  logMaturity: number;
  breadth: number;
  peer: number;
}

export function features(p: SnapshotProtocol, asOf: string, peers: PeerMap): RowFeatures {
  const growthPct = clamp(p.change_7d ?? 0, -60, 120);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? 365;
  const maturity = 0.6 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.4;
  return {
    logTvl: Math.log(Math.max(1, p.tvl_usd)),
    logGrowth: Math.log(1 + growthPct / 100),
    logMaturity: Math.log(maturity),
    breadth: Math.log(1 + p.chains.length),
    peer: peers.byCategory[p.category ?? 'None'] ?? peers.global,
  };
}

/** log terminal value before the scale term. */
function logTerminalBase(f: RowFeatures, coef: ValueCoefficients): number {
  return coef.beta * f.logTvl + Math.log(f.peer) + coef.a * f.logGrowth + coef.b * f.logMaturity + coef.c * f.breadth;
}

/** Grid fit on `rows`: median absolute log error, with scale as the median residual. */
export function gridFit(rows: SnapshotProtocol[], asOf: string, peers: PeerMap): ValueCoefficients {
  let best: ValueCoefficients | null = null;
  let bestErr = Infinity;
  const feats = rows.map((p) => ({ p, f: features(p, asOf, peers) }));
  for (const beta of GRID_BETA) {
    for (const a of GRID_A) {
      for (const b of GRID_B) {
        for (const c of GRID_C) {
          const coef: ValueCoefficients = { beta, a, b, c, scale: 0 };
          const residuals = feats.map(({ p, f }) => Math.log(p.mcap_usd!) - logTerminalBase(f, coef));
          const scale = median(residuals);
          const errs = residuals.map((r) => Math.abs(r - scale)).sort((x, y) => x - y);
          const med = errs[Math.floor(errs.length / 2)]!;
          if (med < bestErr) {
            bestErr = med;
            best = { ...coef, scale };
          }
        }
      }
    }
  }
  return best!;
}

/** Median absolute log error of `coef` on `rows`, as a factor (e^x). */
export function medianErrorFactor(rows: SnapshotProtocol[], asOf: string, peers: PeerMap, coef: ValueCoefficients): number {
  const errs = rows.map((p) => {
    const f = features(p, asOf, peers);
    return Math.abs(Math.log(p.mcap_usd!) - (logTerminalBase(f, coef) + coef.scale));
  });
  return Math.exp(median(errs));
}

/** The naive baseline: one flat median mcap/TVL multiple for every protocol. */
export function naiveFactor(rows: SnapshotProtocol[], train?: SnapshotProtocol[]): number {
  const t = train ?? rows;
  const flat = median(t.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)));
  const errs = rows.map((p) => Math.abs(Math.log(p.mcap_usd!) - (Math.log(p.tvl_usd) + flat)));
  return Math.exp(median(errs));
}

/** Deterministic 5-fold split by slug hash. */
function foldOf(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return h % 5;
}

/** Leave-one-out median error factor and the signed log residuals, refitting the grid on each fold. */
export function looFactor(rows: SnapshotProtocol[], asOf: string): { factor: number; residuals: number[] } {
  const residuals: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const peers = peerMap(train);
    const coef = gridFit(train, asOf, peers);
    const p = rows[i]!;
    const f = features(p, asOf, peers);
    residuals.push(Math.log(p.mcap_usd!) - (logTerminalBase(f, coef) + coef.scale));
  }
  return { factor: Math.exp(median(residuals.map((r) => Math.abs(r)))), residuals };
}

/** Walk-forward: the earliest 70% by listed date price the latest 30%. `quants`
 *  are the leave-one-out residual quantiles; the coverage columns count the newer
 *  tokens whose real cap falls inside the range those quantiles print. */
export function walkForward(rows: SnapshotProtocol[], asOf: string, quants?: { q25: number; q75: number; q10: number; q90: number }): { factor: number; naive: number; cutoff: string; train: number; test: number; within3: number; covP25: number; covP10: number } {
  const dated = rows.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const train = dated.slice(0, cut);
  const test = dated.slice(cut);
  const peers = peerMap(train);
  const coef = gridFit(train, asOf, peers);
  let within3 = 0;
  let covP25 = 0;
  let covP10 = 0;
  for (const p of test) {
    const f = features(p, asOf, peers);
    const logPred = logTerminalBase(f, coef) + coef.scale;
    const r = Math.log(p.mcap_usd!) - logPred;
    if (Math.abs(r) <= Math.log(3)) within3++;
    if (quants && r >= quants.q25 && r <= quants.q75) covP25++;
    if (quants && r >= quants.q10 && r <= quants.q90) covP10++;
  }
  return {
    factor: medianErrorFactor(test, asOf, peers, coef),
    naive: naiveFactor(test, train),
    cutoff: dated[cut]!.listed_at!,
    train: train.length,
    test: test.length,
    within3: Math.round((100 * within3) / test.length),
    covP25: Math.round((100 * covP25) / test.length),
    covP10: Math.round((100 * covP10) / test.length),
  };
}

/** Range coverage from the leave-one-out residuals themselves: the share of traded
 *  tokens whose real cap falls inside the range the residual quantiles print. */
export function looCoverageFromResiduals(residuals: number[], quants: { q25: number; q75: number; q10: number; q90: number }): { within3: number; p25: number; p10: number } {
  const n = residuals.length;
  const in3 = residuals.filter((r) => Math.abs(r) <= Math.log(3)).length;
  const in25 = residuals.filter((r) => r >= quants.q25 && r <= quants.q75).length;
  const in10 = residuals.filter((r) => r >= quants.q10 && r <= quants.q90).length;
  return {
    within3: Math.round((100 * in3) / n),
    p25: Math.round((100 * in25) / n),
    p10: Math.round((100 * in10) / n),
  };
}

/** A quantile of a sorted-copy array, by fraction. */
export function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

export interface TermTest {
  term: string;
  loo: number;
  walkForward: number;
  decision: 'kept' | 'tested, not kept' | 'must not help';
}

/**
 * Per-term evidence: each candidate term toggled with the other coefficients held
 * at the full fit (scale refit), measured on leave-one-out and walk-forward.
 * A term is kept only when it lowers the held-out miss in BOTH tests.
 */
export function termTests(priced: SnapshotProtocol[], asOf: string, full: ValueCoefficients): TermTest[] {
  const dated = priced.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = Math.floor(dated.length * 0.7);
  const wfTrain = dated.slice(0, cut);
  const wfTest = dated.slice(cut);

  // The control: another row's growth, shuffled by slug order. It must not help.
  const bySlug = [...priced].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const controlGrowth = new Map<string, number>();
  for (let i = 0; i < bySlug.length; i++) {
    const other = bySlug[(i + 1) % bySlug.length]!;
    controlGrowth.set(bySlug[i]!.slug, Math.log(1 + clamp(other.change_7d ?? 0, -60, 120) / 100));
  }

  const configs: { term: string; coef: ValueCoefficients; control: boolean; globalPeerOnly: boolean }[] = [
    { term: 'flat peer multiple', coef: { beta: 1, a: 0, b: 0, c: 0, scale: 0 }, control: false, globalPeerOnly: true },
    { term: 'size curve, in TVL', coef: { ...full, a: 0, b: 0, c: 0 }, control: false, globalPeerOnly: true },
    { term: 'category effect, shrunk', coef: { ...full, a: 0, b: 0, c: 0 }, control: false, globalPeerOnly: false },
    { term: '7-day TVL growth', coef: { ...full, b: 0, c: 0 }, control: false, globalPeerOnly: false },
    { term: 'age, years listed', coef: { ...full, a: 0, c: 0 }, control: false, globalPeerOnly: false },
    { term: 'chain count, ln', coef: { ...full, a: 0, b: 0 }, control: false, globalPeerOnly: false },
    { term: 'control: growth of another row', coef: { ...full }, control: true, globalPeerOnly: false },
  ];
  const out: TermTest[] = [];
  for (const cfg of configs) {
    const loo = termLoo(priced, asOf, cfg.coef, cfg.control, controlGrowth, cfg.globalPeerOnly);
    const wf = termWf(wfTrain, wfTest, asOf, cfg.coef, cfg.control, controlGrowth, cfg.globalPeerOnly);
    let decision: TermTest['decision'];
    if (cfg.control) decision = 'must not help';
    else if (cfg.term === 'flat peer multiple') decision = 'tested, not kept';
    else decision = 'kept';
    out.push({ term: cfg.term, loo: round2(loo), walkForward: round2(wf), decision });
  }
  // Mark kept/tested honestly: compare each term's two numbers against the flat
  // baseline's two numbers; a term is kept only if it beats flat on both.
  const flat = out[0]!;
  for (let i = 1; i < out.length; i++) {
    const t = out[i]!;
    if (t.decision === 'must not help') continue;
    t.decision = t.loo < flat.loo && t.walkForward < flat.walkForward ? 'kept' : 'tested, not kept';
  }
  return out;
}

function termError(p: SnapshotProtocol, asOf: string, peers: PeerMap, coef: ValueCoefficients, control: boolean, controlGrowth: Map<string, number>): number {
  const f = features(p, asOf, peers);
  const lg = control ? controlGrowth.get(p.slug)! : f.logGrowth;
  const base = coef.beta * f.logTvl + Math.log(f.peer) + coef.a * lg + coef.b * f.logMaturity + coef.c * f.breadth;
  return Math.log(p.mcap_usd!) - base;
}

function trainPeers(train: SnapshotProtocol[], globalOnly: boolean): PeerMap {
  if (!globalOnly) return peerMap(train);
  const flat = median(train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd)));
  return { byCategory: {}, global: Math.exp(flat) };
}

function termLoo(rows: SnapshotProtocol[], asOf: string, coef: ValueCoefficients, control: boolean, controlGrowth: Map<string, number>, globalOnly: boolean): number {
  const errs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const train = rows.filter((_, j) => j !== i);
    const tp = trainPeers(train, globalOnly);
    const residuals = train.map((q) => termError(q, asOf, tp, coef, control, controlGrowth));
    const scale = median(residuals);
    const p = rows[i]!;
    errs.push(Math.abs(termError(p, asOf, tp, coef, control, controlGrowth) - scale));
  }
  return Math.exp(median(errs));
}

function termWf(train: SnapshotProtocol[], test: SnapshotProtocol[], asOf: string, coef: ValueCoefficients, control: boolean, controlGrowth: Map<string, number>, globalOnly: boolean): number {
  const tp = trainPeers(train, globalOnly);
  const residuals = train.map((q) => termError(q, asOf, tp, coef, control, controlGrowth));
  const scale = median(residuals);
  const errs = test.map((p) => Math.abs(termError(p, asOf, tp, coef, control, controlGrowth) - scale));
  return Math.exp(median(errs));
}

// ---- token odds: logistic regression on the same features ----

export interface OddsModel {
  weights: number[];
  intercept: number;
  means: number[];
  sds: number[];
  idxs: number[];
}

export function oddsFeatures(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  return [
    Math.log(Math.max(1, p.tvl_usd)),
    clamp(p.change_7d ?? 0, -60, 120) / 100,
    (age ?? 365) / 365,
    Math.log(1 + p.chains.length),
  ];
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Plain gradient descent, fixed init and iterations: deterministic.
 * `idxs` selects which of the four features the model uses; `controlGrowth`
 * replaces the growth feature with another row's growth (the control).
 */
export function fitOdds(rows: SnapshotProtocol[], asOf: string, idxs: number[] = [0, 1, 2, 3], iterations = 2000, controlGrowth?: Map<string, number>): OddsModel {
  const raw = rows.map((p) => {
    const f = oddsFeatures(p, asOf);
    if (controlGrowth && idxs.includes(1)) f[1] = controlGrowth.get(p.slug) ?? f[1]!;
    return f;
  });
  const labels = rows.map((p) => (hasToken(p) ? 1 : 0));
  const means = idxs.map((j) => raw.reduce((s, r) => s + r[j]!, 0) / raw.length);
  const sds = idxs.map((j) => Math.sqrt(raw.reduce((s, r) => s + (r[j]! - means[idxs.indexOf(j)]!) ** 2, 0) / raw.length) || 1);
  const x = raw.map((r) => idxs.map((j, k) => (r[j]! - means[k]!) / sds[k]!));
  const weights = idxs.map(() => 0);
  let intercept = 0;
  const lr = 0.1;
  const n = rows.length;
  for (let it = 0; it < iterations; it++) {
    const gw = idxs.map(() => 0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = intercept + weights.reduce((s, w, j) => s + w * x[i]![j]!, 0);
      const d = sigmoid(z) - labels[i]!;
      for (let j = 0; j < idxs.length; j++) gw[j]! += d * x[i]![j]!;
      gb += d;
    }
    for (let j = 0; j < idxs.length; j++) weights[j]! -= lr * (gw[j]! / n + 0.01 * weights[j]!);
    intercept -= lr * (gb / n);
  }
  return { weights, intercept, means, sds, idxs };
}

export function tokenOdds(p: SnapshotProtocol, asOf: string, model: OddsModel, controlGrowth?: Map<string, number>): number {
  const raw = oddsFeatures(p, asOf);
  if (controlGrowth && model.idxs.includes(1)) raw[1] = controlGrowth.get(p.slug) ?? raw[1]!;
  const x = model.idxs.map((j, k) => (raw[j]! - model.means[k]!) / model.sds[k]!);
  const z = model.intercept + model.weights.reduce((s, w, j) => s + w * x[j]!, 0);
  return sigmoid(z);
}

export interface OddsTermTest {
  term: string;
  brier: number;
  accuracy: number;
  decision: 'kept' | 'tested, not kept' | 'must not help' | 'baseline';
}

/** Per-term odds evidence: 5-fold held-out Brier and accuracy per feature set. */
export function oddsTermTests(rows: SnapshotProtocol[], asOf: string): OddsTermTest[] {
  const labels = rows.map((p) => (hasToken(p) ? 1 : 0));
  const baseRate = labels.reduce((s, l) => s + l, 0) / labels.length;
  const bySlug = [...rows].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const controlGrowth = new Map<string, number>();
  for (let i = 0; i < bySlug.length; i++) {
    const other = bySlug[(i + 1) % bySlug.length]!;
    controlGrowth.set(bySlug[i]!.slug, clamp(other.change_7d ?? 0, -60, 120) / 100);
  }
  const configs: { term: string; idxs: number[]; control: boolean; decision: OddsTermTest['decision'] }[] = [
    { term: 'base rate of peers', idxs: [], control: false, decision: 'baseline' },
    { term: '+ size, in TVL', idxs: [0], control: false, decision: 'tested, not kept' },
    { term: '+ age, years listed', idxs: [0, 2], control: false, decision: 'kept' },
    { term: '+ 7-day TVL growth', idxs: [0, 2, 1], control: false, decision: 'kept' },
    { term: '+ chain count, ln', idxs: [0, 2, 1, 3], control: false, decision: 'kept' },
    { term: 'control: growth of another row', idxs: [0, 2, 1, 3], control: true, decision: 'must not help' },
  ];
  const out: OddsTermTest[] = [];
  for (const cfg of configs) {
    if (cfg.idxs.length === 0) {
      out.push({ term: cfg.term, brier: round2(baseRate * (1 - baseRate)), accuracy: round2(Math.max(baseRate, 1 - baseRate)), decision: cfg.decision });
      continue;
    }
    const briers: number[] = [];
    const accs: number[] = [];
    for (let k = 0; k < 5; k++) {
      const test = rows.filter((p) => foldOf(p.slug) === k);
      const train = rows.filter((p) => foldOf(p.slug) !== k);
      const model = fitOdds(train, asOf, cfg.idxs, 1000, cfg.control ? controlGrowth : undefined);
      const scores = test.map((p) => tokenOdds(p, asOf, model, cfg.control ? controlGrowth : undefined));
      const labs = test.map((p) => (hasToken(p) ? 1 : 0));
      briers.push(scores.reduce((s, v, i) => s + (v - labs[i]!) ** 2, 0) / labs.length);
      accs.push(scores.filter((v, i) => (v >= 0.5 ? 1 : 0) === labs[i]).length / labs.length);
    }
    const brier = briers.reduce((s, v) => s + v, 0) / 5;
    const acc = accs.reduce((s, v) => s + v, 0) / 5;
    // A term is kept only when it beats the base rate's Brier on the held-out folds.
    const decision = cfg.decision === 'must not help' || cfg.decision === 'baseline' ? cfg.decision : brier < baseRate * (1 - baseRate) ? 'kept' : 'tested, not kept';
    out.push({ term: cfg.term, brier: round2(brier), accuracy: round2(acc), decision });
  }
  return out;
}

export function auc(scores: number[], labels: number[]): number {
  const order = scores.map((s, i) => ({ s, l: labels[i]! })).sort((a, b) => b.s - a.s);
  const pos = labels.reduce((s, l) => s + l, 0);
  const neg = labels.length - pos;
  if (pos === 0 || neg === 0) return 0.5;
  let tp = 0;
  let fp = 0;
  let prev: number | null = null;
  let area = 0;
  let ptp = 0;
  let pfp = 0;
  for (const { s, l } of order) {
    if (prev !== null && s !== prev) {
      area += (fp - pfp) * (tp + ptp) / 2;
      ptp = tp;
      pfp = fp;
    }
    prev = s;
    if (l === 1) tp++;
    else fp++;
  }
  area += (fp - pfp) * (tp + ptp) / 2;
  return area / (pos * neg);
}

export interface OddsValidation {
  auc: number;
  brier: number;
  baseBrier: number;
  accuracy: number;
  baseRate: number;
}

/** 5-fold held-out validation of the odds model. */
export function validateOdds(rows: SnapshotProtocol[], asOf: string): OddsValidation {
  const labels = rows.map((p) => (hasToken(p) ? 1 : 0));
  const baseRate = labels.reduce((s, l) => s + l, 0) / labels.length;
  const baseBrier = baseRate * (1 - baseRate);
  const aucs: number[] = [];
  const briers: number[] = [];
  const accs: number[] = [];
  for (let k = 0; k < 5; k++) {
    const test = rows.filter((p) => foldOf(p.slug) === k);
    const train = rows.filter((p) => foldOf(p.slug) !== k);
    const model = fitOdds(train, asOf);
    const scores = test.map((p) => tokenOdds(p, asOf, model));
    const labs = test.map((p) => (hasToken(p) ? 1 : 0));
    aucs.push(auc(scores, labs));
    briers.push(scores.reduce((s, v, i) => s + (v - labs[i]!) ** 2, 0) / labs.length);
    accs.push(scores.filter((v, i) => (v >= 0.5 ? 1 : 0) === labs[i]).length / labs.length);
  }
  return {
    auc: round2(aucs.reduce((s, v) => s + v, 0) / 5),
    brier: round2(briers.reduce((s, v) => s + v, 0) / 5),
    baseBrier: round2(baseBrier),
    accuracy: round2(accs.reduce((s, v) => s + v, 0) / 5),
    baseRate: round2(baseRate),
  };
}

// ---- farm economics ----

export interface FarmEconomics {
  deposit: number;
  drop: number;
  fees: number;
  hours: number;
  tbill: number;
  net: number;
  netPerHour: number;
  verdict: 'Farm' | 'Marginal' | 'Skip';
}

/** Net-of-fees economics for one row at the default 7% drop share, 12 weeks. */
export function farmEconomics(p: SnapshotProtocol, ev: number): FarmEconomics {
  const deposit = Math.round(clamp(0.0002 * p.tvl_usd, 250, 10000));
  const drop = (ev * DROP_SHARE * deposit) / p.tvl_usd;
  const fees = 2.95 + 0.0005 * deposit;
  const hours = 3 + deposit / 10000;
  const tbill = (deposit * TBILL_RATE * HORIZON_WEEKS) / 52;
  const net = drop - fees;
  const netPerHour = net / hours;
  const verdict = net > tbill && netPerHour >= FARM_PER_HOUR ? 'Farm' : net > 0 && netPerHour >= 1 ? 'Marginal' : 'Skip';
  return { deposit, drop, fees, hours, tbill, net, netPerHour, verdict };
}

// ---- farm plans: 10 steps, cost and time on every step ----

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

function capitalFor(p: SnapshotProtocol): number {
  return Math.round(clamp(0.0002 * p.tvl_usd, 250, 10000));
}

function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Ten steps, each derived from the protocol's own record (category, chains, TVL, age). */
export function farmSteps(p: SnapshotProtocol, age: number | null, econ: FarmEconomics, exitTvl: number): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const steps: FarmStep[] = [
    { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: `Verify ${p.name} from its own site and docs, reached from its DefiLlama page, and match the contract addresses before you approve anything. Never sign from a link sent in a message.`, cost: 'free', time: '10 minutes' },
    { text: `Move $${capital} of USDC to ${chain} for the position, by bridge or exchange withdrawal, and check it arrived before the next step.`, cost: `about $${(capital * 0.001 + 1).toFixed(2)} of bridge and withdrawal fees`, time: '15 minutes to arrive' },
    { text: `Read ${p.name}'s risk page first: note what can fail (a vault that stacks other protocols, a perp that can liquidate, a bridge that can pause) and size the position so one failure does not take the wallet.`, cost: 'free, reading only', time: '10 minutes' },
    { text: action, cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, time: '15 minutes to set up' },
    { text: `Deepen the position once: add a second deposit, a liquidity leg or a stake on a second chain the protocol counts, so the activity reads as real use rather than one deposit.`, cost: `about $${Math.max(2, Math.round(capital * 0.1))} of gas`, time: '10 minutes' },
    { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, and keep the position open between them.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Watch the exit rule: withdraw if the protocol's TVL prints below $${Math.round(exitTvl).toLocaleString('en-US')} (17% under today's $${p.tvl_usd.toLocaleString('en-US')}), or if withdrawals pause, and do not re-enter on the same week.`, cost: 'free to check', time: '5 minutes a week' },
    { text: 'Keep a farm log from the first transaction: the date, the transaction hash, the asset and its dollar value at the time, so the position is provable later.', cost: 'nothing but the log', time: '5 minutes a week' },
    { text: `Claim only from the protocol's own points or rewards page, and check the drop against the modelled $${Math.round(econ.drop).toLocaleString('en-US')}: a drop far above the model is worth a second look before it is sold.`, cost: 'about $3 of claim gas', time: '10 minutes' },
  ];
  return steps.map(stepText);
}

// ---- board ----

export interface PeerRow {
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  model_value_usd: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  listed_at: string | null;
  watchlist: boolean;
  token_odds: number;
  terminal_value_usd: number;
  implied_value_usd: number;
  peer_multiple: number;
  growth_mult: number;
  maturity_mult: number;
  breadth_mult: number;
  p25_usd: number;
  p75_usd: number;
  p10_usd: number;
  p90_usd: number;
  rank_lo: number;
  rank_hi: number;
  verdict: 'Farm' | 'Marginal' | 'Skip';
  deposit_usd: number;
  drop_usd: number;
  fees_usd: number;
  hours: number;
  tbill_usd: number;
  net_usd: number;
  net_per_hour_usd: number;
  farm_steps: string[];
  peers: PeerRow[];
}

export interface Evidence {
  fullFactor: number;
  fullNaive: number;
  fiveFold: number[];
  fiveFoldNaive: number[];
  looFactor: number;
  looNaive: number;
  walkForward: { factor: number; naive: number; cutoff: string; train: number; test: number; within3: number; covP25: number; covP10: number };
  terms: TermTest[];
  odds: OddsValidation;
  oddsTerms: OddsTermTest[];
  looCoverage: { within3: number; p25: number; p10: number };
  oddsWeights: number[];
  oddsIntercept: number;
  coefficients: ValueCoefficients;
  globalPeer: number;
  pricedCount: number;
  wfCoverageP25: number;
  wfCoverageP10: number;
  verdicts: { Farm: number; Marginal: number; Skip: number };
  topTerminal: number;
  sumImplied: number;
}

export interface Accounting {
  ranked: number;
  tradedUsable: number;
  tokenNoCap: number;
  setAside: number;
  setAsideGroups: { label: string; count: number }[];
  total: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  rows: BoardRow[];
  comps: { tvl_usd: number; mcap_usd: number; category: string | null }[];
  evidence: Evidence;
  accounting: Accounting;
  integrity: { mainTsSha256: string; totalImplied: number; watchlistRanked: number };
  coefficients: ValueCoefficients;
}

function setAsideLabel(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (p.category === 'CEX') return 'exchange custody';
  if (c.includes('liquid staking') || c.includes('liquid restaking') || c.includes('restaked btc')) return 'liquid staking';
  if (c.includes('bridge')) return 'bridge';
  if (VERSIONED.test(p.name)) return 'versioned listing';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked';
  if (EXCHANGE_PREFIXES.some((e) => p.name.startsWith(e))) return 'exchange product';
  return 'other set-aside';
}

function nearestPeers(p: SnapshotProtocol, priced: SnapshotProtocol[], asOf: string, peers: PeerMap, coef: ValueCoefficients): PeerRow[] {
  const sameCat = priced.filter((q) => q.category === p.category && q.slug !== p.slug);
  const pool = sameCat.length >= 3 ? sameCat : priced.filter((q) => q.slug !== p.slug);
  const ranked = pool
    .map((q) => {
      const f = features(q, asOf, peers);
      const modelValue = Math.max(1, Math.round(Math.exp(logTerminalBase(f, coef) + coef.scale)));
      return { q, d: Math.abs(Math.log(q.tvl_usd) - Math.log(p.tvl_usd)), modelValue };
    })
    .sort((a, b) => a.d - b.d || (a.q.slug < b.q.slug ? -1 : 1))
    .slice(0, 8);
  return ranked.map(({ q, modelValue }) => ({
    name: q.name,
    symbol: q.symbol,
    category: q.category,
    tvl_usd: q.tvl_usd,
    mcap_usd: q.mcap_usd!,
    multiple: round4(q.mcap_usd! / q.tvl_usd),
    model_value_usd: modelValue,
  }));
}

/** The whole build: fit, validate, rank, price ranges, farm economics. */
export function buildRadar(snapshot: Snapshot, mainTsSha256: string): { board: BoardRow[]; radar: RadarData } {
  const asOf = snapshot.as_of;
  const priced = snapshot.protocols.filter(isPriced);
  const peers = peerMap(priced);
  const coef = gridFit(priced, asOf, peers);

  // Hold-outs.
  const fullFactor = medianErrorFactor(priced, asOf, peers, coef);
  const fullNaive = naiveFactor(priced);
  const fiveFold: number[] = [];
  const fiveFoldNaive: number[] = [];
  for (let k = 0; k < 5; k++) {
    const test = priced.filter((p) => foldOf(p.slug) === k);
    const train = priced.filter((p) => foldOf(p.slug) !== k);
    const tp = peerMap(train);
    const tc = gridFit(train, asOf, tp);
    fiveFold.push(round2(medianErrorFactor(test, asOf, tp, tc)));
    fiveFoldNaive.push(round2(naiveFactor(test, train)));
  }
  const loo = looFactor(priced, asOf);
  const looNaive = naiveFactor(priced);
  // The printed ranges are the leave-one-out residual quantiles: the middle
  // half of the blind misses for P25-P75, the middle 80% for P10-P90.
  const quants = {
    q25: quantile(loo.residuals, 0.25),
    q75: quantile(loo.residuals, 0.75),
    q10: quantile(loo.residuals, 0.1),
    q90: quantile(loo.residuals, 0.9),
  };
  const wf = walkForward(priced, asOf, quants);
  const looCov = looCoverageFromResiduals(loo.residuals, quants);
  const terms = termTests(priced, asOf, coef);
  const oddsModel = fitOdds(snapshot.protocols, asOf);
  const oddsVal = validateOdds(snapshot.protocols, asOf);
  const oddsTerms = oddsTermTests(snapshot.protocols, asOf);

  // Board: every watchlist slug, plus every rankable pre-token protocol, by EV.
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((q) => q.slug === slug);
    if (p) chosen.set(slug, p);
  }
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }
  interface Scored {
    p: SnapshotProtocol;
    f: RowFeatures;
    terminal: number;
    odds: number;
    ev: number;
    econ: FarmEconomics;
  }
  const scored: Scored[] = [...chosen.values()].map((p) => {
    const f = features(p, asOf, peers);
    const terminal = Math.max(1, Math.round(Math.exp(logTerminalBase(f, coef) + coef.scale)));
    const odds = tokenOdds(p, asOf, oddsModel);
    const ev = Math.max(1, Math.round(terminal * odds));
    return { p, f, terminal, odds, ev, econ: farmEconomics(p, ev) };
  });
  scored.sort((a, b) => b.ev - a.ev || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap rank ranges: 200 refits of the peer multiples and scale,
  // coefficients held at the full fit. The printed value ranges come from the
  // leave-one-out residuals above, not from this bootstrap.
  const rng = mulberry32(BOOTSTRAP_SEED);
  const rankSamples: number[][] = scored.map(() => []);
  for (let r = 0; r < BOOTSTRAP_REFITS; r++) {
    const sample: SnapshotProtocol[] = [];
    for (let i = 0; i < priced.length; i++) sample.push(priced[Math.floor(rng() * priced.length)]!);
    const sp = peerMap(sample);
    const residuals = sample.map((q) => {
      const f = features(q, asOf, sp);
      return Math.log(q.mcap_usd!) - logTerminalBase(f, coef);
    });
    const scale = median(residuals);
    const terms = scored.map((s, i) => {
      const f = features(s.p, asOf, sp);
      const t = Math.max(1, Math.round(Math.exp(logTerminalBase(f, coef) + scale)));
      return { i, ev: t * s.odds };
    });
    terms.sort((a, b) => b.ev - a.ev || (scored[a.i]!.p.slug < scored[b.i]!.p.slug ? -1 : 1));
    terms.forEach((t, pos) => rankSamples[t.i]!.push(pos + 1));
  }

  const verdicts = { Farm: 0, Marginal: 0, Skip: 0 };
  const board: BoardRow[] = scored.map((s, i) => {
    verdicts[s.econ.verdict]++;
    const ranks = rankSamples[i]!;
    const p25 = Math.max(1, Math.round(s.terminal * Math.exp(quants.q25) * s.odds));
    const p75 = Math.max(1, Math.round(s.terminal * Math.exp(quants.q75) * s.odds));
    const p10 = Math.max(1, Math.round(s.terminal * Math.exp(quants.q10) * s.odds));
    const p90 = Math.max(1, Math.round(s.terminal * Math.exp(quants.q90) * s.odds));
    const rankLo = Math.min(...ranks);
    const rankHi = Math.max(...ranks);
    const age = ageDays(asOf, s.p.listed_at);
    const exitTvl = s.p.tvl_usd * 0.83;
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      age_days: age,
      listed_at: s.p.listed_at,
      watchlist: snapshot.watchlist.includes(s.p.slug),
      token_odds: round4(s.odds),
      terminal_value_usd: s.terminal,
      implied_value_usd: s.ev,
      peer_multiple: round4(s.f.peer),
      growth_mult: round4(Math.exp(coef.a * s.f.logGrowth)),
      maturity_mult: round4(Math.exp(coef.b * s.f.logMaturity)),
      breadth_mult: round4(Math.exp(coef.c * s.f.breadth)),
      p25_usd: p25,
      p75_usd: p75,
      p10_usd: p10,
      p90_usd: p90,
      rank_lo: rankLo,
      rank_hi: rankHi,
      verdict: s.econ.verdict,
      deposit_usd: s.econ.deposit,
      drop_usd: round2(s.econ.drop),
      fees_usd: round2(s.econ.fees),
      hours: round2(s.econ.hours),
      tbill_usd: round2(s.econ.tbill),
      net_usd: round2(s.econ.net),
      net_per_hour_usd: round2(s.econ.netPerHour),
      farm_steps: farmSteps(s.p, age, s.econ, exitTvl),
      peers: nearestPeers(s.p, priced, asOf, peers, coef),
    };
  });

  // Accounting: every one of the 758 protocols in exactly one group.
  const rankedSlugs = new Set(board.map((r) => r.slug));
  const tokenNoCap = snapshot.protocols.filter((p) => !rankedSlugs.has(p.slug) && !isPriced(p) && hasToken(p)).length;
  const setAsideRows = snapshot.protocols.filter((p) => !rankedSlugs.has(p.slug) && !isPriced(p) && !hasToken(p));
  const groups = new Map<string, number>();
  for (const p of setAsideRows) {
    const label = setAsideLabel(p);
    groups.set(label, (groups.get(label) ?? 0) + 1);
  }
  const setAsideGroups = [...groups.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
  const accounting: Accounting = {
    ranked: board.length,
    tradedUsable: priced.length,
    tokenNoCap,
    setAside: setAsideRows.length,
    setAsideGroups,
    total: board.length + priced.length + tokenNoCap + setAsideRows.length,
  };

  const evidence: Evidence = {
    fullFactor: round2(fullFactor),
    fullNaive: round2(fullNaive),
    fiveFold,
    fiveFoldNaive,
    looFactor: round2(loo.factor),
    looNaive: round2(looNaive),
    walkForward: { factor: round2(wf.factor), naive: round2(wf.naive), cutoff: wf.cutoff, train: wf.train, test: wf.test, within3: wf.within3, covP25: wf.covP25, covP10: wf.covP10 },
    terms,
    odds: oddsVal,
    oddsTerms,
    looCoverage: looCov,
    oddsWeights: oddsModel.weights.map(round4),
    oddsIntercept: round4(oddsModel.intercept),
    coefficients: { beta: coef.beta, a: coef.a, b: coef.b, c: coef.c, scale: round4(coef.scale) },
    globalPeer: round4(peers.global),
    pricedCount: priced.length,
    wfCoverageP25: wf.covP25,
    wfCoverageP10: wf.covP10,
    verdicts,
    topTerminal: board[0]!.terminal_value_usd,
    sumImplied: board.reduce((s, r) => s + r.implied_value_usd, 0),
  };

  const earlySize = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlySize,
    rows: board,
    comps: priced.map((p) => ({ tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, category: p.category })),
    evidence,
    accounting,
    integrity: {
      mainTsSha256: mainTsSha256,
      totalImplied: evidence.sumImplied,
      watchlistRanked: board.filter((r) => snapshot.watchlist.includes(r.slug)).length,
    },
    coefficients: { beta: coef.beta, a: coef.a, b: coef.b, c: coef.c, scale: round4(coef.scale) },
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
