# Notion Chat Proxy — Design Spec

Date: 2026-08-05
Status: Draft (pending user review)

## Mục tiêu

Một serverless function `POST /api/chat` trên Cloudflare Worker, đóng vai trò proxy tới AI chat nội bộ của Notion (`runInferenceTranscript`, v3 internal API, auth bằng cookie `token_v2`). Dùng cho một trang web có sẵn (web của user đã tự quản lý `conversationId` + lịch sử chat). Phản hồi stream từng chữ như chat thật. Hỗ trợ nhớ ngữ cảnh đa lượt bằng **full replay** (web gửi lại toàn bộ history mỗi lượt — worker KHÔNG lưu transcript, tránh KV read quá nhiều). Tự xoay workspace (tạo mới + chuyển, không xóa) khi workspace hiện tại hết credit AI.

## Phạm vi

- Bao gồm: endpoint `/api/chat` (SSE), endpoint `GET /api/models` (model picker — proxy `getAvailableModels`), chọn model per-request (`body.model`), streaming, xoay workspace reactive khi hết credit. Transcript do web giữ gửi lại mỗi lượt — worker stateless cho transcript (chỉ 1 KV read `state:activeSpace`/lượt).
- Không bao gồm: UI chat (web của user tự lo — web tự giữ history để render + gửi lại), SDK integration (chỉ tham khảo pattern), continue/poll đa bước (Notion trả 1 call đầy đủ khi còn credit; rỗng = hết credit, không phải multi-step).

### Model picker + chọn model per-request

- `GET /api/models` (Bearer auth) → worker gọi `POST /api/v3/getAvailableModels` (`{spaceId}`, cần header `x-notion-active-user-header` + `x-notion-space-id`) → trả `{ models: [...] }` shape sạch cho picker: `id` (codename), `name`, `family`, `provider`, `displayGroup`, `disabled`, `disabledReason`, `supportedReasoningEfforts`, `defaultReasoningEffort`. Bỏ field nội bộ (beta flags, `modelCardAttributes`...).
- Cache in-memory isolate-scope TTL ~1h (`src/models.js`) để `/api/chat` validate không thêm Notion/KV call khi warm.
- `/api/chat` nhận `body.model` (optional, codename). Mặc định `NOTION_MODEL` (`fireworks-kimi-k3`). Khi khác default → validate against list cached: reject disabled/unknown bằng `400` TRƯỚC khi mở SSE stream. List unavailable (fetch fail) → **fail open** (cho qua, để Notion reject). Khi `model` == default → skip validate (path phổ thông không tốn Notion call).

## Nghiên cứu đã xác nhận (test bằng token thật)

| Mặt | Kết quả |
|---|---|
| Chat endpoint | `POST https://app.notion.com/api/v3/runInferenceTranscript` — 200 OK |
| Auth | `Cookie: token_v2=<...>` + headers `notion-client-version`, `x-notion-space-id`, `x-notion-active-user-header` |
| Response | NDJSON = JSON-Patch stream: `patch-start` → các `patch` (op `a` thêm, `x` nối string, `r` xóa) build state `s`. **Lưu ý**: có thể xuất hiện `patch-sync` giữa chừng (mang snapshot `data.s` đầy đủ, reset state) — applier phải xử lý `patch-sync` như `patch-start` (đã confirm qua fixture `runInference-hello.ndjson`: inference ở index 6 chỉ tới qua patch-sync, không qua `a /s/-`) |
| Answer | `s[i].type==="agent-inference"` → `value[]`: `{type:"thinking",content}` + `{type:"text",content}`. Content build dần bằng op `x` trên `/s/N/value/M/content` |
| Hoàn thành | patch thêm `finishedAt` vào `agent-inference` |
| Multi-turn | Replay đầy đủ transcript mỗi lượt → HOẠT ĐỘNG, AI nhớ đúng secret word. Entry assistant = `{id,type:"ai",userId,value:[["<text>"]],createdAt}` |
| Cơ chế "pointer" của Notion | Web app dùng `createThread:false` + `isPartialTranscript:true` + cùng `threadId` để tiếp tục — KHÔNG replay history. NHƯNG test qua API: luôn trả body `[` (degenerate, 200) cho thread tạo bằng API (re-verify lần 2: cả threadId gửi đi lẫn threadId trả về — Notion trả `threadId:null`, không có id thay thế). Cũng KHÔNG có endpoint nào lấy lại transcript (`getThread`/`getThreads`/`loadThreadState`/`getThreadRecords`/`getAgentThread` → 404; `syncRecordValues` table `thread` → rỗng — thread API-tạo không persist vào record). Vậy history BẮT BUỘC do web giữ + gửi lại mỗi lượt (full replay) |
| Đa bước / Credit | Phát hiện quan trọng: response "rỗng" KHÔNG phải multi-step mà là **HẾT CREDIT**. Patch đầu = `type:"premium-feature-unavailable"`, `featureAvailability.type:"unavailable"`, `limit:{type:"cumulative",current:79,total:75}`. Khi còn credit → 1 call trả đầy đủ (tools + inference + `finishedAt`) → **không cần continue/poll**. Rỗng = trigger xoay workspace (đã confirm, không còn TBD) |
| Workspace | `getSpaces` (200). `createSpace` schema đã biết (camelCase) + tạo space mới có **credit tươi** (AI trả answer đầy) → rotation confirm. "Delete workspace" = client-side, không có server API → bỏ qua. |
| Credit trigger | `premium-feature-unavailable` (`limit.current>total`) khi hết credit; `finished=true`+answer khi còn. Reactive rotation đã test OK end-to-end |
| SDK chính thức | `@notionhq/agents-client` dùng integration token (v1), khác hẳn token_v2 (v3). Chỉ tham khảo pattern thread/stream. Rotation chỉ làm được qua v3 internal |

## Kiến trúc

```
Web (conversationId, messages[], message) ──Bearer API_KEY──▶ Worker POST /api/chat
                                                                    │ NOTION_TOKEN_V2 = secret
                                                                    │ KV: state:activeSpace (1 read/turn)
                                                                    ▼
   build transcript = config + context + messages[] + message → runInferenceTranscript → stream patches → SSE
        └─ patch premium-feature-unavailable ⇒ rotate workspace ⇒ retry 1 lần
        └─ có agent-inference + finishedAt ⇒ stream text/thinking → done
        └─ xong ⇒ event: done {answer} (Worker KHÔNG lưu transcript — web tự append {user,message}+{ai,answer} vào history của nó để gửi lại lượt sau)
```

### Thành phần

1. **Auth layer**: validate `Authorization: Bearer API_KEY` (env `API_KEY`). 401 nếu sai.
2. **KV store (chỉ active space)** — KHÔNG lưu transcript:
   - `state:activeSpace` → `{ spaceId, spaceViewId, name, userId }` đang dùng (1 read/lượt; write chỉ khi rotate).
   - Transcript do **web giữ** và gửi lại mỗi lượt (`messages[]`), worker stateless cho transcript → tránh KV read quá nhiều (lo ngại rate limit KV).
3. **Notion caller**: build body, POST, stream.
4. **Patch → SSE translator**: parse NDJSON, bóc `x`/snapshot content delta → SSE event.
5. **Không cần continue/poll**: khi còn credit, 1 call `runInferenceTranscript` trả đầy đủ (inference + `finishedAt`). Stream hết mà chưa `finishedAt` = hết credit → rotate (xem #6).
6. **Workspace rotator**: create+switch space khi hết credit (không xóa — delete là client-side, không có server API).

### Request / Response

Request:
```
POST /api/chat
Authorization: Bearer <API_KEY>
Content-Type: application/json
{ "conversationId": "abc",
  "messages": [ {"role":"user","text":"hi"}, {"role":"ai","text":"hello"} ],
  "message": "how are you",
  "model": "fireworks-kimi-k3" }
```
- `messages[]` = các lượt TRƯỚC (web tự giữ để render UI + gửi lại mỗi lượt). `message` = text user mới lượt này. Worker KHÔNG lưu/persist transcript. `model` (optional) = codename từ `GET /api/models` (mặc định `NOTION_MODEL`); khác default thì worker validate trước khi stream.
- Lượt đầu tiên: `messages: []`, `message: "hi"`.
Response `text/event-stream`:
- `event: thinking` `data: <delta>` — reasoning (optional)
- `event: token` `data: <delta>` — answer delta
- `event: done` `data: {"answer":"..."}` — turn complete; web tự append `{role:"user",text:message}` + `{role:"ai",text:answer}` vào history của nó để gửi lại lượt sau
- `event: error` `data: {"message":"..."}`

### Body gửi Notion (mỗi lượt, fresh IDs)

```jsonc
{
  "traceId": "<fresh>", "spaceId": "<activeSpace>", "threadId": "<fresh per turn>",
  "transcript": [
    { "id":"...","type":"config","value": <cfg> },
    { "id":"...","type":"context","value": <ctx> },
    // ...các lượt cũ:
    { "id":"...","type":"user","userId":"...","value":[["<user text>"]],"createdAt":"..." },
    { "id":"...","type":"ai","userId":"...","value":[["<ai text>"]],"createdAt":"..." },
    // lượt mới:
    { "id":"...","type":"user","userId":"...","value":[["<message>"]],"createdAt":"<now>" }
  ],
  "threadParentPointer": { "table":"space","id":"<activeSpace>","spaceId":"<activeSpace>" },
  "createThread": true, "isPartialTranscript": false,
  "asPatchResponse": true, "patchResponseVersion": 2,
  "generateTitle": true, "saveAllThreadOperations": true, "setUnreadState": true,
  "createdSource": "ai_module", "threadType": "workflow",
  "debugOverrides": { "emitAgentSearchExtractedResults": true, "cachedInferences":{}, "annotationInferences":{}, "emitInferences":false }
}
```
Config dùng model `fireworks-kimi-k3` (configurable), `reasoningEffort:"max"`. Mặc định là **ask mode** (capture từ `app.notion.com/ai`): `searchScopes:[{type:"ai-knowledge"}]` (KHÔNG đọc nội dung workspace/space, KHÔNG search Notion help center — chỉ kiến thức model + web search), `useReadOnlyMode:true` (read-only, không edit/exec), `availableConnectors:[]` (không connector/tool), `useWebSearch:true`, `enableComputer:false`. AI "just answer" — không truy cập space, không help center, không chạy tool/computer; web search vẫn dùng được.

### Credit exhaustion → rotation trigger

Một lượt gọi `runInferenceTranscript`:
- **Còn credit**: 1 call duy nhất trả đầy đủ — patch `agent-inference` có `finishedAt` + `value[type:"text"]`. Stream `x` deltas tới client. **Không cần continue/poll** (đã verify: rỗng là do credit, không phải multi-step).
- **Hết credit**: patch đầu là `type:"premium-feature-unavailable"` với `featureAvailability.type:"unavailable"` + `limit.current > limit.total` → KHÔNG có `agent-inference`.

Worker:
1. Đọc patch-start. Nếu state chứa `premium-feature-unavailable` → **rotate workspace** (xem mục Workspace rotation) rồi retry tin nhắn 1 lần trên space mới.
2. Nếu retry vẫn unavailable → trả `event: error` (hết credit toàn bộ).
3. Nếu có `agent-inference` → stream `text`/`thinking` deltas tới khi `finishedAt`.

### Workspace rotation

Trigger **reactive** (đã confirm end-to-end): khi `runInferenceTranscript` trả patch `type:"premium-feature-unavailable"` (`featureAvailability.type:"unavailable"`, `limit.current > limit.total`) → gọi `rotateWorkspace()` → retry tin nhắn 1 lần trên space mới. Không cần proactive check (tránh overhead mỗi lượt).

`rotateWorkspace()`:
1. `POST /api/v3/createSpace` với body (schema đã capture, camelCase):
   ```json
   { "name":"<tên>", "planType":"team", "planSelection":"team",
     "initialPersona":"unfilled", "domainType":"personal",
     "deviceId":"<uuid>", "deviceType":"web-desktop", "source":"sidebar_switcher" }
   ```
   Gửi với `x-notion-space-id` = space hiện tại. Xử lý 429 (rate limit) bằng wait+retry.
2. `POST /api/v3/getSpaces` → tìm space mới nhất ≠ space hiện tại → lấy `newSpaceId` + `spaceViewId` (không phụ thuộc shape response của createSpace).
3. Cập nhật `state:activeSpace` = newSpaceId (lưu KV).
4. **Không xóa space cũ**: thao tác "delete workspace" ở Notion chỉ gỡ khỏi phía client (không có server API — capture đã ghi thao tác xóa mà không thấy request nào). Server vẫn giữ space cũ. Vậy rotation = **createSpace + switch** thôi; bỏ qua delete.

Bằng chứng (test token thật): space cũ `319d7f78...` trả `premium-feature-unavailable`; sau khi xoay sang space mới `0a06e656...` → AI trả answer đầy *"Hello, Ky! 👋 ..." (`finished=true, unavailable=false`). Rotation khả thi.

### Env / secrets (Worker)

- `NOTION_TOKEN_V2` — token user ( secret).
- `API_KEY` — web→worker auth.
- `NOTION_USER_ID` — hoặc derive từ `getSpaces` (top-level key = userId).
- `NOTION_MODEL` (mặc định `fireworks-kimi-k3`), `REASONING_EFFORT` (mặc định `max`).
- `NOTION_SPACE_ID` — space ban đầu (rotation sẽ override).

## Cân nhắc & rủi ro

- **ToS Notion**: xoay workspace để reset credit free-tier khả năng vi phạm ToS (circumvent usage limits), rủi ro khóa tài khoản. Tiến hành theo yêu cầu user; user chịu rủi ro.
- **Token hết hạn**: `token_v2` có thời hạn; worker trả error rõ ràng ("token expired") cho web khi Notion trả 401.
- **Hết credit**: tín hiệu đã confirm = patch `premium-feature-unavailable` (`featureAvailability.type:"unavailable"`, `limit.current > limit.total`). Worker rotate workspace + retry 1 lần; vẫn unavailable → trả error.
- **createSpace**: schema đã biết (camelCase: name, planType, planSelection, initialPersona, domainType, deviceId, deviceType, source). Có rate limit 429 → wait+retry. AI trên space mới có credit tươi đã confirm.
- **Xóa workspace**: thao tác client-side, không có server API → bỏ qua. Rotation chỉ create+switch. (Nếu sau này `validateUserCanCreateWorkspace` báo tới giới hạn số space thì mới cần xử lý thêm.)
- **Cơ chế pointer không dùng được qua API**: đã xác nhận (re-verify lần 2) `createThread:false`+`isPartialTranscript` trả `[` với thread tạo bằng API, dù dùng threadId gửi đi hay trả về (Notion trả `threadId:null`). Cũng không có endpoint nào lấy lại transcript đã lưu (`getThread`/`getThreads`/`loadThreadState`/`getThreadRecords`/`getAgentThread` → 404; `syncRecordValues` table `thread` → rỗng). Vậy history **bắt buộc do web giữ** và gửi lại mỗi lượt (full replay) — worker stateless cho transcript, tránh KV read quá nhiều. Nếu sau này replicate flow tạo thread của UI thật thì có thể chuyển sang pointer cho hiệu quả hơn.

## Cấu trúc file dự kiến (sau khi code)

```
src/
  worker.js        // Worker entry: route /api/chat + /api/models, auth, SSE, runTurn (stateless transcript)
  notion.js        // HTTP client: callRunInference, ndjsonLines, getSpaces, createSpace, getAvailableModels
  models.js        // getAvailableModels transform + per-request model validation + in-memory cache
  transcript.js    // body builders: config/context/entries, buildInferenceBody, findNewSpace/findSpaceById
  store.js         // KV active-space store (KHÔNG lưu transcript — chỉ state:activeSpace)
  rotate.js        // workspace rotation: createSpace + poll getSpaces + switch (không xóa)
  sse.js           // SSE encoder + PatchStream (patch delta -> thinking/token)
  patch.js         // NDJSON JSON-Patch applier (pure)
wrangler.toml      // binding KV, vars
test/              // vitest: patch, sse, transcript, notion, store, rotate, worker
```

## Out of scope

- UI chat, auth user cuối, rate limiting nâng cao, multi-user (hiện 1 token).
- Dùng SDK chính thức (integration token) — chỉ tham khảo.
