# 06 — Xử lý sự cố

> Mỗi mục: triệu chứng → nguyên nhân gốc → cách xử lý. Vị trí code kèm theo để tra tiếp.

## Chạy lệnh

**"A dbt command is already running for this project."**
`commandInFlightRef` đang giữ slot. Lệnh trước chưa kết thúc (hoặc kết thúc mà không phát
`completed`/`error`). Bấm **Stop** rồi chạy lại. Ref chỉ được nhả trong
`onCommandComplete` / `onError` — nếu stream bị cắt giữa chừng, Stop là đường thoát.
`DevelopLayout.tsx` → `claimCommandSlot`.

**HTTP 429 khi Run.**
`global_run_semaphore` đầy: số dbt run đồng thời trên toàn deployment đã chạm
`MAX_CONCURRENT_DBT_RUNS`. Chờ, hoặc tăng biến môi trường — nhưng nhớ rằng tăng
concurrency sẽ **thu nhỏ ngân sách bộ nhớ của từng run** (`concurrent_engine_slots()`
trong `app/core/duckdb_resources.py`).

**`Conflicting lock` / "Could not set lock on file".**
DuckDB là single-writer và warm worker đang giữ file `.duckdb`. `run_command` tự retry 3
lần cách nhau 2s. Nếu vẫn hỏng: một tiến trình khác (docs server, query console) đang mở
cùng file — `release_project()` phải chạy trước khi ghi đè.

**Lệnh chạy nhưng vào sai warehouse.**
Kiểm tra target: TopBar chỉ hiện chip khi target **khác `dev`**. Dòng echo trong Logs mang
đúng `--target` thực chạy — đọc dòng đó, đừng đoán. `localStorage` `dbt-target:{userId}:{projectId}`.

**Rời trang thì lệnh có dừng không?** Không. `activeStreams` nằm ngoài React, process vẫn
chạy và log được phát lại khi quay lại IDE. Muốn dừng thật thì bấm Stop.

## profiles.yml & kết nối

**`dbt debug` báo profile sai dù UI hiển thị đúng connection.**
`profiles.yml` được sinh lại từ DB trước mỗi lệnh. Chạy `GET /dbt/check-connection/{id}`
để so bản sinh ra với bản trên đĩa. Ba điều kiện cần đúng: có connection, `profile:` trong
`dbt_project.yml` khớp tên profile, và có DB session.

**Sửa tay `profiles.yml` rồi bị mất.**
Đúng như thiết kế: project **có** connection thì file bị ghi đè. Muốn tự quản lý profile
thì gỡ connection và mọi target — lúc đó runner không đụng vào file
(`_regenerate_profiles_from_db` trả `{}`).

**Một target biến mất khỏi `profiles.yml`.**
Target đó render lỗi và bị đưa vào `skipped`. Các target khác vẫn được ghi. Bấm nút khiên
ở dòng target đó trong tab *Environments* để xem lỗi thật.

**Hai target dùng chung mật khẩu / target sau đè target trước.**
Mỗi target phải có biến secret riêng — `DbtService.target_secret_env(target)`. Nếu tự thêm
adapter mới, giữ nguyên quy ước này.

**Connection kiểu `mysql`, `rest`, `ducklake` không chọn được làm warehouse.**
Cố ý: chúng không có dbt adapter. `build_adapter_config_from_connection_row` từ chối kèm
message. `TargetsPanel` cũng lọc chúng khỏi danh sách target.

## File & editor

**File do assistant/git tạo không hiện trong cây.**
`/files/{id}` trả một cấp. `refreshAncestors()` nạp lại mọi thư mục cha **đã mở** trên
đường tới file thay đổi. Nếu vẫn thiếu: kiểm tra SSE file watcher còn kết nối không
(chỉ báo trong File Explorer) — mất kết nối thì tự reconnect sau 2s.

**Sửa file rồi nội dung bị nhảy về bản cũ.**
Watcher nạp lại file khi nhận `modified` và tab **không dirty**. Tab dirty không bao giờ bị
ghi đè. File vừa tự lưu được bỏ qua nhờ `recentlySavedFilesRef` (hết hạn sau 3s).

**Format không đổi gì.**
`POST /dbt/format` dùng sqlglot và **từ chối** khi không parse chắc chắn (Jinja phức tạp,
dialect lạ). Khi đó formatter cục bộ chạy thay và một dòng `[INFO]` được ghi vào Logs.

**Preview/Compile/Run trên draft báo lỗi.**
`ensureSavedSqlFile()` sẽ hỏi lưu trước — dbt đọc file trên đĩa, không đọc editor.
Hủy hộp thoại lưu thì lệnh không chạy.

**Gợi ý `ref()` nghèo nàn hoặc không có cột.**
IntelliSense đọc `target/manifest.json` (và `catalog.json` cho cột). Chạy `dbt parse`
để có manifest, `dbt docs generate` để có catalog. `status: missing_manifest` nghĩa là
project chưa parse lần nào.

**Lineage trống.**
Cần `manifest.json`. Lineage cột cần `sqlglot` — import có điều kiện, thiếu thì chỉ mất
phần cột chứ lineage bảng vẫn chạy.

## Git

**Push/pull báo lỗi auth lặp lại.**
Credential lưu theo `(project_id, owner, remote_url)`. Đổi remote URL → credential cũ không
khớp nữa. Chỉ remote `https://` được lưu; ssh không.

**Commit trả 400.**
OIDC claims không có `email`. Danh tính commit lấy từ claims, không nhận từ client
(`_get_commit_identity`).

**`git config --global` trong terminal bị từ chối.**
Cố ý — `_has_external_config_scope()`. Config ngoài phạm vi repo sẽ ảnh hưởng mọi project
trên máy chủ.

**Terminal: `git push` không chạy như các lệnh git khác.**
`push`/`pull` mở dialog credential trước; `/git/exec` không có đường nhập mật khẩu.

## Phiên & trạng thái UI

**Mở lại tab thì mất hết tab đang mở.**
Phiên nằm trong `sessionStorage` — đóng tab trình duyệt là mất. Chỉ ba thứ sống lâu trong
`localStorage`: extra args, `--full-refresh`, target.

**Trạng thái của người dùng khác hiện lên.**
Không thể: khoá phiên có `{userId}` và effect khôi phục chỉ chạy sau khi có `userId`.
Nếu gặp, đó là khoá cũ chưa được `clearLegacyBrowserStorage()` dọn.

**Panel dbt assistant không xuất hiện.**
`AGENT_URL` rỗng → proxy trả 503 và `useAgentAvailability` ẩn nút. Không phải lỗi.

## Nơi đọc tiếp

| Vấn đề | File |
|---|---|
| State và mọi handler của IDE | `nextjs/src/components-v2/develop/DevelopLayout.tsx` |
| Ghép câu lệnh dbt | `nextjs/src/lib/dbt-command-args.ts` |
| Stream log | `nextjs/src/lib/hooks/useDbtRunStream.ts`, `dbt-runner/app/routers/sse.py` |
| Chạy dbt, profile, compile/preview/explain | `dbt-runner/app/services/dbt_service.py` |
| Khoá & warm worker | `app/core/file_lock.py`, `app/core/global_semaphore.py`, `app/services/dbt_worker.py` |
| An toàn đường dẫn file | `dbt-runner/app/services/{file_service,project}.py` |
| Git | `dbt-runner/app/services/git_service.py` |
