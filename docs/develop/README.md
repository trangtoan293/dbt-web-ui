# Develop — Tài liệu kỹ thuật

> Phạm vi: **chỉ** chức năng Develop của dbt-craft (dbt Web UI).
> Các mục Orchestrate / Explore / Data / Settings không nằm trong tài liệu này.
>
> Mã nguồn tham chiếu:
> `nextjs/src/app/(app)/develop/`, `nextjs/src/components-v2/develop/`,
> `dbt-runner/app/routers/{dbt,files,git,sse,project}.py`,
> `dbt-runner/app/services/{dbt_service,file_service,git_service,project}.py`.

## 1. Develop là gì

Develop là IDE chạy trong trình duyệt cho một dbt project: duyệt file, sửa SQL/YAML,
chạy lệnh dbt và xem log realtime, preview kết quả, xem compiled SQL, query plan,
lineage, và commit/push qua Git — tất cả trong một màn hình.

Hai màn hình:

| Route | Thành phần | Vai trò |
|---|---|---|
| `/develop` | `app/(app)/develop/page.tsx` → `ProjectList` | Danh sách project, tìm kiếm, xoá |
| `/develop/new` | `NewProjectForm` | Tạo project (clone Git hoặc `dbt init`) |
| `/develop/[projectId]` | `DevelopLayout` | Toàn bộ IDE |

`DevelopLayout.tsx` (~2.200 dòng) là component chủ: nó giữ **toàn bộ state của IDE**
và truyền xuống các panel con. Muốn hiểu luồng nào cũng bắt đầu từ đây.

## 2. Kiến trúc một thao tác

```
Browser (Next.js)                  dbt-runner (FastAPI)              Máy chủ
────────────────────               ────────────────────              ───────
DevelopLayout state
   │
   ├─ filesApi.*        ──HTTP──►  /files/{project_id}/*       ──►  workspace/{project_id}/
   ├─ gitApi.*          ──HTTP──►  /git/*                      ──►  git CLI
   ├─ dbtApi.*          ──HTTP──►  /dbt/{compile,preview,...}  ──►  dbt CLI / warm worker
   ├─ useDbtRunStream   ──SSE ──►  POST /sse/dbt/{project_id}  ──►  subprocess dbt, stream stdout
   └─ useFileWatcher    ──SSE ◄──  GET  /sse/files/{project_id} ◄──  watchdog
```

Điểm quan trọng:

- **Frontend không bao giờ gọi dbt trực tiếp.** Mọi lệnh đi qua dbt-runner, nơi có
  khoá per-project, semaphore toàn cục, budget bộ nhớ DuckDB và ghi lịch sử run.
- **`profiles.yml` được sinh lại từ database trước mỗi lệnh**
  (`DbtService._regenerate_profiles_from_db`). File trên đĩa không phải nguồn sự thật
  khi project có connection.
- **Xác thực độc lập.** dbt-runner tự verify JWT và tự kiểm tra quyền sở hữu project
  (`_verify_project_ownership`) — không tin frontend.

## 3. Mục lục

| Tài liệu | Nội dung |
|---|---|
| [01 — Workspace](./01-workspace.md) | Bố cục IDE, File Explorer, Editor, tab, phím tắt, terminal panel, IntelliSense, lưu phiên |
| [02 — Chạy dbt](./02-chay-dbt.md) | SSE log stream, menu lệnh, target & args, Preview / Compile / Explain / Lineage, docs, concurrency |
| [03 — Cấu hình project](./03-cau-hinh-project.md) | Tạo project, Project settings, Environments (targets), Variables, Lakehouse, Danger zone, cơ chế sinh `profiles.yml` |
| [04 — Git](./04-git.md) | Source Control panel, credential, clone/pull/push, history |
| [05 — API reference](./05-api.md) | Bảng endpoint dbt-runner mà Develop dùng |
| [06 — Xử lý sự cố](./06-su-co.md) | Lỗi thường gặp và nguyên nhân gốc |

## 4. Quy ước đọc

- Đường dẫn file luôn tương đối từ gốc repo.
- "Runner" = service `dbt-runner`. "Frontend" = app Next.js.
- Mọi đường dẫn file trong project là **tương đối so với thư mục project**
  (`workspace/{project_id}/`), không bao giờ là đường dẫn tuyệt đối trên máy chủ.
