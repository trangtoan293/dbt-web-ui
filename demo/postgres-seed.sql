-- Dummy source data for trying out ingest.
--
-- Runs once, when the demo-source container initialises its data directory.
-- Three related tables so a dbt model built on top of them has something to
-- join, and an updated_at column so incremental loads have a cursor to use.

CREATE TABLE customers (
    id          integer PRIMARY KEY,
    name        text        NOT NULL,
    city        text        NOT NULL,
    segment     text        NOT NULL,
    created_at  date        NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
    id          integer PRIMARY KEY,
    sku         text        NOT NULL UNIQUE,
    name        text        NOT NULL,
    category    text        NOT NULL,
    unit_price  numeric(12, 2) NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
    id           integer PRIMARY KEY,
    customer_id  integer NOT NULL REFERENCES customers (id),
    product_id   integer NOT NULL REFERENCES products (id),
    quantity     integer NOT NULL,
    amount       numeric(12, 2) NOT NULL,
    status       text    NOT NULL,
    ordered_at   date    NOT NULL,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO customers (id, name, city, segment, created_at) VALUES
    (1,  'Nguyen Van An',    'Ha Noi',      'enterprise', '2024-01-15'),
    (2,  'Tran Thi Binh',    'Ho Chi Minh', 'sme',        '2024-02-03'),
    (3,  'Le Van Cuong',     'Da Nang',     'sme',        '2024-02-20'),
    (4,  'Pham Thi Dung',    'Ha Noi',      'retail',     '2024-03-11'),
    (5,  'Hoang Van Em',     'Can Tho',     'retail',     '2024-04-02'),
    (6,  'Vu Thi Giang',     'Ho Chi Minh', 'enterprise', '2024-04-18'),
    (7,  'Dang Van Hung',    'Hai Phong',   'sme',        '2024-05-07'),
    (8,  'Bui Thi Lan',      'Da Nang',     'retail',     '2024-05-29'),
    (9,  'Do Van Minh',      'Ha Noi',      'sme',        '2024-06-14'),
    (10, 'Ngo Thi Nga',      'Ho Chi Minh', 'enterprise', '2024-07-01');

INSERT INTO products (id, sku, name, category, unit_price) VALUES
    (1, 'SKU-001', 'Ca phe rang xay 500g', 'beverage', 185000.00),
    (2, 'SKU-002', 'Tra oolong 200g',      'beverage', 240000.00),
    (3, 'SKU-003', 'Banh quy bo hop thiec','snack',    320000.00),
    (4, 'SKU-004', 'Hat dieu rang muoi 1kg','snack',   450000.00),
    (5, 'SKU-005', 'Mat ong rung 500ml',   'grocery',  195000.00),
    (6, 'SKU-006', 'Gao ST25 5kg',         'grocery',  210000.00);

INSERT INTO orders (id, customer_id, product_id, quantity, amount, status, ordered_at) VALUES
    (1001, 1,  1, 10, 1850000.00, 'paid',      '2024-08-01'),
    (1002, 1,  4,  2,  900000.00, 'paid',      '2024-08-03'),
    (1003, 2,  2,  5, 1200000.00, 'paid',      '2024-08-05'),
    (1004, 3,  6, 20, 4200000.00, 'shipped',   '2024-08-07'),
    (1005, 4,  3,  1,  320000.00, 'paid',      '2024-08-09'),
    (1006, 5,  5,  4,  780000.00, 'cancelled', '2024-08-11'),
    (1007, 6,  1, 50, 9250000.00, 'paid',      '2024-08-12'),
    (1008, 6,  4, 10, 4500000.00, 'shipped',   '2024-08-14'),
    (1009, 7,  2,  3,  720000.00, 'paid',      '2024-08-16'),
    (1010, 8,  6,  8, 1680000.00, 'pending',   '2024-08-18'),
    (1011, 9,  3,  6, 1920000.00, 'paid',      '2024-08-19'),
    (1012, 10, 1, 30, 5550000.00, 'paid',      '2024-08-20'),
    (1013, 10, 5, 12, 2340000.00, 'paid',      '2024-08-20'),
    (1014, 2,  4,  1,  450000.00, 'pending',   '2024-08-21'),
    (1015, 3,  1,  4,  740000.00, 'paid',      '2024-08-21');

-- A read-only role, so the connection stored in the app cannot change the
-- source. Worth copying in production: ingest only ever needs SELECT.
CREATE ROLE ingest_reader WITH LOGIN PASSWORD 'demo_reader_pw';
GRANT CONNECT ON DATABASE crm TO ingest_reader;
GRANT USAGE ON SCHEMA public TO ingest_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ingest_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ingest_reader;
