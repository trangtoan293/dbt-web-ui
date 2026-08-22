import os

os.environ.setdefault("STORAGE_DIR", "/tmp/dbt-craft-test-storage")
os.environ.setdefault("WORKSPACE_DIR", "/tmp/dbt-craft-test-workspace")
os.environ.setdefault("DATABASE_URL", "postgresql://dbtcraft:dbtcraft@localhost:5432/dbtcraft")
# The scheduler is a background loop that talks to Redis and Postgres. Any test
# that builds the app (TestClient runs startup) would otherwise start it.
os.environ.setdefault("SCHEDULER_ENABLED", "false")
