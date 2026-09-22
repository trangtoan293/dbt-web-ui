1. Tôi muốn develop cơ chế authorization dựa vào user id và permission
2. Tạm thời bước authen đã thông qua Keycloak nên có thể bỏ qua và tạo users trên keyloak để sử dụng
3. Status hiện tại: các projects đều dựa vào fields created_by để show project dbt
5. Tôi muốn develop thêm cơ chế và các tính năng như sau: \
- quyền dựa vào 3 roles cơ bản nhất: admin, contributor và user
  - admin: có quyền xem, sửa, xóa (view, edit, delete) tất cả mọi thứ, ko hạn chế
  - contributor: có quyền sửa, xóa(edit, delete) dựa vào project_id mà admin thêm vào
  - user: chỉ có quyền xem(view) các projects và tính năng do admin và contributor thêm vào
- Thêm một màn hình quản lý user cho admin giống như các màn hình menu trên left sidebar như Home, Develop, ..., Data
- Verify cả trên backend + frontend để tránh bị spoil 1 trong 2
- Các thông tin permisisons chứa trên database postgres
- Một user có thể có nhiều permissions
- Sau này có thể phát triển theo kiểu: user được add vào một group A, với group A có permission X, Y, ... thì user A mặc định có các quyền trong group đuợc add vào
- Một user có thể được add vào nhiều group
