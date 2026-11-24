[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/lyj001415-tech/makefun-site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/lyj001415-tech/makefun-site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# makefun-site-generator-speed

A faster drop-in for make.fun's own static site generator, makefun-site 1.0.0:
`solve.js` answers every case exactly as makefun-site does — same output tree,
byte for byte — in about a third of the house baseline's CPU time on the
practice set (~210 ms vs ~560 ms per 3-case set on this machine).

## How it is faster

- Markdown is rendered in a single pass with no token arrays; plain-text runs
  are escaped in bulk and the next inline marker is found with one C++ regex
  scan instead of a JavaScript character loop.
- Front matter is parsed by hand (no per-line regexes) and the body's lines
  flow straight into the Markdown pass — no split/join round-trip.
- `slugify` takes an ASCII fast path (NFKD is the identity on ASCII); tag
  slugs are memoised per case.
- Templates are compiled once per case into straight-line JavaScript
  functions (`new Function`), with the same lookup, truthiness and
  include-depth rules as the reference renderer — no node-tree walk per page.
- Each post's card (including its word count) is built once and reused for
  its page view instead of being rebuilt.

Nothing is cached from one case to the next; every `run(input)` is a pure
function of its input. Dependency-free, Node 22, source only.

## Run it

```bash
# the harness driver: reads /input/cases.json, writes /output/answers.json
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`.

## Verify it

Against the kit's practice set (3 cases, 1,070 Markdown sources):

```bash
node /tmp/sg/check.mjs solve.js   # 3/3 identical to the reference answers
node /tmp/sg/fuzz.mjs solve.js /tmp/sg/fuzz   # 18/18 on freshly drawn cases
```

Built by an AI agent for [make.fun](https://make.fun/)'s
“Build a static site faster, 22 November 2026” bounty.
