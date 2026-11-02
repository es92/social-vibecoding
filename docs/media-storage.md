# Platform media storage

The implementation is in `src/services/media-store.js`. It shares the S3
transport in `app-files.js`, with separate configuration:

- `MEDIA_STORAGE_ENDPOINT`: scheme and host, such as `http://usernode-minio:9000`.
- `MEDIA_STORAGE_BUCKET`: the provisioned media bucket.
- `MEDIA_STORAGE_ACCESS_KEY` and `MEDIA_STORAGE_SECRET_KEY`: that bucket's keys.

There is no fallback to app-file settings or to writing bytes in Postgres.
The media bucket must already exist. Production provisioning also enables
versioning and seven-day expiry of noncurrent versions; the application
does not silently recreate an absent bucket without those protections.

## Upload and reference

Objects use the shared `media/sha256/<hex>` layout. Call
`put(tx, store, buffer, contentType)` inside the **same transaction** as the
row that will reference its returned key. `tx` is a checked-out database
client, not a pool. Do not commit between the upload and the reference.
Upload failure aborts the transaction. Retrying an existing object does not
rewrite it or create another billable version.

Storage I/O inside a transaction sends a serialized database heartbeat every
10 seconds, keeping the registry lock alive under the production idle guard.
Each storage wait has a two-minute deadline that aborts its MinIO HTTP requests.
A checked-out client disconnect rejects that operation instead of becoming an
unhandled process error; the caller rolls back and workflow work can retry.
The same guard covers cleanup's storage calls. Global database timeouts stay
unchanged, and a stalled upload rolls back the reference transaction.

Every key column must have an immediate foreign key to
`media_objects(object_key)`, with the ordinary restrictive delete behavior.
Index that referencing column so the cleanup foreign-key check is bounded.
This small registry stores no bytes; it is the lock that protects an upload
or a new reference from concurrent cleanup, across all migrated tables.

`bytes(store, row)` requires an `object_key` and reads that object. Missing
keys and storage failures propagate; there is no database-byte fallback.
HTTP readers can use `stream(store, key, range)` to pass an already-validated
inclusive byte range to S3 without reading the whole object. Routes retain
their own access checks, ETags, and cache headers.

## Cleanup

The workflow clock's `media-gc` job runs one bounded listing page every five
minutes. Its result keeps the cursor for the next run. It examines only this
store's prefix and only objects more than a day old, including uploads whose
database transaction rolled back.

For each candidate it locks the registry key, rechecks the object's age,
and attempts to delete the registry row. A foreign-key refusal means some
table still references the object: the object is left alone. Otherwise it
deletes the object before committing the registry deletion. A provider
failure rolls back that deletion and fails the work, so the clock retries.
An upload arriving behind cleanup waits for the lock and recreates the
object before it commits any reference.
An ordinary reference lookup avoids locking an owner's row during cleanup;
retakes take source-row locks before registry-key locks, preserving the
lock order across concurrent saves and cleanup.

## Local checks

`tests/lib/media-store.js` supplies the in-memory store for ordinary unit
tests. `tests/media-store-postgres.test.js` exercises real transaction races
in its own temporary database; set `TEST_DATABASE_URL` to a local disposable
Postgres server to require it.

`tests/media-store-minio.test.js` makes and removes a temporary versioned
bucket on the existing `usernode-minio` service (or a disposable instance):
set `TEST_MEDIA_STORAGE_ENDPOINT` to its local endpoint, plus
`TEST_MEDIA_STORAGE_ACCESS_KEY` and `TEST_MEDIA_STORAGE_SECRET_KEY` to local
test credentials. It checks ranged reads and that retries create one version.
These test variables are separate from production settings.

Run the suites covering a branch with:

```sh
npm run test:changed -- --base <exact-base-sha>
```

## Rollout and final column removal

The original readers/schema shipped in #6050 (with release fix #6064), then
both writers and workflow backfills in #6051. #6066 bounded transaction
storage waits. Both backfills report `done: true`, and all six tables have
zero remaining byte rows, verified read-only on 1 and 2 November 2026.
The former check-visual PRs #6052/#6053 were superseded by #6050/#6051.

This cleanup release removes the per-row byte fallback, all runtime SQL
references to byte columns, and both completed backfill modules/jobs. The
workflow's normal release reconciliation retires clocks absent from JOBS;
no manual workflow-row deletion or production command is needed. Staging
fixtures upload fake media and commit its key in the same transaction as
their reference. Previews have no production bucket credentials: their
small fake files use `staging-media-store.js` inside the preview container,
recreated idempotently by those seeds on every boot. Production always
uses the configured S3 store. Unit tests inject an in-memory store.

**Column removal must be a subsequent release.** The migration hook runs
at sync wave -1, before web/conductor replacement. The previous release
still selects `data` and writes explicit NULL byte columns, even for keyed
rows. Dropping them in this release's pre-deployment migration would break
those old processes during the rolling update.

After this release is fully deployed, including the last draining process:

1. Verify no remaining process runs code that references byte columns and
   both removed backfill clocks are retired. Recheck that all six tables
   still have zero byte rows and no missing normal keys.
2. Add the next tracked SQL migration (never edit the immutable baseline).
   Refuse the migration if any bytes remain or any required key/metadata
   is missing; preserve every object key, FK and index. Drop `data` from
   `shot_run_files`, `shot_artifacts`, `shots_eval_artifacts`,
   `shot_diagnostic_artifacts`, `check_run_media`, `session_visuals`, and
   `dense_data` from the first two. Replace constraints that depend on the
   dropped columns with key-only invariants, including required normal
   keys, visual metadata, and density/original consistency.
3. Update tests and the preview schema policy as needed. Verify fresh and
   existing database migration paths; the cleanup's PostgreSQL media and
   staging suites already exercise real code after removing the columns
   in a disposable database.
4. Deploy that migration release; Bruno schedules `VACUUM FULL` afterwards
   at a quiet time. It locks the tables and is separate operator maintenance.

After the column drop, roll forward with compatible code. An older image
is not a schema down-migration. No merge, deployment, or maintenance is
authorized by these notes.

## Shots

The shots integration includes both densities in `shot_run_files` and
`shot_artifacts`, plus `shots_eval_artifacts` and `shot_diagnostic_artifacts`.
New saves upload first and write keys in their existing transaction.
Publication and eval publication copy keys without S3 I/O. Normal and dense
objects remain referenced independently, and both retain their existing
metadata, access gates, and retention rules. Dense originals are retained
as Bruno approved on 30 October.

## Check visuals

`check_run_media` holds a run's media until the preview machine publishes it
to `session_visuals`. Both tables have an indexed restrictive registry FK,
SHA-256, size and the old full-response ETag. Publication copies the key and
metadata, preserving the artifact ID and its `/visuals/:id` URL. The GC's
ordinary reference lookup covers both tables, so it never takes a row lock
on a visual while its replacement waits for that key.

Unlike the shots endpoint, `/visuals/:id` used Express weak SHA-1 ETags, not
SHA-256. Full responses retain that exact validator and stream from storage;
matching conditional requests and HEAD need no object read. Range requests
pass their offsets to S3 and buffer **only the requested range** to retain
Express's old ETag of the sliced body (artifacts are capped at 8 MB). This
preserves status, headers, malformed-range behavior and conditional 304s
without downloading a whole video for a small range. SHA-256 remains the
shared object identity. The anonymous GitHub camo route stays on Homeroom.

Bruno approved retaining merged check visuals indefinitely on 30 Oct.
They remain referenced by their published rows and have no age-based media
expiry. Existing explicit row replacement and parent-deletion behavior is
unchanged; moving bytes does not introduce a new retention policy.

The writer release uploads every kept capture before committing its key,
hash, size and full-response validator. Its existing replacement transaction
locks the session and old rows before registry keys. Upload or insert failure
rolls back the replacement; any orphaned upload is left to `media-gc`.

Both historical backfills are complete and removed from this build. IDs,
timestamps, capture provenance, merged history and the old full-body ETag
survive the migration.
