anh đang muốn thực hiện dự án về data platform có tích hợp AI
cụ thể hơn , anh muốn data platform này có tích hợp sâu với AI
AI sẽ giúp anh làm các công việc về :
1/ tạo bộ biz domain về lĩnh vực có liên quan đến khách hàng ( tạo bộ ontology basic về )
2/ reseach các metrics , semantics layer phổ biến và quan trọng với ngành nghề mà người dùng yêu cầu
3/ kết nối đến các dữ liệu nguồn của khách hàng :
    * các database phổ biến ( postgres, oracle , mysql, sql server, mongo , v.v )
    * kết nối đến với các API phổ biến
    * dữ liệu docs mà người dùng upload lên 
4/ có khả năng ingest dữ liệu về local database để thực thi các transformation - anh ưu tiên cái nào nhẹ , nhanh và mạnh ( có thể refer ingest về clickhouse hoặc duckdb )
5/ cỏ khả năng tạo ra metadata + data dictionary cho toàn bộ dữ liệu được ingest vào
6/ thực hiện việc chuẩn hóa metadata và data dictionary  + biz domain ở bước (2) để tạo ra được một bộ ontology chuẩn về ngành 
7/ khi đã ingest về database local , lúc này AI sẽ dựa vào các metrics + dữ liệu đc ingest + data dictionary => tổng hợp và chuẩn hóa giữa data và ontology
    * dữ liệu là data có cấu trúc ( sql)
    * dữ liệu mối quan hệ giữa các concept entities của biz domain ( nên được lưu dưới dạng graph )
    * dữ liệu là metrics - dữ liệu thứ cấp được tính toán từ dữ liệu thô
    * dữ liệu là nội dung docs mà người dùng upload lên
    * dữ liệu là data dictionary
8/ dựa vào các dữ liệu đã có , em tạo các kịch bản thường gặp về ngành nghề mà khách hàng đang vướng 
8/ sau khi đã có bộ ontology và các kịch bản đầy đủ, em dựa vào các thông tin này , đề xuất ra ít nhất 5-8 chủ đề có thể present được cho người dùng .
9/ từ đó kể cho khách hàng các câu chuyện về công ty họ dựa vào các dữ liệu đã được ingest về

phân tích , đánh giá 
