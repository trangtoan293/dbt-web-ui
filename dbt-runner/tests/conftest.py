import os

os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")
os.environ.setdefault("WORKSPACE_DIR", "/tmp/dbt-craft-test-workspace")
os.environ.setdefault("DATABASE_URL", "postgresql://dbtcraft:dbtcraft@localhost:5432/dbtcraft")
