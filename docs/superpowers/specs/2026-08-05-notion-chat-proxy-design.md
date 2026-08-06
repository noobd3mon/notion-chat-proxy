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
  "model": "fireworks-kimi-k3",
  "contextPageId": "optional-page-block-id" }
```
- `messages[]` = các lượt TRƯỚC (web tự giữ để render UI + gửi lại mỗi lượt). `message` = text user mới lượt này. Worker KHÔNG lưu/persist transcript. `model` (optional) = codename từ `GET /api/models` (mặc định `NOTION_MODEL`); khác default thì worker validate trước khi stream. `contextPageId` (optional) = block id Notion của **page instruction** — page có nội dung Notion nạp làm instruction/context cho AI (designation tường minh, KHÔNG phải workspace search nên vẫn dùng được ở ask mode: AI theo page này + kiến thức model + web search, không search workspace/help center — capture `app.notion.com/ai` gửi `context_page_id` dù `searchScopes: ai-knowledge`+`useReadOnlyMode`). Có (non-empty string) thì đưa `context_page_id` vào context, không thì bỏ hẳn.
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

---

## Addendum: File attachment support (added after model picker)

**Feature (user: "thêm support file"):** `POST /api/chat` chấp nhận `multipart/form-data` để đính kèm file (ảnh/PDF/CSV — giống "Add images, PDFs, or CSVs" của Notion). Field `json` (stringified body như request JSON) + 1+ part `file`. Worker relay bytes qua flow upload của Notion, KHÔNG lưu file trong KV (bytes chỉ tồn tại trong request memory của lượt đó). Shapes **đã verify bằng live-probe** (token thật, 2026-08-05).

**Flow upload (verified):**
1. `POST /api/v3/getUploadFileUrlForAssistantChatTranscriptUpload` — body `{name, contentType, assistantChatTranscriptSessionPointer:{spaceId, table:"thread", id:threadId}, contentLength, createThread:true}` → `{url:"attachment:<fileId>:<name>", signedGetUrl, signedUploadPostUrl, postHeaders:[], fields:{...11 trường S3...}, chatId}`. (POST, needs `x-notion-active-user-header`+`x-notion-space-id` — `notionHeaders` đã set.)
2. S3 multipart POST đến `signedUploadPostUrl`: các `fields` trước (giữ thứ tự Notion trả về), part `file` CUỐI CÙNG (filename=name) → `204`. `postHeaders` là `[]` thực tế.
3. `POST /api/v3/enqueueTask` — body `{task:{eventName:"processAgentAttachment", request:{url:fileUrl, spaceId, aiSessionPointer:{spaceId, table:"thread", id:threadId}, source:"user_upload", clientVersion}, cellRouting:{spaceIds:[spaceId]}}}` → `{"taskId":"<uuid>:prod-space-usw2-0004"}` (top-level `taskId` — đây là gap đã được probe fill).
4. Poll `POST /api/v3/getTasks` — body `{taskIds:[taskId]}` → `{results:[{id, state, eventName, request, status:{result:{type, data}}}]}`. Success gần như tức thì (probe: poll đầu tiên đã `success`). Metadata ở `results[0].status.result.data.stepMetadata` (gap thứ 2 đã probe fill) — chứa `width`/`height`/`moderation`/`guardrail`/`fileSizeBytes`/`aiTraceId`/`estimatedTokens` (PDF: `numPages` thay width/height, không moderation).
5. Build attachment entry (`buildAttachmentEntry` trong `transcript.js`): `{id:nid(), type:"attachment", fileUrl, fileName, contentType, metadata:{...stepMetadata, attachmentSource:"user_upload"}}`; PDF thêm top-level `base64EncodedFileUrl:""` (best-effort từ capture; image shape đã verify live, PDF shape từ capture trước đó).
6. Transcript = `[config, context, ...history, ...attachments, user]` (attachment ngay trước user message mới). **Cùng `threadId`** dùng cho upload session pointer VÀ `runInferenceTranscript` (sinh 1 threadId cho cả request, truyền vào `buildInferenceBody`).

**Xử lý lỗi:** lỗi upload/processing (S3 non-204, enqueueTask fail, getTasks `state:"error"`, poll timeout ~12s) → trả `502 {"error":"file upload failed: ..."}` (JSON error sạch, KHÔNG mở stream). Validation model vẫn chạy trước upload (nếu model sai → 400 trước khi upload). Multipart thiếu field `json` → `400`.

## Addendum: Web-search sources (added with file support)

**Feature (user: "nhả source ra api để web search nhả ra được sources các trang mà model search"):** bật web search thật + emit các trang model đã search ra SSE.

**Bật web search:** `DEFAULT_CONFIG` flip `enableWebResearch` + `internetAccess` → `true` (capture ask-mode gốc có cả hai `false`; chỉ `useWebSearch:true` không đủ để model thực sự search trong probe). Model vẫn TỰ quyết định KHI nào search ("hi" bình thường không search). Per-deploy tắt bằng `ENABLE_WEB_RESEARCH=false` / `ENABLE_INTERNET_ACCESS=false` (worker.js). Đã verify live.

**Shape sources (verified):** khi model search, stream append một `agent-tool-result` với `result.output` là **JSON string** `{"results":[[{"url":"https://...","title":"...","text":"..."}, ...]]}` (`results` là mảng, phần tử đầu là mảng các source; `headerLabel:"Đã tìm kiếm trên web"`). Lúc stream, state `s` có entry `type:"agent-tool-result"` này.

**Extraction (`src/sources.js`, pure):** quét mọi entry có `result.output` (JSON string), parse, nếu có `results` thì recursion thu thập object có `url` http(s) + `title`. Filter sạch các tool output khác: `fs.readFiles` → `{files:[{path}]}` (không url/title); `notion.loadUser` → `{url:"user://..."}` (không http, không title). Snippet = `text` cắt 300 ký tự. Dedupe theo url.

**Emission (`src/sse.js` `PatchStream._emitPending`):** sau mỗi patch/snapshot, `extractSources(state)` → diff với `_emittedSources` (Set url) → emit `event: sources` với `{sources:[...]}` (mới). Sources đến TRƯỚC token (search xảy ra trước answer). Dedupe qua snapshot lặp.

**Files touched:** `src/sources.js` (new), `src/sse.js` (+emit sources), `src/transcript.js` (+`buildAttachmentEntry`, `buildInferenceBody` nhận `threadId`+`attachments`+web flags, `buildConfig` nhận override), `src/notion.js` (+`getUploadFileUrl`/`uploadToS3`/`enqueueProcessAttachment`/`getTask`/`uploadAttachment`), `src/worker.js` (parse multipart, upload orchestration, web-flag threading), `server.js` (+env defaults). Tests: `test/sources.test.mjs` (new, 11), `test/worker.test.mjs` (+file 7, +sources 2 = 31), `test/transcript.test.mjs` (+attachments/threadId/attachment entry/web flags = 21). Fixtures: `getUploadFileUrl.json`, `getTasks.json`, `runInference-websearch.ndjson`. **100/100 tests green; cả 2 feature live-verified** (file: upload→runInference→answer; sources: `event: sources` thật với openai.com/news/...).

## Addendum: Rotation dùng createSpace response + persist ra file (sửa bug getSpaces)

**Bug (user báo):** space tạo bằng `createSpace` API (planType `"team"`) **không xuất hiện trong `getSpaces`** → logic rotation cũ ("poll getSpaces → findNewSpace") không tìm được space mới → rotation gãy. Confirm bằng probe: getSpaces chỉ trả 1 space dù đã (thử) create.

**Sửa `src/rotate.js`:** lấy record space mới **trực tiếp từ response `createSpace`** (Notion camelCase → ưu tiên `resp.spaceId`/`resp.spaceViewId`; fallback `space_id`/`id`; fallback cuối: scan uuid != old id qua `findNewUuid`). Chỉ khi response không có spaceId nhận diện được mới fallback 1 lần `getSpaces` (safety net cho account nào đó có list). Không có → throw rõ ràng ("createSpace returned no spaceId and getSpaces did not list a new space"). `spaceFromCreateResponse` export riêng để test.

**Persist ra file (`server.js`):** KV shim giờ **file-backed** — `state:activeSpace` ghi ra JSON file (`STATE_FILE`, default `./data/active-space.json`). Vì space tạo bằng API không có trong getSpaces, restart phải đọc lại từ file (không recover được qua getSpaces). Trên Railway: mount **Volume** tại `/data`, set `STATE_FILE=/data/active-space.json` để sống qua restart/redeploy. Không volume → mất space đã rotate, fallback về space gốc (có thể hết credit → rotate lại). `data/` thêm vào `.gitignore` + `.dockerignore`.

**Lưu verify:** shape response `createSpace` chưa live-verify được — token đang bị **429 `UserRateLimitResponse`** khi createSpace (tạo nhiều space do rotation). Extractor là defensive theo convention camelCase (`spaceId`/`spaceViewId`). Khi rate-limit clear, chạy `node _research/probe-createspace.mjs` (gitignored) để capture response thật + siết lại field nếu cần. Test mock `createSpace` trả `{spaceId,spaceViewId,name}` → 105/105 green (rotate 2→7).

## Addendum: Rotation resilient — tái dùng space cũ + cap createSpace 1 lần/turn

**Vấn đề (user confirm):** 429 `UserRateLimitResponse` khi `createSpace` là **thật** — Notion rate-limit `createSpace` rất gắt sau vài lần tạo. Rotation cũ mỗi lần hết credit lại `createSpace` → nhanh 429 → rotation gãy, user bị `event: error`.

**Fix thực chất — tái dùng space cũ trước khi tạo mới:** Notion reset free AI credit của một space theo thời gian, nên space đã tạo cách đây vài giờ/ngày **có thể đã phục hồi credit**. Giờ rotation:
1. **REUSE** space đã tạo trước đây (lưu trong `state:knownSpaces`) mà chưa thử turn này — ưu tiên **cũ nhất** (khả năng phục hồi cao nhất). Miễn phí (không call Notion).
2. **Cycle** qua các space known (`MAX_ROTATION = 5` attempt/turn), skip space đã thử (set `tried` truyền qua các lần rotate), đến khi space nào trả answer thật.
3. Chỉ khi **hết space known** mới fall through `createSpace` — và **cap 1 lần/turn** (sentinel `"__createSpace__"` trong `tried`): nếu mọi space known đều hết credit, error sạch thay vì đập rate-limited endpoint. Space mới tạo được append vào `state:knownSpaces` để tái dùng lần sau.

**`src/store.js`:** thêm `KNOWN = "state:knownSpaces"`, `getKnownSpaces(kv)` (trả array insertion-order), `addKnownSpace(kv, record)` (dedupe by spaceId, stamp `createdAt`). Vì space tạo bằng API không có trong getSpaces, phải tự nhớ id.

**`src/rotate.js`:** `rotateWorkspace({env,kv,currentSpace,tried=new Set()})` — (1) lọc known space `!== currentSpace` và không trong `tried`, sort theo `createdAt` asc, lấy oldest → `setActiveSpace` + return (no fetch). (2) không có candidate → guard `tried.has(CREATE_MARK)` → throw "all known workspaces exhausted ... createSpace was already attempted"; else `tried.add(CREATE_MARK)` rồi `createSpace` (rate-limited op, dùng old space làm `x-notion-space-id`) → `spaceFromCreateResponse` (camelCase + uuid-scan fallback) → fallback `getSpaces` nếu response không có id → `addKnownSpace` + `setActiveSpace`.

**`src/worker.js`:** `MAX_ROTATION = 5` (trước đây 1); `runTurn` giữ `const tried = new Set()`, mỗi iteration `tried.add(activeSpace.spaceId)` rồi truyền `tried` vào `rotateWorkspace`. Giúp cycle nhiều space known trong 1 turn + chặn createSpace >1 lần.

**Tests:** `test/store.test.mjs` (+5 knownSpaces = 8), `test/rotate.test.mjs` (+1 createSpace-cap = 11; reuse-oldest/skip-tried/persist + camelCase/uuid-scan/getSpaces-fallback/throw), `test/worker.test.mjs` (+2 cycling E2E = 33: reuse 1 known space không call createSpace; cycle S→K1(exhausted)→K2(hello) 3 inference). **116/116 tests green.** Lưu: shape `createSpace` response vẫn chưa live-verify (429) — khi clear, chạy `probe-createspace.mjs` để siết `spaceFromCreateResponse` field nếu cần.
