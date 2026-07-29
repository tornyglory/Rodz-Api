// Shared filtering rules for the "list recommendations for a vehicle"
// endpoints. All three surfaces (customer portal, staff, public logbook)
// should return the same "still actionable" slice — hard-coding it here
// keeps them in sync.

// How far past the current odometer we still surface a recommendation.
// Rationale: a service that was due 3,000 km ago is still actionable —
// the owner might have overlooked it, and reminding them is useful. A
// service that was due 50,000 km ago is noise on a well-cared-for car
// (they've either done it long ago via someone else's workshop, or
// the vehicle would be dead by now).
export const OVERDUE_TOLERANCE_KM = 5000

// Ceiling on rows returned per request. Recommendations are meant to
// surface "what to do next", not an exhaustive audit log — 20 is more
// than enough for any UI, and keeps the payload small on cars with a
// lot of maintenance history.
export const RECOMMENDATION_LIMIT = 20
