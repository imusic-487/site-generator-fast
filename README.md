# Fast makefun-site drop-in

[![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/imusic-487/site-generator-fast/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/imusic-487/site-generator-fast/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)

A faster drop-in for makefun-site 1.0.0: `solve.js` returns byte-for-byte the
same output tree as makefun-site's `build()` for every input, in about a third
of the CPU time (median ~3.5x faster than the house baseline on the practice
set, measured side by side in-process).

## What this repo does

This is an entry for the make.fun bounty
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
("Build a static site faster, 22 November 2026"). `main.ts` reads every case
from `/input/cases.json`, answers each with `run()` from `solve.js`, and writes
`/output/answers.json`. `solve.js` is a dependency-free ES module that
re-implements makefun-site's build with the same semantics:

- the same front-matter grammar and refusal reasons, in the same order;
- the same slug rule (NFKD, combining marks dropped), permalink uniqueness,
  collections, tags and report;
- the same Markdown subset (fences, ATX headings with unique ids, hr,
  blockquotes, flat lists, paragraphs; code spans, strong, emphasis, links
  and backslash escapes) and the same link resolution and broken-link report;
- the same template dialect (`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
  `{% include %}`, standalone-tag line swallowing, include depth 8).

## How it is faster

- Slugs are cached per run, with a fast ASCII path (ASCII is NFKD-stable).
- HTML escaping takes a fast path when a string holds no special character.
- Markdown is lexed and rendered in one fused pass; inline rendering is
  scanned by a native regex instead of a per-character loop, and the
  strong/emphasis/link closers are found with `indexOf` plus a backslash-run
  parity check instead of a character scan.
- Front matter is scanned by `indexOf` and the body is taken as a slice.
- Word counting scans whitespace runs natively instead of building a match
  array; each page's card is computed once and reused.
- Templates are parsed once per run, includes are inlined, and every path's
  first name is resolved statically to a frame slot, so rendering walks no
  scope chain. (If a template's include tree is cyclic or deeper than the
  reference's depth cutoff allows, the run falls back to a scope-chain
  interpreter with identical semantics.)

No state is kept between `run()` calls: every cache is created fresh inside
`run()`, so each case is answered alone.

## Verification

- Practice set: 3/3 cases identical to the reference, answers
  byte-identical to the house baseline's output.
- Differential test against the house baseline on 36 further sites drawn
  from the kit's own generator (12 seeds x 3 cases): 0 mismatches.
- Inline fuzz: 443 hand-picked and random tricky Markdown bodies
  (nested/escaped `*`, backticks, links, backslashes): 0 mismatches.

## Files

- `solve.js` — the fast implementation (`run(input)`).
- `main.ts` — the harness driver (reads `/input/cases.json`, writes
  `/output/answers.json`).
- `README.md` — this file.
- `LICENSE` — MIT license.
- `.makefun/owner.json` — the owner's payout wallet.
