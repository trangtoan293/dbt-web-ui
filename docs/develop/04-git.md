# 04 — Git trong Develop

> Tham chiếu: `nextjs/src/components-v2/develop/workspace/{SourceControlPanel,CommitHistory}.tsx`,
> `develop/git/GitCredentialDialog.tsx`, `dbt-runner/app/routers/git.py`,
> `dbt-runner/app/services/git_service.py`.

## 1. Sidebar tab `git` — Source Control

`SourceControlPanel.tsx`. Nạp song song: `git status`, `git remote`, `git branch`, và
ahead/behind qua `git rev-list --left-right --count HEAD...@{upstream}` (lỗi thì im lặng —
branch có thể chưa có upstream).

### Đọc trạng thái file

Status porcelain hai ký tự được tách đúng chuẩn:

| Vị trí | Ý nghĩa |
|---|---|
| ký tự 1 (X) | đã stage — bất kỳ ký tự nào khác space |
| ký tự 2 (Y) | chưa stage |

`??` = untracked, `!!` = ignored. Một file có thể xuất hiện **ở cả hai nhóm** khi có cả
thay đổi đã stage lẫn chưa stage (ví dụ `MM`) — panel hiển thị đúng như vậy chứ không gộp.

### Thao tác

| Nút | Gọi |
|---|---|
| Stage / Unstage một file | `POST /git/add` / `POST /git/reset` với `[path]` |
| Stage all / Unstage all | cùng endpoint, không truyền path |
| **Commit** | `POST /git/commit {message, stage_all: true}` — stage tất cả rồi commit trong một bước |
| Discard một file | `POST /git/exec` → `checkout -- "<path>"` |
| Discard all | `checkout -- .` rồi `clean -fd` |
| Push / Pull / Sync | `POST /git/push` / `/git/pull`; Sync = pull rồi push |
| Xem diff | `onOpenDiff(path)` → mở `DiffEditor` ở khu vực editor |

Commit là đường một bước có chủ đích: người dùng chính của UI này không phân biệt
staging area. Ai cần stage riêng vẫn có nút từng file.

### Danh tính commit

Runner **không nhận** author từ client. `_get_commit_identity(claims)` lấy từ OIDC claims:
`email` (bắt buộc — thiếu thì trả **400**) và `name` / `preferred_username` / fallback về email.

## 2. Credential

`GitCredentialDialog.tsx` + bảng `git_credentials`.

Luồng `handlePush` / `handlePull`:

```
thử push/pull không kèm credential
  └─ thất bại do auth → mở GitCredentialDialog kèm message lỗi
        └─ nhập username + PAT → gọi lại endpoint kèm credential
```

`_resolve_credentials()` phía runner:

1. Có `username` + `token` trong request → dùng luôn.
2. Không có → tra `git_credentials` theo `(project_id, owner, remote_url)`.
3. Vẫn không có → chạy trần, để git tự báo lỗi.

Lưu trữ:

- Unique `(projectId, owner, remoteUrl)` — **credential thuộc về từng người dùng**,
  không dùng chung giữa các thành viên.
- `tokenEncrypted` được mã hoá bằng `encrypt_secret()`.
- **Chỉ lưu cho remote `https://`**; ssh remote bị bỏ qua.
- Token được truyền cho git qua biến môi trường (`_get_http_auth_env`), không nằm trên
  dòng lệnh — argv là thứ mọi tiến trình trên máy đọc được.

Frontend **không** còn giữ credential trong `localStorage`/`sessionStorage`;
`clearLegacyBrowserStorage()` dọn các khoá `git_credentials` của bản cũ khi mở IDE.

## 3. Sidebar tab `history`

`CommitHistory.tsx` → `GET /git/log/{project_id}?limit=50`. Hiển thị hash ngắn, tác giả,
thời gian, message.

## 4. `/git/exec` và giới hạn

`POST /git/exec` chạy `git <command>` trong thư mục project, tách tham số bằng `shlex.split`.

Chặn duy nhất, nhưng quan trọng: `_has_external_config_scope()` từ chối mọi
`git config` mang `--global` / `--system` / `--file` / `-f` — nếu không, một lệnh gõ trong
ô terminal sẽ sửa được config git của toàn máy chủ, ảnh hưởng mọi project.

Trong ô terminal của Develop, `git push` và `git pull` **không** đi qua `/git/exec`:
chúng mở dialog credential trước, vì `exec` không có đường nhập mật khẩu.

## 5. Clone

`POST /git/clone` — dùng ở `/develop/new` và khi khôi phục project.

- `_ensure_full_history()` xử lý repo được clone nông trước đó.
- Sau clone thành công, credential được lưu vào `git_credentials` (nếu là https).
- `git_project_subdirectory` cho phép dbt project nằm trong thư mục con của repo;
  TopBar hiển thị nó dưới nhãn *Worktree dir*, mặc định là "Repository root".

## 6. Git status trong phần còn lại của IDE

`loadGitStatus()` được gọi lại sau: lưu file, tạo/xoá/đổi tên/di chuyển file, mỗi sự kiện
từ file watcher, và sau `checkout`/`reset` gõ trong terminal. Kết quả nuôi badge trên
TopBar (`Clean` / `N changed`) và dấu chấm màu trên File Explorer.
