# Notes — Frontend Implementation Brief

Staff notes against customer and vehicle records. Append-only — no editing after posting. Notes appear in two places: the customer profile drawer and the vehicle detail drawer.

---

## TypeScript types

```ts
interface NoteAuthor {
  id: number
  name: string        // "Nev R." — first name + last initial
  fullName: string    // "Nev Rodda"
  initials: string    // "NR"
  color: string | null     // hex for avatar background fallback
  avatarUrl: string | null // Cloudflare thumbnail — null if no photo
}

interface Note {
  id: number
  content: string
  createdAt: string   // ISO 8601 UTC, e.g. "2026-06-27T10:30:00.000Z"
  author: NoteAuthor
}

interface CustomerNotesResponse {
  customerId: number
  notes: Note[]
}

interface VehicleNotesResponse {
  vehicleId: number
  notes: Note[]
}
```

---

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET /customers/:id/notes` | List all notes for a customer |
| `POST /customers/:id/notes` | Add a note to a customer |
| `DELETE /customers/:id/notes/:noteId` | Delete a customer note |
| `GET /vehicles/:id/notes` | List all notes for a vehicle |
| `POST /vehicles/:id/notes` | Add a note to a vehicle |
| `DELETE /vehicles/:id/notes/:noteId` | Delete a vehicle note |

All require `Authorization: Bearer <token>`.

---

## Fetch patterns

```ts
// List
const { notes } = await api.get<CustomerNotesResponse>(`/customers/${customerId}/notes`)
const { notes } = await api.get<VehicleNotesResponse>(`/vehicles/${vehicleId}/notes`)

// Create — returns { note: Note }
const { note } = await api.post<{ note: Note }>(`/customers/${customerId}/notes`, { content })
const { note } = await api.post<{ note: Note }>(`/vehicles/${vehicleId}/notes`, { content })

// Delete — 204 No Content
await api.delete(`/customers/${customerId}/notes/${noteId}`)
await api.delete(`/vehicles/${vehicleId}/notes/${noteId}`)
```

Notes are returned newest-first. No pagination — notes lists are short.

---

## Tab badge — `notesCount`

`GET /customers/:id` now includes `notesCount` on the customer and `notesCount` on each vehicle object. Use these to show a badge on the Notes tab without a separate fetch:

```ts
// Customer profile response
customer.notesCount       // e.g. 3

// Vehicle within the customer profile
customer.vehicles[n].notesCount  // e.g. 1
```

Update the badge locally when notes are added or deleted — no re-fetch needed:

```ts
// After successful POST
notesCount++
notes.unshift(newNote)

// After successful DELETE
notesCount--
notes = notes.filter(n => n.id !== deletedId)
```

---

## Author avatar

Same pattern as technician avatars — priority: photo → initials on colour background.

```ts
const PALETTE = [
  '#6366F1', '#EC4899', '#F59E0B', '#10B981',
  '#3B82F6', '#EF4444', '#8B5CF6', '#14B8A6',
]

function authorColor(author: NoteAuthor): string {
  return author.color ?? PALETTE[author.id % PALETTE.length]
}
```

```tsx
function AuthorAvatar({ author }: { author: NoteAuthor }) {
  if (author.avatarUrl) {
    return <img src={author.avatarUrl} alt={author.fullName} className="rounded-full" />
  }
  return (
    <div style={{ background: authorColor(author) }} className="rounded-full flex items-center justify-center">
      <span>{author.initials}</span>
    </div>
  )
}
```

---

## Display rules

| Field | How to display |
|-------|----------------|
| `author.name` | Compact — use next to avatar in note header: `"Nev R."` |
| `author.fullName` | Tooltip or expanded view |
| `createdAt` | `"Fri 27 Jun, 10:30 am"` — see format below |
| `content` | Preserve line breaks (`whitespace: pre-wrap`) |

### `createdAt` format

```ts
function formatNoteDate(iso: string): string {
  return new Date(iso).toLocaleString('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Australia/Melbourne',
  })
  // → "Fri 27 Jun, 10:30 am"
}
```

---

## Compose box

Single `<textarea>` with a Send button. Disable Send while content is empty or the request is in flight.

```ts
const [content, setContent] = useState('')
const [submitting, setSubmitting] = useState(false)

async function handleSubmit() {
  if (!content.trim() || submitting) return
  setSubmitting(true)
  try {
    const { note } = await api.post(`/customers/${customerId}/notes`, { content: content.trim() })
    notes.unshift(note)
    notesCount++
    setContent('')
  } finally {
    setSubmitting(false)
  }
}
```

Max 2000 characters — show a character counter when the user is near the limit (e.g. below 100 remaining).

---

## Delete

Show a delete button on each note. Visibility rules:

| Role | Can delete |
|------|-----------|
| `super_admin` | Any note |
| `store_manager` | Any note on a customer in their store |
| `technician` | Never — hide the delete button entirely |

```ts
const canDelete = currentUser.role !== 'technician'
```

On delete, optimistically remove from the local list and decrement `notesCount`. If the request fails, restore both.

---

## Error handling

| Status | Message to show |
|--------|----------------|
| `400` | Show the `error.message` from the response inline near the compose box |
| `403` | "You don't have permission to delete this note." |
| `404` | Note was already deleted — remove it from the local list silently |

---

## Suggested component structure

```
CustomerDrawer
  └── NotesList (customerId)
        ├── NoteCompose → POST /customers/:id/notes
        └── NoteItem[]
              ├── AuthorAvatar
              ├── author.name + createdAt
              ├── content
              └── DeleteButton (hidden for technician role)

VehicleDrawer
  └── NotesList (vehicleId, type="vehicle")
        ├── NoteCompose → POST /vehicles/:id/notes
        └── NoteItem[]
              └── (same shape)
```

`NotesList` can be a single component parameterised by `type: 'customer' | 'vehicle'` and the relevant `id` — the fetch URL and response envelope key differ but the note shape is identical.
