// Launch-Odds Radar v5 — the entrypoint (Node 22, standard library only).
//
// Reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>),
// scores every pre-token protocol with the model in lib/model.ts, writes the
// ranked board to /output/board.json, and copies this repository's dashboard/
// and screenshots/ to /output. Last, it writes /output/dossier.json, the
// summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/
// reads /output/data.js, which this program writes from the same board.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// The integrity strip shows this file's own checksum: the dashboard names it,
// and the repository holds the bytes it names.
const mainTsSha256 = createHash('sha256').update(readFileSync(join(here, 'main.ts'))).digest('hex');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot, mainTsSha256);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const ev = radar.evidence;
const acc = radar.accounting;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${ev.pricedCount} priced comps)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n` +
    `token radar: value model beta=${ev.coefficients.beta} a=${ev.coefficients.a} b=${ev.coefficients.b} c=${ev.coefficients.c} scale=${ev.coefficients.scale} peer=${ev.globalPeer}x\n` +
    `token radar: held-out miss full x${ev.fullFactor} (naive x${ev.fullNaive}), 5-fold x${ev.fiveFold.join('/')} (naive x${ev.fiveFoldNaive.join('/')}), LOO x${ev.looFactor}, walk-forward x${ev.walkForward.factor} (naive x${ev.walkForward.naive}, ${ev.walkForward.train} older price ${ev.walkForward.test} newer)\n` +
    `token radar: range honesty (walk-forward) P25-P75 ${ev.wfCoverageP25}% P10-P90 ${ev.wfCoverageP10}% of later caps; odds AUC ${ev.odds.auc} Brier ${ev.odds.brier} vs base ${ev.odds.baseBrier}, accuracy ${ev.odds.accuracy} at 0.5 (base rate ${ev.odds.baseRate})\n` +
    `token radar: verdicts Farm ${ev.verdicts.Farm} / Marginal ${ev.verdicts.Marginal} / Skip ${ev.verdicts.Skip}; accounting ${acc.ranked}+${acc.tradedUsable}+${acc.tokenNoCap}+${acc.setAside}=${acc.total}\n` +
    `token radar: top ${board[0]!.name} EV $${board[0]!.implied_value_usd.toLocaleString('en-US')} net $${board[0]!.net_usd.toLocaleString('en-US')} (${board[0]!.verdict}); main.ts sha256 ${mainTsSha256.slice(0, 16)}…\n`,
);
