import os
import re
import threading
from importlib.metadata import version
from datetime import datetime, timezone
from urllib.parse import urlparse

import instaloader
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

APP_TOKEN = os.environ.get("INSTALOADER_SERVICE_TOKEN", "")
LOGIN_USER = os.environ.get("INSTALOADER_LOGIN_USER", "")
SESSION_FILE = os.environ.get("INSTALOADER_SESSION_FILE", "")
_lock = threading.RLock()
_loader = None
_login_error = None

app = FastAPI(title="Instagram Instaloader Bridge", version="2.0.0")


def require_token(authorization: str | None):
    if not APP_TOKEN:
        raise HTTPException(503, "Service token is not configured.")
    if authorization != f"Bearer {APP_TOKEN}":
        raise HTTPException(401, "Unauthorized")


def loader():
    global _loader, _login_error
    if _loader is None:
        _loader = instaloader.Instaloader(
            download_pictures=False, download_videos=False,
            download_video_thumbnails=False, save_metadata=False,
            compress_json=False, quiet=True, max_connection_attempts=2,
        )
        if LOGIN_USER and SESSION_FILE:
            try:
                _loader.load_session_from_file(LOGIN_USER, filename=SESSION_FILE)
                if not _loader.test_login():
                    raise RuntimeError("Saved Instagram session is invalid.")
            except Exception as exc:
                _login_error = type(exc).__name__
    return _loader


def need_login():
    current = loader()
    if not LOGIN_USER or not current.context.is_logged_in:
        detail = "This operation requires a valid Instagram login session."
        if _login_error:
            detail += " The configured session could not be loaded."
        raise HTTPException(401, detail)
    return current


def profile_obj(handle: str):
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
        raise HTTPException(400, "Invalid Instagram username.")
    try:
        return instaloader.Profile.from_username(loader().context, handle)
    except instaloader.exceptions.ProfileNotExistsException:
        raise HTTPException(404, "Instagram profile not found.")
    except instaloader.exceptions.LoginRequiredException:
        raise HTTPException(401, "Instagram requires a valid session.")
    except instaloader.exceptions.TooManyRequestsException:
        raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Profile lookup failed: {type(exc).__name__}")


def iso(value):
    if not value:
        return None
    if getattr(value, "tzinfo", None) is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def media_obj(post):
    is_video = bool(post.is_video)
    carousel = []
    if getattr(post, "typename", "") == "GraphSidecar":
        for index, node in enumerate(post.get_sidecar_nodes()):
            node_video = bool(node.is_video)
            carousel.append({
                "id": f"{post.shortcode}-{index}",
                "mediaType": "video" if node_video else "image",
                "videoUrl": node.video_url if node_video else None,
                "imageUrl": node.display_url,
                "thumbnailUrl": node.display_url,
            })
    return {
        "id": str(post.mediaid), "shortcode": post.shortcode,
        "mediaType": "video" if is_video else ("carousel" if carousel else "image"),
        "videoUrl": post.video_url if is_video else None,
        "imageUrl": post.url, "thumbnailUrl": post.url,
        "caption": post.caption or "", "createdAt": iso(post.date_utc),
        "url": f"https://www.instagram.com/p/{post.shortcode}/",
        "likeCount": getattr(post, "likes", None),
        "commentCount": getattr(post, "comments", None),
        "carouselMedia": carousel,
        "owner": {"handle": getattr(post, "owner_username", "")},
    }


def profile_data(p):
    return {
        "handle": p.username, "username": p.username, "full_name": p.full_name,
        "biography": p.biography, "external_url": p.external_url,
        "profile_pic_url": p.profile_pic_url,
        "is_verified": bool(p.is_verified), "is_private": bool(p.is_private),
        "media_count": p.mediacount, "follower_count": p.followers,
        "following_count": p.followees, "userid": p.userid,
    }


def post_from_url(value: str):
    parsed = urlparse(value)
    if parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com"):
        raise HTTPException(400, "Only HTTPS Instagram post URLs are accepted.")
    match = re.fullmatch(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)/?", parsed.path)
    if not match:
        raise HTTPException(400, "Invalid Instagram post URL.")
    try:
        return instaloader.Post.from_shortcode(loader().context, match.group(1))
    except instaloader.exceptions.LoginRequiredException:
        raise HTTPException(401, "Instagram requires a valid session for this post.")
    except instaloader.exceptions.TooManyRequestsException:
        raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
    except Exception as exc:
        raise HTTPException(502, f"Post lookup failed: {type(exc).__name__}")


def result(data):
    return {"data": data, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/health")
def health():
    current = loader()
    return {"ok": True, "provider": "Instaloader", "version": version("instaloader"),
            "authenticated": bool(LOGIN_USER and current.context.is_logged_in)}


@app.get("/v1/health")
def private_health(authorization: str | None = Header(default=None)):
    require_token(authorization)
    return {"data": {"ok": True}, "meta": {"provider": "Instaloader"}}


@app.get("/v1/instagram/profile")
def profile(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        p = profile_obj(handle)
        posts = []
        try:
            for post in p.get_posts():
                if len(posts) >= 12:
                    break
                posts.append(media_obj(post))
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached while reading profile posts.")
        return result({"profile": profile_data(p), "posts": posts})


def collect_posts(handle: str, limit: int, videos_only=False):
    p = profile_obj(handle)
    items = []
    for post in p.get_posts():
        if videos_only and not post.is_video:
            continue
        items.append(media_obj(post))
        if len(items) >= limit:
            break
    return items


@app.get("/v1/instagram/posts")
def posts(handle: str, authorization: str | None = Header(default=None),
          limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        return result({"posts": collect_posts(handle, limit)})


@app.get("/v1/instagram/reels")
def reels(handle: str, authorization: str | None = Header(default=None),
          limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        return result({"reels": collect_posts(handle, limit, True)})


@app.get("/v1/instagram/stories")
def stories(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        current = need_login()
        profile = profile_obj(handle)
        items = []
        try:
            for story in current.get_stories(userids=[profile.userid]):
                for item in story.get_items():
                    video = bool(item.is_video)
                    items.append({
                        "id": str(item.mediaid), "mediaType": "video" if video else "image",
                        "videoUrl": item.video_url if video else None,
                        "imageUrl": item.url, "thumbnailUrl": item.url,
                        "createdAt": iso(item.date_utc), "caption": "",
                        "url": None,
                    })
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
        return result({"stories": items})


@app.get("/v1/instagram/highlights")
def highlights(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        current = need_login()
        profile = profile_obj(handle)
        items = []
        try:
            for item in profile.get_highlights():
                items.append({
                    "id": str(getattr(item, "unique_id", "")),
                    "title": getattr(item, "title", "Highlight"),
                    "coverUrl": getattr(item, "cover_url", None),
                    "itemsCount": getattr(item, "itemcount", None),
                })
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
        return result({"highlights": items})


@app.get("/v1/instagram/hashtag")
def hashtag(tag: str, authorization: str | None = Header(default=None),
            limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        current = need_login()
        try:
            target = instaloader.Hashtag.from_name(current.context, tag.lstrip("#"))
            items = []
            for post in target.get_posts():
                items.append(media_obj(post))
                if len(items) >= limit:
                    break
            return result({"posts": items})
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")


@app.get("/v1/instagram/comments")
def comments(url: str, authorization: str | None = Header(default=None),
             limit: int = Query(default=30, ge=1, le=100)):
    require_token(authorization)
    with _lock:
        post = post_from_url(url)
        items = []
        try:
            for item in post.get_comments():
                owner = getattr(item, "owner", None)
                items.append({
                    "id": str(getattr(item, "id", "")),
                    "author": {"handle": getattr(owner, "username", "")},
                    "text": getattr(item, "text", ""),
                    "likeCount": getattr(item, "likes_count", 0),
                    "createdAt": iso(getattr(item, "created_at_utc", None)),
                    "replyCount": 0,
                })
                if len(items) >= limit:
                    break
        except instaloader.exceptions.LoginRequiredException:
            raise HTTPException(401, "Instagram requires a valid session to read comments.")
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
        return result({"comments": items})


@app.get("/v1/instagram/likers")
def likers(url: str, authorization: str | None = Header(default=None),
           limit: int = Query(default=50, ge=1, le=100)):
    require_token(authorization)
    with _lock:
        current = need_login()
        post = post_from_url(url)
        items = []
        try:
            for user in post.get_likes():
                items.append({"username": user.username, "full_name": user.full_name,
                              "profile_pic_url": user.profile_pic_url})
                if len(items) >= limit:
                    break
        except instaloader.exceptions.LoginRequiredException:
            raise HTTPException(401, "Instagram requires a valid session to read likers.")
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
        return result({"accounts": items, "sampled": len(items) >= limit})


@app.get("/v1/instagram/post")
def post(url: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        return result({"media": media_obj(post_from_url(url))})


@app.exception_handler(HTTPException)
async def http_error_handler(request, exc):
    return JSONResponse(status_code=exc.status_code,
                        content={"error": exc.detail, "provider": "Instaloader"})
