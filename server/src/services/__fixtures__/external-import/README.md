# External-import parser fixtures

Golden-file regression tests for [`parseExternalFile`](../../externalImportService.ts)
— the parser that ingests **arbitrary coach Excel files** (Feature 4a). It is the
core feature and the most exposed to messy real-world input, so its behaviour is
pinned here.

Driven by [`externalImportFixtures.test.ts`](../../externalImportFixtures.test.ts).

## What's in here

- `*.xlsx` — the fixture spreadsheets (committed binaries).
  - **Synthetic** ones are authored in the test (`SYNTHETIC` array) and written to
    disk automatically; they deliberately stress merged banners, units in cells,
    Swedish decimals, RIR→RPE, % loads, bodyweight, rep ranges, AMRAP, offset/aliased
    headers, and weekday day-labels.
  - **Real** coach files: just drop a `.xlsx` in this folder (see below).
- `*.expected.json` — the golden parse output for each `.xlsx`. A diff here on a
  future run means a parser change altered how that sheet is read.

## Dropping a real coach file

1. Copy the `.xlsx` into this folder (any name that isn't a synthetic fixture).
2. Run the tests. The file is **auto-discovered** and smoke-tested: it must parse
   without throwing and find at least one exercise.
3. To lock it in as a regression case, generate its golden:

   ```sh
   cd server && UPDATE_FIXTURES=1 node scripts/run-tests.cjs run src/services/externalImportFixtures.test.ts
   ```

   Review the new `*.expected.json`, confirm it reflects how the sheet *should*
   parse, and commit both files. From then on any drift fails the test.

> Real coach files may contain athlete names — only commit ones you're comfortable
> keeping in the repo, or scrub identifying cells first.

## Regenerating goldens after an intentional parser change

```sh
cd server && UPDATE_FIXTURES=1 node scripts/run-tests.cjs run src/services/externalImportFixtures.test.ts
```

Then **review the `*.expected.json` diff** — it is the human check that the change
was intended — and commit.
