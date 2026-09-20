# 01 — Workspace: bố cục IDE

> Tham chiếu: `nextjs/src/components-v2/develop/DevelopLayout.tsx`,
> `transforms/{FileExplorer,EditorTabs,TerminalPanel,RightPanel}/`,
> `workspace/CodeEditor.tsx`, `nextjs/src/lib/develop-session.ts`.

## 1. Bố cục

```
┌─ TopBar: ◄ | tên project ▾ | branch / worktree | badge Clean|N changed|Deleted ─┐
├──────────┬────────────────────────────────────────────────────────┬────────────┤
│ Sidebar  │  EditorTabs                                            │ RightPanel │
│ Files    │  ┌──────────────────────────────────────────────────┐  │  (rail)    │
│ Git      │  │  CodeEditor (Monaco) / DiffEditor                │  │  ▸ dbt ▾   │
│ History  │  │                                                  │  │  ▸ Docs    │
│          │  └──────────────────────────────────────────────────┘  │  ▸ Save    │
│ (resize  │  ────────────────── kéo để đổi cao ─────────────────   │  ▸ Terminal│
│  220–520)│  TerminalPanel: Logs | Results | Compiled | Lineage    │  ▸ Settings│
└──────────┴────────────────────────────────────────────────────────┴────────────┘
                                        │ AgentPanel (dbt assistant, nếu bật) ────┘
```

- **TopBar** được `DevelopLayout` đẩy vào `TopBarContext`, không phải header riêng.
  Dropdown tên project hiển thị branch, worktree dir, remote, project ID, và lối vào
  **Project settings**. Badge trạng thái lấy từ `gitStatus.changes.length`.
- **Sidebar** rộng 220–520px, kéo bằng pointer event (`startSidebarResize`), ghi lại
  vào phiên. Ba tab: `files` / `git` / `history`.
- **RightPanel** là thanh dọc 56px chứa menu lệnh dbt và các nút tác vụ nhanh.

## 2. File Explorer

`transforms/FileExplorer/index.tsx`.

| Tính năng | Ghi chú |
|---|---|
| Lazy load | API `/files/{id}` trả **một cấp** thư mục. Mở folder → `handleLoadChildren` gọi tiếp. |
| Tìm kiếm | Gõ vào ô search: lọc cục bộ trên cây đã nạp, đồng thời gọi `/files/{id}/search` cho kết quả toàn project. |
| Multi-select | Ctrl/Cmd+click. `anchorPath` = node click cuối, dùng làm thư mục đích khi tạo file. |
| Đổi tên | `F2` hoặc menu chuột phải → input inline (`InlineInput.tsx`). |
| Xoá | `Delete` — xoá cả selection, có confirm. |
| Kéo thả trong cây | Kéo file/folder vào folder khác → `/files/{id}/move`. |
| Kéo thả từ OS | `osDrop.ts` — thả file từ máy vào cây để upload. |
| Menu chuột phải | Tạo file / tạo folder / rename / duplicate / copy / delete. |

Khi đổi tên hoặc di chuyển, `DevelopLayout` cập nhật **cả cây lẫn tab đang mở** bằng
hai helper thuần: `renamePath()` / `renameNodes()` / `removeNodes()` — trạng thái được
tạo mới chứ không sửa tại chỗ.

### File watcher

`useFileWatcher(projectId, …)` mở `EventSource` tới `GET /sse/files/{project_id}`.
Sự kiện: `created | modified | deleted | moved | ping`.

Xử lý trong `handleFileWatcherEvent`:

- `created/deleted/moved` → nạp lại cây gốc, **nạp lại mọi thư mục cha đã mở**
  (`refreshAncestors`, vì API chỉ trả một cấp), nạp lại git status, hẹn refresh IntelliSense.
- `modified` → nếu file đang mở và **không dirty** thì nạp lại nội dung; nếu file vừa
  được chính tab này lưu thì bỏ qua (`recentlySavedFilesRef`, tự hết hạn sau 3s) để
  tránh vòng lặp lưu → watcher → reload.

Tự reconnect sau 2s khi mất kết nối.

## 3. Editor

`workspace/CodeEditor.tsx` — Monaco qua `@monaco-editor/react`.

- Ngôn ngữ suy ra từ đuôi file (`sql`, `yaml`, `markdown`, `python`, `json`…).
- **IntelliSense dbt** (mục 5) đăng ký qua `registerCompletionItemProvider('sql', …)`:
  gợi ý `ref()`, `source()`, tên model, tên cột từ catalog, snippet Jinja và keyword SQL.
- **Go to definition**: `registerDefinitionProvider('sql', …)` — Ctrl/Cmd+click lên tên
  model trong `ref()` để nhảy sang file model đó.
- **Format**: `Shift+Alt+F`. Gọi `POST /dbt/format` (sqlglot phía server); nếu server
  **từ chối** (sqlglot không đoán bừa) thì dùng formatter cục bộ `formatFile()` và ghi
  một dòng `[INFO]` vào Logs.

### Diff

`workspace/DiffEditor.tsx`. Mở từ Source Control panel (`onOpenDiff`) — so sánh nội dung
HEAD với working tree cho một file.

## 4. Tab & draft

`transforms/EditorTabs/index.tsx`, state `openTabs: OpenTab[]` trong `DevelopLayout`.

```ts
interface OpenTab {
  path: string          // "models/marts/dim_customer.sql", hoặc "__draft__/…" nếu là nháp
  name: string
  content: string
  originalContent: string
  isDirty: boolean      // content !== originalContent
  isDraft?: boolean     // chưa từng được lưu xuống đĩa
}
```

- **Draft** (`Cmd/Ctrl+N`) tạo tab `Untitled-N.sql` chỉ nằm trong bộ nhớ. Lần lưu đầu
  tiên `saveDraftAs()` hỏi đường dẫn; tên không có `/` sẽ mặc định vào `models/`,
  thiếu `.sql` sẽ được thêm.
- `ensureSavedSqlFile()` là cổng chung cho Preview / Compile / Explain / Run:
  draft → hỏi lưu; dirty → lưu; sau đó mới chạy. **Không có lệnh nào chạy trên nội dung
  chưa nằm trên đĩa** vì dbt đọc file, không đọc editor.

## 5. IntelliSense metadata

`useDbtIntellisense(projectId)` → `GET /dbt/intellisense/{project_id}`.

Runner đọc `target/manifest.json` (+ `target/catalog.json` nếu có) và trả về dạng đã
chuẩn hoá: danh sách model, source, cột và kiểu cột.

| Trạng thái trả về | Ý nghĩa |
|---|---|
| `missing_manifest` | Chưa chạy `dbt parse`/`compile` lần nào — gợi ý sẽ nghèo |
| `parse_error` | `manifest.json` hỏng |
| (dữ liệu) | Bình thường; cột chỉ đầy đủ khi đã có `catalog.json` (`dbt docs generate`) |

Refresh được hẹn giờ (debounce 500ms) sau mỗi lần lưu file `.sql/.yml/.md`, và chạy
ngay sau khi một lệnh `parse | compile | docs | build | run` kết thúc thành công.

## 6. Terminal panel

`transforms/TerminalPanel/index.tsx`, cao mặc định 250px, kéo được.

| Tab | Component | Nội dung |
|---|---|---|
| **Logs** | `TerminalOutput.tsx` | stdout của dbt (stream), có ô nhập lệnh |
| **Results** | `QueryResultsTable.tsx` / `QueryPlanView.tsx` | Hai view: `results` (bảng preview) và `plan` (query plan) |
| **Compiled** | `CompiledSQLView.tsx` | SQL sau khi render Jinja |
| **Lineage** | `LineageView.tsx` | Đồ thị lineage bảng + lineage cột |

Nút `Clear` chỉ xoá đúng tab đang xem (`handleClearTerminalTab`).

### Ô nhập lệnh

`handleTerminalSubmit` chỉ nhận đúng 4 dạng — **không phải shell thật**:

| Nhập | Hành vi |
|---|---|
| `dbt <lệnh>` | Chạy qua đúng đường ống của nút Run (kèm target + extra args) |
| `git <lệnh>` | Gọi `POST /git/exec`; `push`/`pull` mở dialog credential trước |
| `clear` | Xoá log |
| `help` | In danh sách trên |

Mọi thứ khác trả `Unknown`.

## 7. Phím tắt

| Phím | Hành động | Nơi xử lý |
|---|---|---|
| `Cmd/Ctrl+S` | Lưu file đang mở | window + Monaco |
| `Cmd/Ctrl+Enter` | Preview model (`dbt show`) | window + Monaco |
| `Cmd/Ctrl+Shift+Enter` | Run model hiện tại | window + Monaco |
| `Cmd/Ctrl+N` | Tab SQL nháp mới | window + Monaco |
| `Cmd/Ctrl+W` | Đóng tab | window + Monaco |
| `Shift+Alt+F` | Format file | Monaco |
| `F2` | Đổi tên node đang chọn | File Explorer |
| `Delete` | Xoá selection | File Explorer |

Handler cấp window bỏ qua sự kiện phát ra từ `INPUT`/`TEXTAREA` và từ trong
`.monaco-editor` (Monaco tự đăng ký lệnh riêng) để không kích hoạt hai lần.

## 8. dbt assistant (tuỳ chọn)

`develop/agent/AgentPanel.tsx`, mở bằng nút robot ở RightPanel.

- Chỉ xuất hiện khi deployment có assistant: `useAgentAvailability()` hỏi `/api/agent`;
  `AGENT_URL` rỗng → proxy trả 503 → **nút bị ẩn hoàn toàn** (lối vào luôn hỏng còn tệ hơn
  không có lối vào).
- `useAgentStream(projectId)` giữ một phiên harness cho mỗi project qua SSE, kèm lịch sử
  hội thoại, todo list và usage.
- Assistant sửa file qua fs tool của harness, nhưng **chạy dbt chỉ qua MCP server `dbt`
  → dbt-runner** — cùng khoá, cùng warm worker, cùng ngân sách bộ nhớ, cùng History.
  Nó không có `DATABASE_URL` và không shell ra dbt.
- Model provider là cấu hình theo từng người dùng trong Settings; khoá không bao giờ về
  trình duyệt. Đổi provider → phiên được khởi động lại (`ModelConfig.fingerprint`).

Chi tiết nằm ở `dsh-agent/README.md`.

## 9. Lưu phiên làm việc

`nextjs/src/lib/develop-session.ts`.

- **`sessionStorage`**, khoá `dbt-craft:develop-session:{userId}:{projectId}` —
  lưu gần như toàn bộ state UI: tab đang mở và nội dung, file đang chọn, log terminal,
  kết quả query, compiled SQL, lineage, thư mục đã mở, kích thước sidebar/terminal.
- **`localStorage`**, ba khoá riêng vì cần sống qua nhiều phiên:
  `dbt-command-args:{userId}:{projectId}`, `dbt-full-refresh:…`, `dbt-target:…`.

Khôi phục chỉ chạy **sau khi có `userId`** từ NextAuth (effect phụ thuộc `[projectId, userId]`),
nên state của người dùng này không rò sang người dùng khác trên cùng trình duyệt.
`clearLegacyBrowserStorage()` dọn các khoá của phiên bản cũ (không có `userId`, và
`git_credentials` từng nằm trong localStorage).

Khi storage đầy hoặc bị chặn, `saveDevelopSession` nuốt lỗi — IDE vẫn chạy, chỉ mất khả năng khôi phục.
