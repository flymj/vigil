# Dream local acceptance — 2026-07-18

This release gate ran only against a local, isolated VIGIL configuration and workspace. It did not read or change the remote deployment configuration.

## Verification matrix

| Gate | Result |
| --- | --- |
| Dream Python validator | 10 passed |
| Full Node regression suite | 91 passed after final browser fix |
| Production Vite build | passed; only the pre-existing large-chunk advisory remains |
| Local headless browser | passed on desktop and 390 × 844; no console/browser errors or horizontal overflow |
| Source | `github.com/vllm-project/vllm@main` |
| Closed horizon | `[2026-07-16T16:00:00.000Z, 2026-07-17T16:00:00.000Z)` / `Asia/Shanghai` |
| Durable Window | `published` — 42 commits, 10 pull requests, 173 issues, 0 releases |
| Trial ceilings | 1 Signal change, 1 Topic change, 1 evidence expansion request |
| Accepted run | `run-77dcb3a7-05c6-4a81-9153-914f1e86a918` / `findings` / `committed` |
| Idempotent replay | same run ID, attempt 1, no new entity or revision |

## Result

Dream accepted one active Signal:

> KV Offloading subsystem hardening: race fix, chunked config, tier locality, and observability

The Signal has six evidence references and a validated forecast. The Provider proposed no Topic. Its recorded decision was that a first-run, single self-contained Signal did not yet justify cross-Signal synthesis or additional mechanism depth; creating a Topic would merely expand the Signal title into prose. This is the intended zero-Topic result under the v2.1 contract, not a failed attempt to reach the trial ceiling.

The browser gate rendered the accepted Signal, the honest zero-Topic state, Window archive, Dream settings, and readiness diagnostics. A separate disposable fixture ledger verified keyboard navigation from Signal to linked Topic with `Enter` and back to the linked Signal with `Space`; it did not alter the real acceptance ledger.

## Failure-path evidence from the trial

The first Provider attempt returned a Scout document with self-invented field names. Schema and Host-context validation rejected it at `scout`; no Signal, Topic, evidence, or cursor mutation occurred.

After the exact Scout and batch schemas were embedded in the runtime prompt, the next synthesis returned a JSON document inside a Markdown fence and included a suppression group inconsistent with Host duplicate lineage. Strict parsing and semantic validation rejected it at `synthesis`; the raw rejected response was retained only in authenticated run audit, and the ledger remained empty.

The final implementation permits one complete regeneration after structured-output validation failure. It never strips a fence, fills fields, changes an ID, or repairs the first document. The regenerated batch passed schema, semantic, context, evidence, fingerprint, and transaction checks before commit.

## Reproduction

Use a separate temporary root and point `VIGIL_ACCEPTANCE_SOURCE_CONFIG` at a local VIGIL config that already has a real watchlist and Provider credentials:

```bash
acceptance_root=$(mktemp -d /tmp/vigil-dream-acceptance.XXXXXX)
VIGIL_ACCEPTANCE_ROOT="$acceptance_root" \
VIGIL_CONFIG_DIR="$acceptance_root/config" \
VIGIL_ACCEPTANCE_SOURCE_CONFIG="/path/to/local/vigil/config" \
VIGIL_ACCEPTANCE_KEEP=1 \
node scripts/dream-local-acceptance.mjs
```

The script copies credential ciphertext only into the isolated temporary config, prints no credential material, switches the acceptance watch to on-demand collection, disables Provider use for Window summarization, and uses the Provider only for the two bounded Dream stages. It always scrubs copied Provider/GitHub credential files before exit; in keep mode it leaves a secret-free read-only inspection configuration. Remove the temporary root after browser/API inspection.
