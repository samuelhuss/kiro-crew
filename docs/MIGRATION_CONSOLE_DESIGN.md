# Migration Console — Design & Structure

A minimal single-page frontend to run and visualize the full migration pipeline
(cross-region AND cross-account), served by the existing `node:http` API.

## Goals

- See the WHOLE process visually: source → target, resources, pipeline stages, execution progress
- Cross-account support (Option B: separate STS credentials for source and target)
- Preview the faithful CloudFormation before deploying
- Real-time execution progress (SSE)
- No web framework — vanilla HTML/JS + the existing node:http server

## Architecture

```
Browser (dashboard Browser panel @ 127.0.0.1:PORT)
   │  static index.html + fetch/SSE
   ▼
api/server.ts  (node:http, extended)
   ├── GET  /                         → serve public/index.html
   ├── GET  /health                   → { status: ok }
   │
   ├── POST /api/discover             → scan_region + build_graph  (source creds)
   │        body: { sourceRegion, sourceCreds }
   │        resp: { sessionId, resourceCount, clusters[] }
   │
   ├── GET  /api/clusters/:sessionId  → application clusters (connected components)
   │
   ├── POST /api/plan                 → assessment + faithful CFN + data plan
   │        body: { sessionId, scopedResourceIds[], targetRegion, targetAccountId?, isCrossAccount }
   │        resp: { planId, phases[], manifest, cfnTemplates[], migrationCost }
   │
   ├── GET  /api/plan/:planId         → full plan detail (CFN YAML, manifest md)
   │
   ├── POST /api/execute              → START execution (returns immediately)
   │        body: { planId, targetCreds, approved: true }
   │        resp: { executionId }
   │
   └── GET  /api/execute/:executionId/stream  → SSE stream of phase progress
            events: phase_start, phase_progress, phase_complete, phase_failed, done
```

## Frontend layout (public/index.html)

Single file, three panels:

1. **Setup** — source (region + creds) / target (region + account + creds) / "Discover"
2. **Plan** — resource cluster picker, pipeline stage tracker (Discovery→Graph→Assessment→CFN),
   cost badge, "View CloudFormation" / "View Manifest" buttons, "Plan" button
3. **Execute** — approval gate (shows CFN), then phase-by-phase progress bars fed by SSE,
   with Execute / Rollback buttons

Styling: minimal, dark-mode aware (CSS custom properties), no external CDN needed
(inline the small amount of CSS/JS). Uses fetch + EventSource only.

## Cross-account specifics (Option B — separate credentials)

- The Setup panel has TWO credential blocks: SOURCE and TARGET (each: access key,
  secret, session token, region).
- Backend keeps them per-session (in memory only, never written to disk).
- Data phase: source creds create/share the AMI/snapshot; target creds copy it in.
- Compute phase: `aws cloudformation deploy` runs with TARGET creds.
- AMI/snapshot SHARE step added before COPY (modify-image-attribute /
  modify-snapshot-attribute --launch-permission / --create-volume-permission with the
  target account ID).

## New backend modules to build (later, when memory frees)

| File | Responsibility |
|------|----------------|
| `api/routes/discover.ts` | scan + graph, return clusters |
| `api/routes/plan.ts` | assessment + faithful CFN + data plan + manifest |
| `api/routes/execute.ts` | orchestrate execution phases, emit SSE |
| `api/execution/executor.ts` | run AWS CLI per phase (deploy, create-image, copy, share) |
| `api/execution/cross-account.ts` | AMI/snapshot share + dual-credential handling |
| `public/index.html` | the single-page console |
| `public/app.js` | fetch/SSE client logic |
| `public/style.css` | minimal styling |

## Security notes

- Credentials live ONLY in server memory for the session; never persisted, never logged.
- Server binds 127.0.0.1 only.
- SOURCE is never modified (create-image/snapshot are non-destructive; share is a permission grant).
- Execution requires explicit `approved: true` in the POST body.
- Rollback = delete target stacks.

## Data-migration cross-account sequence (per stateful resource)

```
EC2:
  [source creds] create-image → wait available
  [source creds] modify-image-attribute --launch-permission Add=Account:<target>
  [source creds] (for each snapshot in the AMI) modify-snapshot-attribute --create-volume-permission Add=<target>
  [target creds] copy-image --source-region <src> (now visible to target)
  [target creds] deploy compute stack referencing the copied AMI

EBS:
  [source creds] create-snapshot → modify-snapshot-attribute (share with target)
  [target creds] copy-snapshot

RDS:
  [source creds] create-db-snapshot → modify-db-snapshot-attribute (share)
  [target creds] copy-db-snapshot → restore
```
