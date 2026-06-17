# Vehicle Chat — Frontend Brief

**Base URL:** `https://fzzrkscwd7.execute-api.ap-southeast-2.amazonaws.com`

All requests require `Authorization: Bearer <accessToken>`.

---

## Overview

Each vehicle has a persistent AI chat interface where mechanics can ask questions, send photos, and get expert advice. Gemini has full context of the vehicle — its specs, service history, known issues, and parts used — so the mechanic doesn't need to provide background.

**V1 scope:** Images + text. Each conversation is saved and can be pulled up at any time.

---

## DB tables needed (run before deploy)

```sql
CREATE TABLE vehicle_chats (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  vehicle_id           BIGINT UNSIGNED NOT NULL,
  started_by_staff_id  BIGINT UNSIGNED NOT NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle_chats_vehicle_id (vehicle_id)
);

CREATE TABLE vehicle_chat_messages (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chat_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('user', 'model') NOT NULL,
  content     TEXT NULL,
  image_id    VARCHAR(255) NULL,
  staff_id    BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_vehicle_chat_messages_chat_id (chat_id)
);
```

---

## Endpoints

### POST /customers/{customerId}/vehicles/{vehicleId}/chats

Start a new conversation.

```
POST /customers/12/vehicles/34/chats
Authorization: Bearer <accessToken>
```

**Response `201`**

```json
{ "id": 7 }
```

Use the returned `id` as `chatId` for subsequent calls.

---

### GET /customers/{customerId}/vehicles/{vehicleId}/chats

List all conversations for a vehicle, newest first.

```
GET /customers/12/vehicles/34/chats
Authorization: Bearer <accessToken>
```

**Response `200`**

```json
{
  "chats": [
    {
      "id": 7,
      "createdAt": "2026-06-17T04:23:00.000Z",
      "staffId": 14,
      "mechanic": "Jake Smith",
      "avatar": {
        "thumbnail": "https://imagedelivery.net/.../thumbnail",
        "public":    "https://imagedelivery.net/.../public"
      },
      "messageCount": 6,
      "preview": "There's a knocking sound from the engine at idle..."
    }
  ]
}
```

- `staffId` is the `staff.id` of the mechanic who started the chat
- `avatar` is the staff member's profile photo (thumbnail + public URLs), or null if they haven't uploaded one
- `preview` is the first user message text (null if the first message was image-only)
- `mechanic` is the full name of the staff member who started the chat

---

### GET /customers/{customerId}/vehicles/{vehicleId}/chats/{chatId}/messages

Fetch messages in a conversation. Returns the 50 most recent messages by default, oldest-first. Use `before` to page back through older history.

```
GET /customers/12/vehicles/34/chats/7/messages
GET /customers/12/vehicles/34/chats/7/messages?before=42
Authorization: Bearer <accessToken>
```

| Query param | Type | Description |
|-------------|------|-------------|
| `before` | number | Return the 50 messages older than this message ID (for "load more" scroll-up) |

**Response `200`**

```json
{
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "There's a knocking sound from the engine at idle",
      "image": null,
      "sentBy": "Jake Smith",
      "staffId": 14,
      "avatar": {
        "thumbnail": "https://imagedelivery.net/.../thumbnail",
        "public":    "https://imagedelivery.net/.../public"
      },
      "createdAt": "2026-06-17T04:23:00.000Z"
    },
    {
      "id": 2,
      "role": "model",
      "content": "Given this is a 2019 Corolla with the 2ZR-FAE Valvematic engine, knocking at idle most often points to...",
      "image": null,
      "sentBy": null,
      "staffId": null,
      "avatar": null,
      "createdAt": "2026-06-17T04:23:05.000Z"
    },
    {
      "id": 3,
      "role": "user",
      "content": null,
      "image": {
        "thumbnail": "https://imagedelivery.net/.../thumbnail",
        "public":    "https://imagedelivery.net/.../public"
      },
      "sentBy": "Jake Smith",
      "createdAt": "2026-06-17T04:24:10.000Z"
    }
  ],
  "hasMore": true,
  "oldestMessageId": 1
}
```

- `role`: `"user"` = mechanic, `"model"` = Gemini assistant
- `sentBy`: null for assistant messages
- `staffId`: the `staff.id` of the sender — null on model messages
- `avatar`: the sender's profile photo (thumbnail + public URLs), null if no photo uploaded or for model messages
- `image`: null if no image on this message
- Messages are always returned oldest-first within the page
- `hasMore`: true means there are older messages not yet fetched
- `oldestMessageId`: pass this as `?before=<id>` on the next call to load older messages

**Pagination flow (scroll-up "load more"):**

1. Open conversation → `GET .../messages` (no params) → renders the 50 most recent messages
2. User scrolls to the top → call `GET .../messages?before=<oldestMessageId>` → prepend results above the existing messages
3. Repeat until `hasMore` is `false`

---

### POST /customers/{customerId}/vehicles/{vehicleId}/chats/{chatId}/messages

Send a message and receive an AI response. Supports text, image, or both.

```
POST /customers/12/vehicles/34/chats/7/messages
Authorization: Bearer <accessToken>
Content-Type: application/json

{
  "content": "What could cause this noise?",
  "imageId": "abc123-cf-image-id"
}
```

| Field | Type | Required |
|-------|------|----------|
| `content` | string | Yes (unless `imageId` provided) |
| `imageId` | string | Yes (unless `content` provided) |

At least one of `content` or `imageId` must be provided.

**Response `200`**

```json
{
  "messageId": 4,
  "reply": "Looking at this image, I can see the oil cap area has significant carbon build-up. On this Corolla's Valvematic system, this is typically caused by..."
}
```

- `messageId` is the ID of the assistant's response message
- The user message was also saved (you don't need to save it separately)

**Error responses**

| Status | When |
|--------|------|
| `422` | Neither `content` nor `imageId` provided |
| `404` | Vehicle not found, doesn't belong to customer, or chat not found |
| `403` | Staff doesn't have access to this store |

---

## Image upload flow

Images must be uploaded to Cloudflare before sending to chat. Use the existing photo upload URL endpoint:

**Step 1 — Get a signed upload URL**

```
GET /photos/upload-url
Authorization: Bearer <accessToken>
```

```json
{ "uploadUrl": "https://upload.imagedelivery.net/...", "imageId": "abc123" }
```

**Step 2 — Upload the image directly to Cloudflare**

```
POST <uploadUrl>
Content-Type: multipart/form-data

file=<image binary>
```

**Step 3 — Send the chat message with the imageId**

```json
{ "imageId": "abc123", "content": "What do you see here?" }
```

---

## Suggested UI

### Tab placement

Add a **"AI Chat"** tab on the vehicle detail screen alongside Service History, Vehicle Info, etc.

### Chat history panel

The left side (or top) shows the list of past conversations:

```
┌─────────────────────────────────────────────┐
│  NEW CHAT  [+ button]                       │
├─────────────────────────────────────────────┤
│  ● 17 Jun 2026                              │
│    Jake Smith  · 6 messages                 │
│    "There's a knocking sound from the..."   │
├─────────────────────────────────────────────┤
│  ● 3 May 2026                               │
│    Sarah Jones · 2 messages                 │
│    [Image only]                             │
└─────────────────────────────────────────────┘
```

Clicking a row loads that conversation.

### Active conversation

```
┌─────────────────────────────────────────────┐
│  ← Chat · Jake Smith · 17 Jun 2026          │
├─────────────────────────────────────────────┤
│                                             │
│  Jake Smith           10:23 AM             │
│  There's a knocking sound from the         │
│  engine at idle, especially when cold.     │
│                                             │
│          Rodz AI                10:23 AM   │
│          Given this is a 2019 Corolla      │
│          with the 2ZR-FAE Valvematic...    │
│                                             │
│  Jake Smith           10:24 AM             │
│  [📷 Photo]                                │
│                                             │
│          Rodz AI                10:24 AM   │
│          Looking at this image, I can see  │
│          the oil cap area has significant  │
│          carbon build-up...               │
│                                             │
├─────────────────────────────────────────────┤
│  [📷]  Type a message...        [Send →]   │
└─────────────────────────────────────────────┘
```

### Message bubble rules

- User messages: left-aligned, name + timestamp above
- AI messages: right-aligned (or distinct background), "Rodz AI" label
- Images: show as a tappable thumbnail that opens full-screen
- Long AI responses: render markdown (bold, lists, code blocks)

### Sending flow

1. User taps the camera icon → selects image
2. Call `GET /photos/upload-url` → upload to Cloudflare → store `imageId`
3. Show a preview of the selected image in the input area
4. User adds optional text and taps Send
5. Call `POST .../messages` with `{ imageId, content }`
6. Show a typing indicator (streaming feel) while waiting for `reply`
7. On response, append both the user message and the AI reply to the conversation

### Loading states

- Opening a conversation: skeleton messages
- Waiting for AI reply: "Rodz AI is thinking..." indicator in the message thread
- Image uploading: spinner overlay on the image preview

---

## Permissions

| Action | Minimum role |
|--------|-------------|
| Start chat / send message | Any authenticated staff |
| View chat history | Any authenticated staff |
