.PHONY: setup lint test build compose-validate

setup:
	cd nextjs && npm ci && npx prisma generate
	cd dbt-runner && uv sync --frozen --extra test
	cd python-runner && uv sync --frozen --extra test

lint:
	cd nextjs && npm run lint

test:
	cd nextjs && npm test
	cd dbt-runner && uv run --frozen --extra test python -m pytest -q
	cd python-runner && uv run --frozen --extra test python -m pytest -q

build:
	cd nextjs && npm run build

compose-validate:
	POSTGRES_PASSWORD=local-validation \
	APP_ENCRYPTION_KEY=local-validation \
	KEYCLOAK_ISSUER=https://id.example.test/realms/local \
	KEYCLOAK_JWKS_URI=https://id.example.test/realms/local/protocol/openid-connect/certs \
	OAUTH2_CLIENT_ID=local-validation \
	OAUTH2_CLIENT_SECRET=local-validation \
	OAUTH2_COOKIE_SECRET=local-validation \
	docker compose config --quiet
