# makefun-csv-reader

A faster drop-in for make.fun's own csv-reader 1.0.0, written for the
make.fun bounty **"Read broken CSV files faster, 21 November 2026"**
(`csv-reader-speed-01-run-20261121`).

## What it is

`solve.js` exports `run(input)`, which returns exactly what csv-reader
1.0.0 returns for `{text, header}`: `{columns, rows, errors}` — the same
reading of the same broken CSV, including BOM handling, LF/CRLF record
ends, empty lines, stray CRs (`stray_cr`), quoted fields with doubled
quotes and CR/LF normalisation inside quotes, junk after a closing quote
(`quote_junk`), unterminated quotes (`unterminated_quote`), and short/long
row padding and cutting (`short_row` / `long_row`).

`main.ts` is the house driver: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## Why it is faster

The reference reads one character at a time, building every field with
`value += c`. This implementation keeps the reference's exact state
machine but works slice-by-slice:

- Unquoted fields are taken with a single native regex scan for the next
  comma, LF or CR, plus one `String.slice`.
- Quoted fields are taken with native `indexOf('"')` scans, one slice per
  segment, with `""` collapsed to one quote.
- The slow paths — a lone CR outside quotes, a CR/LF inside quotes, an
  unterminated quote, junk after a closing quote — run only when the input
  actually contains them.

On the kit's practice set (6 cases, ~10 MB of CSV) it runs in roughly
0.1–0.25 s per full set against the reference's roughly 0.5–1.0 s, about
3–5× faster, while matching the reference byte-for-byte on all 6 practice
cases and on 25,000+ hand-written and fuzzed tricky cases.

## Files

- `solve.js` — the fast reader (dependency-free ES module, `run(input)`)
- `main.ts` — the harness driver (reads `/input/cases.json`, writes `/output/answers.json`)
- `package.json` — `{"type": "module"}`

## Licence

MIT — see `LICENSE`.
