# Known issues — Git / Source Control trong Develop (phiên 2026-09-21)

> Ghi lại để một phiên khác đọc và sửa ngay. Mọi mục dưới đây đã được **tái hiện hoặc đối chiếu với code**;
> phần suy luận được đánh dấu rõ. Số dòng tính trên working tree ngày 2026-09-21 (HEAD `24741c8`), có thể lệch.
> **Không có secret nào trong file này.** Token GitHub đã lộ trong chat phải bị thu hồi (xem §6).

## 0. Bối cảnh & cách chạy để tái hiện

- Stack chạy bằng `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d`
  (overlay dev mới: bind-mount `dbt-runner/{app,adapters,ingest}`, `dsh-agent/{app,dbt_mcp}`, `nextjs/prisma`;
  runner/agent chạy `uvicorn --reload`). Frontend chạy **trên host**: `cd nextjs && npm run dev` (cần `nextjs/.env.local`).
- Cổng: UI `:3000`, runner `:8081` (`BACKEND_PORT` trong `.env`), agent `:8090`, Postgres `:5434`.
- `AUTH_DISABLED=true` → runner coi mọi request là user local: `sub=local-user`, `email=local@dbt-craft.local`,
  **không có `name`** (`dbt-runner/app/core/auth.py:29-36`).
- Project dùng để tái hiện: `hoaipham-test-dbt1`, id `8792b0a3-8327-4b83-8f23-989ca1711b32`,
  thư mục `/tmp/dbt-projects/<id>/` trong container `dbt-craft-runner` (volume `dbt-craft_dbt-projects`).
- Remote: `https://github.com/hoaipham-ru/hoaipham-test-dbt.git` (**private**).
- Gọi thẳng runner (bỏ qua UI) để xem lỗi thật, vì access log chỉ ghi mã HTTP chứ không ghi thân phản hồi:
  ```bash
  ID=8792b0a3-8327-4b83-8f23-989ca1711b32
  curl -s -X POST http://localhost:8081/git/fetch/$ID                       # fetch không credential
  curl -s -X POST http://localhost:8081/git/pull -H 'Content-Type: application/json' -d "{\"project_id\":\"$ID\"}"
  curl -s -X POST http://localhost:8081/git/push -H 'Content-Type: application/json' -d "{\"project_id\":\"$ID\",\"remote\":\"origin\"}"
  ```
  Lưu ý: **push thất bại vẫn trả HTTP 200** với `"success": false` và `stderr`; fetch/pull thất bại trả **400** với `detail`.

## 1. Tóm tắt nguyên nhân (đã xác minh)

Token và quyền GitHub **không** có vấn đề (`git push --dry-run` với token qua đúng định dạng header của runner thành công).
Push/pull thất bại là do **4 lỗi code nối nhau + 1 thiếu sót cấu hình**, và UI che lỗi thật bằng thông báo sai:

| Người dùng thấy | Nguyên nhân thật |
|---|---|
| Fetch → `could not read Username` | Repo private, chưa có credential; nút Fetch **không gửi** credential (Bug 1). |
| Bấm Push chỉ báo "Push failed", không hỏi token | Dialog chỉ mở khi stderr chứa `Authentication`/`403`/`401` (Bug 2). |
| Nhập token vào dialog Pull vẫn "Authentication failed" | Pull hỏng vì lý do khác; UI gắn nhãn auth cho **mọi** lỗi pull (Bug 3). |
| Pull lỗi sau khi repo GitHub có commit đầu tiên | `git pull --rebase` cần committer identity, runner không truyền (Bug 4) → rebase kẹt giữa chừng. |

## 2. Bugs cần sửa

### Bug 1 — Nút Fetch không gửi credential (và dialog của nó chạy *pull*)
- `SourceControlPanel.tsx:627` `handleFetch` gọi `gitApi.fetch(projectId)` **không** kèm `username`/`token`
  (chữ ký `fetch(projectId, username?, token?)` ở `nextjs/src/lib/api/git.ts:317` có hỗ trợ).
- Khi gặp `could not read Username` (dòng ~646) nó mở dialog với `type: 'pull'`, nên submit dialog chạy `git pull`, **không** chạy lại fetch.
- Fix gợi ý: cho dialog có `type: 'fetch'` và `executePushPull` xử lý nhánh fetch; hoặc bỏ nút fetch riêng nếu không cần.
- Test: mock `gitApi.fetch` ném lỗi `could not read Username` → dialog mở → submit → `gitApi.fetch` được gọi lại **kèm credential**.

### Bug 2 — Push thiếu credential không mở dialog
- Runner trả `200 {"success": false, "stderr": "fatal: could not read Username for 'https://github.com': No such device or address"}`.
- `SourceControlPanel.tsx:434` (`handlePush`) chỉ mở dialog nếu `stderr` chứa `'Authentication'`, `'403'` hoặc `'401'`;
  `:488` (`executePushPull`) và `DevelopLayout.tsx:1702` cũng vậy. Chuỗi `could not read Username` **không khớp** → rơi vào `setError('Push failed')`.
- Runner đã có bộ nhận diện đúng: `_looks_like_auth_failure` (`git_service.py:34`, gồm `could not read username`).
  Cách gọn nhất: runner trả thêm trường `auth_required: true` (hoặc HTTP 401) và UI dựa vào đó, không so chuỗi.
- Workaround hiện tại: gõ `git push` trong **terminal** của Develop → mở dialog ngay (`DevelopLayout.tsx:1811`), không cần chờ lỗi.

### Bug 3 — Mọi lỗi pull bị hiển thị là "Authentication failed"
- `SourceControlPanel.tsx:505`: nhánh `else` của pull luôn `setCredDialog({..., error: 'Authentication failed.'})`;
  `handlePull` (`:446`) mở dialog ở cả `catch` lẫn `else`. Lỗi thật (`cannot pull with rebase: You have unstaged changes`,
  `couldn't find remote ref main`, `Committer identity unknown`) bị nuốt.
- Fix: chỉ mở dialog khi lỗi là xác thực; ngược lại hiển thị `detail` của runner. Phân loại phía runner (Bug 2).
- Thêm ca thứ 4 đã tái hiện (project `hoaipham-test2`, id `681cb7f8-121d-423d-9f2c-c704a80c13f0`): project mới có scaffold dbt **chưa commit**
  (12 file untracked) rồi `add remote` trỏ tới repo GitHub đã có cùng các đường dẫn đó → `git pull --rebase origin main` **đăng nhập được**
  (fetch ghi `FETCH_HEAD`/`origin/main` đúng giây bấm Pull) nhưng bước merge thất bại:
  `error: The following untracked working tree files would be overwritten by merge: .gitignore README.md dbt_project.yml …`.
  Runner trả 400, UI hiện "Authentication failed", và credential **không được lưu** (chỉ lưu sau thao tác thành công).
  Tái hiện không cần mạng: sao chép thư mục project ra `/tmp/scratch`, `git remote set-url origin file:///tmp/dbt-projects/<project-khác>`, chạy lại lệnh pull.
  Cách đúng để đưa repo có sẵn vào project mới là luồng **clone** (`NewProjectForm`, `POST /git/clone`), không phải add remote + pull.
  Ngoài ra `fetch` khi chưa có remote nào vẫn trả 200 "Fetched updates from remote" (`git fetch --all` không có gì để lấy) — dễ gây hiểu nhầm.

### Bug 4 — `git pull --rebase` chạy không có committer identity → rebase kẹt
- `git_service.py:188`: `cmd = ["git", "pull", "--rebase", "origin", request.branch or "main"]`, **không** truyền identity.
  `commit` thì có (`git -c user.name=… -c user.email=…`), nên chỉ pull/rebase bị. Container không có `~/.gitconfig`,
  không có `GIT_COMMITTER_*` → `Committer identity unknown`.
- Hậu quả quan sát được: rebase dừng sau commit đầu, repo ở **HEAD detached** (`## HEAD (no branch)`), 13 file ở trạng thái staged,
  `git rebase --continue` thất bại tiếp (`.git/rebase-merge/message` không tồn tại), và các lần Push sau đó vô ích
  (`push` lấy nhánh bằng `rev-parse --abbrev-ref HEAD` → `HEAD`, dòng ~281).
- Runner trả 400 → UI hiển thị "Authentication failed" (Bug 3).
- Fix: truyền identity cho pull (cùng hàm `_get_commit_identity` như commit: `-c user.name -c user.email`, hoặc env `GIT_COMMITTER_NAME/EMAIL`).
  Cân nhắc thêm: phát hiện `rebase-merge`/`rebase-apply` đang dở và trả lỗi rõ + nút "Abort rebase"; chặn push khi HEAD detached.
- Cách đã dùng để sửa repo thủ công (không mất commit): `git rebase --abort` (về `main`) rồi
  `GIT_COMMITTER_NAME="Local User" GIT_COMMITTER_EMAIL=local@dbt-craft.local GIT_EDITOR=true git rebase origin/main`.
- Bối cảnh: hai lịch sử **không liên quan** (repo GitHub có commit gốc riêng do upload qua web), `git merge-base` rỗng. Rebase vẫn chạy được.
- Test: `dbt-runner/tests/test_git_service.py` — thêm ca pull cần rebase trong repo không có config identity, kỳ vọng thành công.

### Bug 5 — Tên tác giả commit là email khi chạy `AUTH_DISABLED`
- `routers/git.py:31-41` `_get_commit_identity`: `name = claims.get("name") or claims.get("preferred_username") or email`.
  Claims của user local chỉ có `sub`+`email` (`core/auth.py:36`) → author = `local@dbt-craft.local <local@dbt-craft.local>`.
- Fix: thêm `"name": "Local User"` vào claims local (session phía frontend đã có `name: "Local User"`).

### Bug 6 — Project mới không ignore file DuckDB → `git add -A` đưa `dev.duckdb` vào commit
- Danh sách ignore mặc định ở `dbt-runner/app/services/storage_service.py:21` chỉ có `target/`, `dbt_packages/`, `logs/`, `__pycache__/`.
- `profiles.yml` sinh ra trỏ `path: 'dev.duckdb'` (trong thư mục project) và nút Commit dùng `stage_all` (`git add -A`)
  → `dev.duckdb` đã bị commit (`fe08a4f`) và **đã push lên GitHub** (12 KB, rỗng).
- Fix: thêm `*.duckdb`, `*.duckdb.wal` vào danh sách ignore/template `.gitignore`. Với project đã tồn tại: `git rm --cached dev.duckdb`.
  Lưu ý: DuckDB single-writer, `checkout`/`rebase` ghi đè file đang được worker giữ có thể xung đột.

### Bug 7 — Credential được lưu ngầm, `rememberMe` bị bỏ qua, tài liệu không khớp
- `handleCredentialSubmit` nhận `_rememberMe` nhưng không dùng (`SourceControlPanel.tsx:520`, `GitCredentialDialog.tsx:71` luôn gọi `onSubmit(username, token, false)`).
- Runner lưu (mã hoá, bảng `git_credentials`, khoá `(project_id, owner, remote_url)`) sau **mọi thao tác thành công**, kể cả `fetch`
  (`git_service.py`, cuối `fetch`), không có tuỳ chọn từ chối. Chỉ lưu remote `https://`. Thất bại kiểu xác thực thì **xoá** credential đã lưu.
- `docs/develop/04-git.md` mô tả hành vi này chưa đủ (không nói fetch cũng lưu). Nên cập nhật, hoặc thêm tuỳ chọn "Remember" thật.

### Bug 8 — Lỗi thật bị che ở nhiều lớp, khó gỡ
- Access log runner chỉ ghi `POST /git/pull 400`, **không** ghi `detail`; `push` thất bại (200) không ghi stderr ở đâu cả.
  Đề xuất log `WARNING` với stderr (đã che token) cho mọi thao tác git thất bại.
- Auth.js che lỗi DB: khi Postgres từ chối kết nối, `authErrorMessage('Configuration')` (`nextjs/src/lib/auth-errors.ts`) nói
  "Check OIDC_ISSUER, OIDC_CLIENT_ID…" ngay cả khi `AUTH_DISABLED=true`. Nguyên nhân thật (`PrismaClientInitializationError`) chỉ có trong log dev server.
  Đề xuất: khi `AUTH_DISABLED` thì hiển thị "không kết nối được cơ sở dữ liệu".

### Nhỏ / cần xem thêm
- Client warnings trong `/client-logs`: `Uncaught [object Event]` (lặp lại) và Monaco
  `TextModel got disposed before DiffEditorWidget model got reset` khi mở diff. Chưa điều tra.
- **Chưa điều tra:** 2 lần chạy `dbt run` của project này đều `status=error` (08:28 và 09:41 UTC, run `a3211e23-c734-4d22-945f-8344a5b42c02`;
  `sse persist_complete … status=error elapsed_ms=5`). Đọc bảng `dbt_runs.log`/`GET /dbt/runs` để lấy lỗi.

## 3. Trạng thái dữ liệu sau phiên (để khỏi tái hiện lại)

- GitHub `main` = local `main` = `01f401b`; lịch sử: `792bc8c` (CLAUDE.md, upload web) → `2d9e16d` → `fe08a4f` → `01f401b`.
  Hash 3 commit local **đã đổi** so với trước rebase (`13a9c21→2d9e16d`, `bae02d1→fe08a4f`, `cc94eec→01f401b`); bản cũ còn trong reflog.
- `git_credentials` có 1 dòng (`hoaipham-ru`, token mã hoá). Lịch sử dòng này:
  - 10:28:22 UTC: tạo bởi lần gọi `POST /git/fetch` kèm credential của *trợ lý Claude* khi tái hiện lỗi (không qua UI;
    `fetch()` tự lưu credential sau khi thành công). Dòng này giúp lần Push 13:42 thành công.
  - Sau đó dòng bị **xoá** để kiểm tra luồng UI cho đúng.
  - **13:57:44 UTC: luồng UI đã tạo lại dòng — xác minh xong.** Chuỗi request quan sát được:
    `POST /git/fetch 400` (nút Fetch không gửi credential — Bug 1) → dialog → `POST /git/pull 200` kèm username+token
    → `created_at` = `updated_at` = 13:57:44 (insert đầu tiên). Nghĩa là **dialog có gửi credential xuống runner và runner có lưu**
    sau thao tác thành công; lỗi nằm ở chỗ *khi nào* dialog mở và nhãn lỗi (Bug 1-3), không phải ở việc lưu.
  - Chưa kiểm tra sau bước này: nút Fetch lần hai (kỳ vọng 200, không dialog) và Bug 2 (Push thiếu credential không mở dialog) — cần xoá dòng rồi thử lại.

## 4. Những thay đổi đã làm ngoài code ứng dụng (minh bạch)

- Thêm `docker-compose.dev.yml` (overlay dev) và `nextjs/.env.local` (gitignored, sinh từ `.env`; lần đầu `DATABASE_URL` bị sinh sai — thiếu user/db — đã sửa).
- Backup DB trước khi migrate: `C:\Users\LENOVO\backups\dbtcraft-20260921-1409.sql` (chỉ metadata, **không** gồm volume `dbt-projects`).
- Build lại image `db-migrate`, `dbt-runner`, `dsh-agent`; áp 3 migration mới (`20260825090000`, `20260825090100`, `20260827090000`).
- Sửa repo git của project ở trên bằng abort + rebase (mục Bug 4). Không sửa code ứng dụng nào.

## 5. Thứ tự sửa đề xuất

1. Bug 4 (identity cho pull) — chặn nhất, có test dễ viết trong `test_git_service.py`.
2. Bug 2 + Bug 3 (phân loại lỗi xác thực ở runner; UI dựa vào đó thay vì so chuỗi).
3. Bug 1 (fetch có credential + dialog fetch).
4. Bug 6 (`*.duckdb` vào ignore) và Bug 5 (`name` cho user local).
5. Bug 8 (log stderr đã che token; thông báo lỗi DB khi `AUTH_DISABLED`), cập nhật `docs/develop/04-git.md` (Bug 7).
6. Điều tra 2 lần `dbt run` lỗi.

Chạy test: `cd dbt-runner && uv run --frozen --extra test pytest -q tests/test_git_service.py`; frontend: `cd nextjs && npm run test:unit`
(`npm test` cần DB test, `test/setup.ts` từ chối `DATABASE_URL` không chứa "test").

## 6. Việc bảo mật còn treo

- Personal Access Token GitHub của tài khoản `hoaipham-ru` và mật khẩu Postgres dev **đã xuất hiện trong lịch sử chat**
  → thu hồi token (GitHub → Settings → Developer settings → Personal access tokens), cân nhắc đổi `POSTGRES_PASSWORD` (+ `DATABASE_URL`, `nextjs/.env.local`).
  Sau khi thu hồi, dòng `git_credentials` sẽ hết hiệu lực; lần push kế tiếp sẽ cần nhập token mới.
- Token không bao giờ được đặt vào tham số dòng lệnh hay file trong repo; runner truyền qua biến môi trường `GIT_CONFIG_*` (đã đúng).
