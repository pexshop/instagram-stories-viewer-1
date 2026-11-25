# Instaloader service for Instagram Stories Viewer

This is the Python backend adapter for the Cloudflare Worker. It uses the open-source Instaloader project directly; it does not use API credits, paid scraping APIs, or automatic paid fallbacks.

## Important limits

- Instaloader is free/open-source software, not a guaranteed unlimited Instagram data source.
- Instagram can throttle or temporarily block requests. Follow Instaloader's rate controller; do not run parallel scrapers or repeatedly restart the process.
- Anonymous access from cloud/VPN/public-proxy IPs can face stricter limits.
- Public profile posts can often be read without login. Stories, Highlights, hashtag feeds, comments, and liker lists may require a valid Instagram session depending on Instagram's current restrictions.
- A private profile remains inaccessible unless the authenticated account is allowed to view it.
- Account search, global trending Reels, hashtag autocomplete, and direct Highlight-ID lookup are not implemented in this adapter.
- No CAPTCHA bypass, proxy rotation, rate-limit evasion, or private-account bypass is included.

## Run locally

Python 3.11+ recommended.

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export INSTALOADER_SERVICE_TOKEN='generate-a-long-random-secret'
uvicorn app:app --host 0.0.0.0 --port 7860
```

The service requires a Bearer token. Set the exact same value as the Cloudflare Worker secret `INSTALOADER_SERVICE_TOKEN`.

## Optional Instagram session

For endpoints that require login, mount a valid Instaloader session file and set:

- `INSTALOADER_LOGIN_USER`: Instagram username used for the session.
- `INSTALOADER_SESSION_FILE`: absolute path to the session file.

Create a session on a trusted local computer using Instaloader's documented login flow, then securely transfer the session file to the backend host. Never commit the session file or password to GitHub. Treat the session file like a password. Do not use your primary account if you are uncomfortable with session risk. The bridge does not accept Instagram passwords over HTTP.

Without a session, profile/posts endpoints may work for public accounts; login-required features return an explicit error rather than silently trying another provider.

## Deploy

Use a Python-capable host that can run this Dockerfile, or run it on a computer/Raspberry Pi you control. A free host may sleep, restart, or change availability; a free plan is not a guarantee of always-on service. For a strict no-payment setup, do not add a payment method or enable paid instances.

Configure these variables on the Python host:
- `INSTALOADER_SERVICE_TOKEN` (required random secret)
- `INSTALOADER_LOGIN_USER` (optional)
- `INSTALOADER_SESSION_FILE` (optional)

Configure these Cloudflare Worker variables/secrets:
- `INSTALOADER_SERVICE_URL` (plain text base URL, e.g. your Python service URL; HTTPS required)
- `INSTALOADER_SERVICE_TOKEN` (encrypted secret; same token as Python host)

Remove old `INSCRAPE_API_KEY` and `SOCIALFETCH_API_KEY` secrets after the Instaloader bridge has been deployed and verified.

## Endpoints

- `GET /health`
- `GET /v1/instagram/profile?handle=...`
- `GET /v1/instagram/posts?handle=...`
- `GET /v1/instagram/reels?handle=...`
- `GET /v1/instagram/stories?handle=...`
- `GET /v1/instagram/highlights?handle=...`
- `GET /v1/instagram/hashtag?tag=...`
- `GET /v1/instagram/comments?url=...`
- `GET /v1/instagram/likers?url=...`
- `GET /v1/instagram/post?url=...`

All API endpoints except `/health` require `Authorization: Bearer <token>`.

## License

Instaloader is a third-party open-source project. See https://github.com/instaloader/instaloader for its license and upstream documentation.
