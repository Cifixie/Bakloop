# S3 as content source of truth

**Fork:** shared substrate (Fork A owns the Sources-table changes).
**Queue position:** first. Everything else in the Phase 2/3 queue either
points into this layer or wants somewhere durable to point.
**Status:** not started.

## Why this first

Three independent pressures land on the same change:

1. **SourceHealth's periodic recheck needs a durable original to compare
   against.** If a page paywalls or rots six weeks after ingestion, the only
   copy of the real content is whatever we stored — and today that's an inline
   DynamoDB attribute we've never treated as an archive.
2. **The extraction structure needs a stable input.** `KeyPoints` /
   `Statistics` / `QuoteBlocks` / `Themes` are computed once and cached; if
   the input they were computed from is not addressable, they can't be
   recomputed when the extraction prompt changes.
3. **The `Sources` item is already straining.** `content` sits inline
   alongside a multi-hundred-float `embedding`, which is why
   `lib/dynamo.ts`'s scan helper carries an explicit warning to always pass
   `projectionExpression` — a single page of an unprojected scan holds only a
   handful of sources. Moving content out makes the table what Fork A
   actually needs it to be: an index.

Note this is **not** the parked S3 Glacier lifecycle item. That one is a
cost-optimization policy layered on top of storage that already lives in S3.
This is the storage architecture that would have to exist first. See
`plans/PARKED.md`.

## Shape

One new bucket, keyed by `contentHash` so the key is derivable from the
Sources PK and needs no extra index:

```
s3://<bucket>/sources/<contentHash>/raw.<ext>        # exactly what the fetcher returned
s3://<bucket>/sources/<contentHash>/extracted.md     # normalized text used by generation
s3://<bucket>/sources/<contentHash>/extraction.json  # KeyPoints/Statistics/QuoteBlocks/Themes
```

- `raw` keeps the fetcher's original bytes, including HTML. This is the
  permanent archive — the thing that survives the origin URL dying, and the
  thing a future re-extraction (better prompt, better parser) reads from.
- `extracted.md` is the derived text the generation paths consume today as
  `content`.
- `extraction.json` is written by `plans/extraction-and-tldr.md`, not by this
  plan. It's listed here so the key layout is decided once.

CDK: a `Bucket` in `bookmark-digest-stack.ts` with
`RemovalPolicy.RETAIN`, versioning on (a bad re-fetch shouldn't destroy the
archive), S3-managed encryption, and `blockPublicAccess: BLOCK_ALL`. No
lifecycle rules in this plan — that's the parked Glacier item, and adding a
transition now would be guessing at an access pattern nobody has measured.

Sources item gains: `contentS3Key`, `rawS3Key`, `contentBytes`. It keeps
`content` for now — see the transition below.

## Open question, resolved: replace or run alongside?

The handoff (§10) left this to be proposed here. **Recommendation: run
alongside, behind one accessor, then backfill and drop the inline copy.** Not
a big-bang cutover.

Concretely, in this order:

1. **Add the write.** `ingest-url` writes `raw` + `extracted.md` to S3 and
   stores `contentS3Key`/`rawS3Key` on the item, _while still writing
   `content` inline_. Nothing reads S3 yet. This step is independently
   deployable and reversible.
2. **Add one seam.** A single `getSourceContent(item)` helper in
   `apps/infra/lib/source-content.ts`: prefer `contentS3Key` when present,
   fall back to inline `content`. Every consumer goes through it — today that
   is `generate-digest`, `embed-source`, and `fetch-source`. Grep for
   `.content` on a source item before declaring the list complete; the seam is
   worthless if one caller keeps reading the attribute directly.
3. **Backfill.** A script in `apps/infra/scripts/` walks `Sources`, writes
   inline `content` to S3 for items lacking `contentS3Key`, and sets the key.
   Pattern-match `scripts/backfill-source-metadata.ts`, which already does a
   projected scan + conditional update over this table.
4. **Drop the inline copy.** Only once step 3 reports zero remaining items
   _and_ the seam has run in production long enough to trust: a second pass
   `REMOVE`s `content`. Separate deploy, separate day. This is the
   irreversible step and the only one worth being slow about.

Why alongside rather than a cutover: the fallback in step 2 costs about four
lines, and it makes steps 1 and 3 individually shippable without a
coordinated deploy. A cutover would need the backfill to complete before any
reader deploys, which is exactly the "no way to wait for backfill to finish"
failure that got the native vector index reverted. Don't rebuild that
sequencing trap in a different service.

## Constraints and traps

- **`fetch-source` returns content to the browser.** Once content is in S3,
  the Lambda either proxies the object or returns a presigned GET. Prefer
  presigned — proxying a large article through API Gateway's response buffer
  is the same class of problem as the parked streaming item. Either way the
  Lambda needs `s3:GetObject`, and the route surface must not change.
- **Adding an S3 write to `ingest-url` does not need a new route.** But if
  file upload lands (`plans/source-health.md`) it _does_ — and per
  `wiki/gotchas.md`, a new API Gateway resource needs an explicit
  `.addResource().addMethod()`, not just a Lambda plus IAM. Diff the API
  surface, not only the Lambda/IAM diff.
- **The DynamoDB Stream still triggers embedding.** `embed-source` reads
  content; once it reads from S3, the stream event no longer carries the
  content it needs, so it must fetch by key. `embed-source` already skips
  non-`embedding` stream events — keep that guard, and check the ordering
  assumption: the S3 object must be written _before_ the item that points at
  it, or the stream can fire against a key that isn't there yet.
- **Versioning changes what "the archive" means.** A re-fetch after a
  SourceHealth recheck writes a new version rather than overwriting. Decide
  in `plans/source-health.md` whether the recheck stores a new version or a
  distinct key; don't decide it implicitly here.

## Local-model fit

Good candidates for the local model: the `getSourceContent` seam and its
tests, the key-layout helpers, the backfill script's pure paging/transform
logic. Keep the CDK bucket + IAM grants, the presigned-URL decision in
`fetch-source`, and the drop-inline-copy pass on Claude/Pi — per
`wiki/gotchas.md` those are exactly where silent failures have slipped
through before.
