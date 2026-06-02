# Staff Search — Frontend Brief

**Endpoint:** `GET /staff`
**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

Search is handled entirely client-side. The API always returns the full unfiltered list — no query params, no pagination. Call it once on load and filter the result in memory.

---

## Loading

```ts
// On settings page mount
const staffRes = await staffApi.list()

allUsers.value = staffRes.users.map(u => ({
  ...u,
  initials: initials(u.fullName),
  color:    nextColor(u.id),
}))
```

---

## Filtering

Apply all active filters to `allUsers` as a computed property:

```ts
const filteredUsers = computed(() => {
  let users = allUsers.value

  // Role tab filter
  if (activeRole.value !== 'all') {
    users = users.filter(u => u.role === activeRole.value)
  }

  // Store filter
  if (activeStore.value !== 'all') {
    users = users.filter(u => u.store === activeStore.value)
  }

  // Search — matches fullName, email, or store
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    users = users.filter(u =>
      u.fullName.toLowerCase().includes(q) ||
      u.email.toLowerCase().includes(q) ||
      (u.store ?? 'all stores').toLowerCase().includes(q)
    )
  }

  return users
})
```

### Search fields

| Field | Example match |
|-------|--------------|
| `fullName` | `"aaron"` matches `"Aaron Ross"` |
| `email` | `"ross"` matches `"a.ross@rodz.com.au"` |
| `store` | `"frank"` matches `"Frankston"` — `super_admin` (store = `null`) matches `"all stores"` |

Search is case-insensitive, substring match on all three fields simultaneously.

---

## Role tab values

The role filter uses the exact strings returned by the API:

| Tab label | Filter value(s) |
|-----------|----------------|
| All | `"all"` (no filter) |
| Owners | `"super_admin"` |
| Managers | `"store_manager"` |
| Technicians | `"senior_mechanic"`, `"qualified_mechanic"`, `"service_tech"`, `"tyre_tech"`, `"receptionist"`, `"apprentice"`, `"technician"` |

For the Technicians tab, filter by checking whether the role is not `super_admin` and not `store_manager`:

```ts
if (activeRole.value === 'technician') {
  users = users.filter(u => u.role !== 'super_admin' && u.role !== 'store_manager')
}
```

---

## Store filter values

Populate the store dropdown from the unique `store` values in the response, excluding `null`:

```ts
const storeOptions = computed(() => [
  { label: 'All stores', value: 'all' },
  ...[...new Set(allUsers.value.map(u => u.store).filter(Boolean))].sort().map(s => ({
    label: s,
    value: s,
  })),
])
```

---

## Status

`status` is `"active"` or `"inactive"`. If the UI has an active/inactive toggle, filter the same way:

```ts
if (showActiveOnly.value) {
  users = users.filter(u => u.status === 'active')
}
```

---

## When to re-fetch

Re-call `GET /staff` after any mutating operation so the list stays in sync:

| Action | Re-fetch? |
|--------|-----------|
| Create user | Yes — after `POST /staff` returns `201` |
| Update user | Yes — after `PATCH /staff/{id}` returns `200` |
| Delete user | Yes — after `DELETE /staff/{id}` returns `204` |
| Reset password | No — list data unchanged |
