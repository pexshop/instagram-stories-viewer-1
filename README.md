# Instagram Viewer

A mobile-friendly Instagram public-content viewer powered by a Cloudflare Worker and a separate Python service using the open-source Instaloader library.

## Architecture

- `public/index.html`: mobile-first website UI.
- `worker.js`: API gateway, request validation, rate limiting, and backend authentication.
- `instaloader-service/app.py`: Python/FastAPI bridge to Instaloader.
- `wrangler.toml`: existing Cloudflare Worker name, static asset binding, and Durable Object rate limiter.
- `render.yaml`: Render Docker service definition.

## Existing environment variables

This code update does not create, rename, delete, or change any deployment variables or secrets.

The Worker continues to read:
- `INSTALOADER_SERVICE_URL` (HTTPS base URL, plain-text variable)
- `INSTALOADER_SERVICE_TOKEN` (encrypted secret)

The Python service continues to read:
- `INSTALOADER_SERVICE_TOKEN` (same secret value as the Worker)
- Optional `INSTALOADER_LOGIN_USER`
- Optional `INSTALOADER_SESSION_FILE`

Keep existing values unchanged. Never commit secrets, Instagram passwords, or session files to GitHub.

## Supported features

- Public profile information and recent posts
- Profile posts and Reels
- Stories (requires a valid Instagram session)
- Highlights list (requires a valid Instagram session)
- Hashtag posts (requires a valid Instagram session)
- Post details
- Comments and liker lists where Instagram permits access (login may be required)

The backend does not provide account search, a global trending Reels feed, hashtag autocomplete, or music recognition. The UI does not present these unsupported operations as working features.

## Deploy

### Python service

Deploy `instaloader-service/Dockerfile` to the existing Render service. The health endpoint is `/health`; the authenticated token check is `/v1/health`.

### Cloudflare Worker

Deploy the existing Worker using `wrangler.toml`. Preserve the existing Worker name and Durable Object binding. The Worker health endpoint is `/api/health`; connection and token verification are reported by `/api/status`.

## Limits and privacy

Instaloader is free/open-source software; hosting may not be free or always-on. Instagram can require login, restrict requests, or return incomplete data. A 429 response means stop and wait. This project does not bypass private-account permissions, CAPTCHA, or Instagram rate limits, and has no paid API fallback or automatic proxy rotation.
