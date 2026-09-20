# 03 — Cấu hình project

> Tham chiếu: `nextjs/src/components-v2/develop/NewProjectForm.tsx`,
> `develop/settings/{ProjectSettingsDialog,TargetsPanel,EnvVarsPanel,LakehousePanel}.tsx`,
> `dbt-runner/app/services/dbt_service.py` (`_regenerate_profiles_from_db`, `_render_target`),
> `nextjs/prisma/schema.prisma`.

## 1. Tạo project — `/develop/new`

Hai kiểu, chọn ở `project_type`:

| Kiểu | Sau khi tạo row DB |
|---|---|
| `dbt_init` | `POST /dbt/init` → scaffold một dbt project mới |
| `git_clone` | `POST /git/clone` → clone repo |

Luồng của `handleSubmit` (thứ tự quan trọng):

```
createProject(...)                       → row dbt_projects, syncStatus "pending"
updateProject(id, {syncStatus:"syncing"})
  ├─ dbt_init  → dbtApi.init(id, name)
  └─ git_clone → gitApi.clone(id, url, branch, username, token)
updateProject(id, {syncStatus: "synced" | "error"})
router.push(`/develop/${id}`)
```

Row project **được tạo trước**, nên clone/init thất bại vẫn để lại project mở được
(trạng thái `error`) thay vì mất trắng thao tác.

Với `git_clone`, form **bắt buộc** username + Personal Access Token — không có đường
clone ẩn danh trong UI. `getErrorMessage()` dịch các lỗi git thô
(`could not read Username`, `Authentication failed`, `Remote branch … not found`)
thành hướng dẫn cụ thể.

Trường khác: name, description, connection (warehouse), và ba thư mục layer
(`raw_layer_dir`, `staging_dir`, `business_dir`).

## 2. Project settings

Một dialog duy nhất: `settings/ProjectSettingsDialog.tsx`. Mọi cấu hình phạm vi project
đều thuộc về đây — **không tạo dialog mới**.

Mở bằng: dropdown tên project → *Project settings*, nút Database ở RightPanel, hoặc
query string `?settings=<tab>` (ví dụ `/develop/{id}?settings=lakehouse` — luồng ingest
gửi người dùng thẳng tới đây khi project chưa gắn lakehouse).

| Tab | Nội dung |
|---|---|
| `general` | Đổi tên, thông tin chỉ đọc: branch, remote, worktree, project ID; chọn connection |
| `environments` | `TargetsPanel` — các target phụ |
| `lakehouse` | `LakehousePanel` — gắn DuckLake, `+database: lake` |
| `variables` | `EnvVarsPanel` — biến môi trường |
| `danger` | Xoá mềm / khôi phục / xoá vĩnh viễn |

## 3. Target (Environments)

**Quy tắc nền:** `connectionId` của project **luôn là target `dev`**. Mọi target khác là
một dòng `project_targets`.

`TargetsPanel`:

- Thêm target = `{ name, connectionId }` → `POST /api/targets`.
- Tên phải khớp `TARGET_NAME_RE` (chữ thường, số, gạch dưới, bắt đầu bằng chữ, ≤30 ký tự).
- Nút hình khiên mỗi dòng gọi `GET /dbt/check-target/{project_id}?target=<name>` — kiểm tra
  **đúng target đó**, hiện ✓ / ✗ kèm message.
- Xoá target đang được chọn sẽ tự đưa lựa chọn về `dev`, nếu không mọi lệnh sẽ mang
  `--target` mà dbt từ chối.

**Chỉ `connections` mới làm được target.** Panel lọc bỏ:
- lakehouse (`ducklake`) — nó là catalog để DuckDB *attach*, không phải warehouse;
- `dremio_sources` (bảng cũ) — không phải dòng `connections`.

Cho chọn hai thứ đó từng tạo ra target biến mất khỏi `profiles.yml` trong im lặng, để
`dbt --target x` báo lỗi về một target mà UI vẫn liệt kê.

Target đang chọn lưu ở `localStorage` `dbt-target:{userId}:{projectId}`. Khi khác `dev`,
TopBar hiện một chip cảnh báo — không phải control, chỉ để nhìn thấy mà không cần mở gì.

## 4. Variables (biến môi trường)

Bảng `dbt_environment_variables`, unique theo `(projectId, owner, name)` — **biến là của
từng người dùng trên từng project**, không dùng chung.

- `type`: `text` | `password`.
- `valueEncrypted` luôn được mã hoá; **giá trị không bao giờ trả về trình duyệt**.
  API chỉ trả `hasValue: boolean`.
- Khi lưu, ô để trống + `hasValue = true` → gửi `keepExisting: true`, giữ nguyên giá trị cũ.
- `sanitize_dbt_environment()` phía runner lọc tên biến trước khi đưa vào môi trường process.

API: `GET|PUT /api/projects/{projectId}/env-vars` (PUT là replace toàn bộ danh sách).

## 5. Sinh `profiles.yml`

Đây là cơ chế then chốt của Develop: **`profiles.yml` trên đĩa không phải nguồn sự thật.**
`DbtService._regenerate_profiles_from_db(session, project_id, project_path)` chạy **trước
mỗi lệnh dbt**, cả đường SSE lẫn HTTP.

```
đọc dbt_projects → connection_id, dremio_source_id
đọc project_targets → các target phụ
đọc dbt_project.yml → profile_name  (khoá `profile`, fallback `name`)
_resolve_lakehouse() một lần cho cả project
cho từng target:
    _render_target() → outputs[target_name] + biến env chứa secret
ghi profiles.yml  { <profile_name>: { target: dev, outputs: {...} } }
trả về dict env (secret) cho tiến trình dbt
```

Các quyết định đáng nhớ:

| Tình huống | Hành vi |
|---|---|
| Project **không có** connection nào và không có target | Không đụng `profiles.yml` — người dùng tự quản lý. Chỉ sửa target DuckDB in-memory hỏng của bản cũ, và attach lakehouse nếu có |
| Có connection nhưng **render thất bại** | **Raise `DbtOperationError`**, không fallback về file trên đĩa — profile cũ sẽ trỏ dbt vào sai warehouse trong im lặng |
| Một target render lỗi, các target khác OK | Target lỗi được ghi vào `skipped` và báo cáo; các target còn lại vẫn được ghi. (Trước đây một target hỏng làm cả profile đóng băng) |
| Không có `dbt_project.yml` | Trả `{}` |

**Mỗi target cần biến secret riêng** — `DbtService.target_secret_env(target)` sinh tên biến
khác nhau cho từng target, nếu không output render sau sẽ đè output trước.

Lakehouse chỉ được attach cho **target DuckDB**; phần từ chối nằm *sau* vòng lặp target,
nếu không một target Dremio sẽ làm hỏng cả profile.

Endpoint chẩn đoán: `GET /dbt/check-connection/{project_id}` trả về 3 điều kiện
(có connection / tên profile khớp / có session) kèm preview `profiles.yml` sinh ra
và bản đang nằm trên đĩa — password đã redact (`_redact_profiles_yml`).
Ép sinh lại: `POST /dbt/regenerate-profiles/{project_id}`.

## 6. Lakehouse

`LakehousePanel` gắn một dòng `connections` kiểu `ducklake` vào
`dbt_projects.lakehouseConnectionId` — tách khỏi `connectionId` vì lake nằm *cạnh*
warehouse, và một lake có thể dùng chung cho nhiều project.

`+database: lake` trong `dbt_project.yml` được sửa theo **từng dòng**, không round-trip YAML:
`dbt_project.yml` đầy comment mà một vòng parse/serialize sẽ xoá sạch.

Chi tiết lakehouse nằm ngoài phạm vi tài liệu Develop — xem `CLAUDE.md` mục *Lakehouse*.

## 7. Danger zone

| Hành động | Frontend | Runner | Kết quả |
|---|---|---|---|
| Xoá mềm | `softDeleteProject` | `POST /project/delete {hard_delete:false}` | `deleted_at` được set, file xoá khỏi workspace, còn khôi phục được |
| Khôi phục | `restoreProject` | `POST /project/restore` | Kéo lại file từ storage nếu có |
| Xoá vĩnh viễn | `hardDeleteProject` | `POST /project/delete {hard_delete:true}` | Xoá row + file, không hoàn tác |

Thứ tự luôn là **xoá file trước, xoá row sau** (`deleteProjectFiles()` rồi mới gọi API
Prisma) — ngược lại sẽ để lại thư mục mồ côi mà không còn project ID nào trỏ tới.

Project đã xoá mềm vẫn mở được trong IDE ở chế độ chỉ đọc; TopBar hiện badge `Deleted`
và menu chỉ còn lối vào tab `danger`.
