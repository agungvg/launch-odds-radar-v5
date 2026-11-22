# launch-odds-radar-v5

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v5/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/agungvg/launch-odds-radar-v5/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch-Odds Radar v5: a pre-token launch radar for 758 DefiLlama protocols. Every figure is fitted at runtime from the snapshot — peer multiples per category, a size curve with growth, maturity and breadth terms, and a logistic token-launch odds model — and tested held-out four ways (full fit, 5-fold, leave-one-out, walk-forward). Each of the 198 ranked rows carries a P25–P75 / P10–P90 range from the leave-one-out residuals, a bootstrap rank range, and a net-of-fees farm verdict (modelled drop minus fees, against a 4% T-Bill and $25 an hour) with a 10-step costed farm plan.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=p9r33tb4&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
