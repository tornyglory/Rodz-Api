# Chat Feedback Review — `applied` flag on proposed edits

Small addition to `POST /admin/chat-feedback/review` so the Approve buttons on each proposed-edit card persist their state across page reloads. **Backend is deployed and smoke-tested.**

Full context brief: `docs/admin-chat-feedback-frontend-brief.md`.

---

## What changed

Each entry in `proposedEdits[]` now carries an `applied: boolean`:

```jsonc
{
  "proposedEdits": [
    {
      "target":      "system-prompt",           // "system-prompt" | "agent"
      "agentName":   null,                       // string when target = "agent" (booking | expense | fuel | vehicle | logbook | quote)
      "instruction": "When the user asks about their expenses, immediately confirm access AND surface the most recent expense.",
      "rationale":   "3 of 7 👎s said replies were generic.",
      "applied":     true                        // ← NEW
    }
  ]
}
```

- **`applied: true`** — this exact rule (`target + agentName + normalised instruction`) is already in the active prompt version's `learnedGuidance`.
- **`applied: false`** — never applied, or was applied and later removed via the `/admin/prompts` editor.

Also newly surfaced: **`agentName`** is now included explicitly (was implicit before). Non-null string when `target === "agent"`, `null` otherwise.

---

## Refresh-safe

`applied` is computed **fresh on every response** — even when the review body itself is served from Redis cache (`cached: true`). No cache warmup, no invalidation dance. Remove a rule via the editor → next review call flips the corresponding edit back to `applied: false` immediately.

---

## Frontend integration

```ts
// on every review load (fresh OR cached)
const appliedEditKeys = new Set(
  response.proposedEdits
    .filter(e => e.applied)
    .map(e => `${e.target}::${e.agentName ?? ''}::${e.instruction.trim().replace(/\s+/g, ' ')}`),
)
```

Approve button state per card:
- `applied: true` → render **Approved ✓**, disable the button.
- `applied: false` → render **Approve**, enabled.

On click:
1. Optimistically add the edit's key to `appliedEditKeys` (button flips to Approved ✓).
2. Fire `POST /admin/prompts/apply-edits` with that single edit.
3. On success — leave the local Set as-is; next review reload will confirm from the server.
4. On failure — remove from the Set, re-enable, show error toast.

That's it. Absence of `applied` during rollout should be treated as `false` (no crash).

---

## Errors

No change from the existing endpoint: `403` for non-super-admin, `500` for unexpected DB failures. If the active-version lookup fails internally, every edit defaults to `applied: false` (log-and-continue) so the reviewer can safely re-approve — never a hard failure.

---

## Smoke test (already run against production)

1. Fresh review → 5 proposed edits, all `applied: false`.
2. Applied one edit via `POST /admin/prompts/apply-edits` → 3 rules now in active `learnedGuidance`.
3. Cached re-review → the matched edit is `applied: true`, other four stay `false`. ✓
4. Wiped `learnedGuidance: []` via `POST /admin/prompts` → cached re-review → all five back to `applied: false`. ✓
