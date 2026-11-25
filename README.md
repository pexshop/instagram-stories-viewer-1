# Instagram Stories Viewer

A mobile-friendly Instagram public-content viewer. The Cloudflare Worker serves the frontend and API gateway. Instagram data is fetched by a separate Python service using the open-source **Instaloader** library.

## Architecture

```text
iPhone / browser
      |
      v
Cloudflare Worker (website + API gateway + rate limiting)
      |
      | HTTPS + private Bearer token
      v
Python Instaloader service
      |
      v
Instagram public endpoints
```

Instaloader is free/open-source software and does not charge per API credit. This project has no paid scraping API fallback, no automatic credit purchase, and no paid-provider failover.

## Important distinction: free software vs free hosting

Instaloader itself is free. A Python process must still run somewhere. Cloudflare Workers cannot directly execute the Python Instaloader package. You can run the Python bridge on a computer or Raspberry Pi you control, or deploy it to a Python/Docker host. A free hosting tier may sleep, restart, impose limits, or change its terms; zero-cost always-on hosting is not guaranteed. Do not enable paid instances or add a payment method if strict zero spend is required.

## Deploy the Python service

The backend source is in [instaloader-service](./instaloader-service).

1. Deploy the Dockerfile on a Python/Docker host, or run it on your own computer.
2. Set `INSTALOADER_SERVICE_TOKEN` to a long random secret.
3. Start the service on port 7860.
4. Confirm its `/health` endpoint reports `ok: true`.
5. Keep the service URL on HTTPS when it is reachable from Cloudflare.

Run locally:

```bash
cd instaloader-service
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export INSTALOADER_SERVICE_TOKEN='replace-with-a-long-random-secret'
uvicorn app:app --host 0.0.0.0 --port 7860
```

## Connect the Cloudflare Worker

Open Cloudflare Dashboard → Workers & Pages → instagram-stories-viewer → Settings → Variables and Secrets.

Add:
- Plain-text variable `INSTALOADER_SERVICE_URL`: your Python service HTTPS base URL.
- Encrypted Secret `INSTALOADER_SERVICE_TOKEN`: exactly the same random token used by the Python service.

The Worker checks the Python service's `/health` endpoint through `/api/status`. This check does not make an Instagram request.

Remove old `INSCRAPE_API_KEY` and `SOCIALFETCH_API_KEY` secrets after confirming the Instaloader connection. They are no longer read by this Worker.

## Optional Instagram login session

Public profiles and posts may work without login. Stories, Highlights, hashtag browsing, comments, and liker lists can require an authenticated Instagram session. If you choose to enable those features:

- Create a session file using Instaloader on a trusted device.
- Configure `INSTALOADER_LOGIN_USER` and `INSTALOADER_SESSION_FILE` on the Python service.
- Keep the session file private; it is equivalent to an account credential.
- Do not commit session files or passwords to GitHub.
- The bridge never accepts Instagram passwords over its HTTP API.

Private profiles are only accessible if the logged-in account is authorized to view them. This project does not bypass privacy controls.

## Supported service routes

- Public profile and recent posts
- Public profile posts
- Reels-style video posts from the profile media stream
- Stories (session may be required)
- Highlights list (session may be required)
- Hashtag posts (session may be required)
- Post comments (session may be required)
- Post metadata and media URLs
- Post likers (session may be required)

Not implemented by Instaloader: Instagram account search, global trending Reels, hashtag autocomplete, and ID-only Highlight item lookup. These endpoints return an explicit unsupported response; the Worker does not call another provider.

## Rate limits and reliability

Instaloader includes its own rate controller. Do not run several instances against the same Instagram account/IP, repeatedly restart the service, or try to evade Instagram's rate limits. Cloud/VPN/public proxy IPs may receive stricter anonymous limits. A 429 response means stop and wait; it does not trigger another provider.

The Worker also applies per-client request throttling. No proxy rotation, CAPTCHA bypass, or rate-limit evasion is implemented.

## Documentation

- Instaloader source: https://github.com/instaloader/instaloader
- Official usage: https://instaloader.github.io/basic-usage.html
- Python module: https://instaloader.github.io/as-module.html
- Rate-limit troubleshooting: https://instaloader.github.io/troubleshooting.html
