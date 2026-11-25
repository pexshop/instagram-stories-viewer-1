import os
import re
from importlib.metadata import version
import threading
from datetime import datetime, timezone
from typing import Any
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

app = FastAPI(title="Instagram Instaloader Bridge", version="1.0.0")


def require_token(authorization: str | None):
    if not APP_TOKEN:
        raise HTTPException(503, "Service token is not configured.")
    if authorization != f"Bearer {APP_TOKEN}":
        raise HTTPException(401, "Unauthorized")


def loader():
    global _loader, _login_error
    if _loader is None:
        _loader = instaloader.Instaloader(
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            save_metadata=False,
            compress_json=False,
            quiet=True,
            max_connection_attempts=2,
        )
        if LOGIN_USER and SESSION_FILE:
            try:
                _loader.load_session_from_file(LOGIN_USER, filename=SESSION_FILE)
                if not _loader.test_login():
                    raise RuntimeError("Saved Instagram session is no longer valid.")
            except Exception as exc:
                _login_error = str(exc)
    return _loader


def need_login():
    L = loader()
    if not LOGIN_USER or not L.context.is_logged_in:
        detail = "This Instaloader operation requires an authenticated Instagram session."
        if _login_error:
            detail += " Saved session could not be loaded."
        raise HTTPException(401, detail)
    return L


def profile_obj(handle: str):
    if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
        raise HTTPException(400, "Invalid Instagram username.")
    try:
        return instaloader.Profile.from_username(loader().context, handle)
    except instaloader.exceptions.ProfileNotExistsException:
        raise HTTPException(404, "Instagram profile not found.")
    except instaloader.exceptions.LoginRequiredException:
        raise HTTPException(401, "Instagram requires a valid session for this profile.")
    except instaloader.exceptions.TooManyRequestsException:
        raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
    except Exception as exc:
        raise HTTPException(502, f"Instaloader profile lookup failed: {type(exc).__name__}")


def iso(dt):
    if not dt:
        return None
    if getattr(dt, "tzinfo", None) is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()


def media_obj(post):
    try:
        is_video = bool(post.is_video)
        video_url = post.video_url if is_video else None
        image_url = post.url
        carousel = []
        if post.typename == "GraphSidecar":
            for index, node in enumerate(post.get_sidecar_nodes()):
                node_video = bool(node.is_video)
                carousel.append({
                    "id": f"{post.shortcode}-{index}",
                    "mediaType": "video" if node_video else "image",
                    "videoUrl": node.video_url if node_video else None,
                    "imageUrl": node.display_url,
                    "thumbnailUrl": node.display_url,
                })
        owner = getattr(post, "owner_username", None)
        return {
            "id": str(post.mediaid),
            "shortcode": post.shortcode,
            "mediaType": "video" if is_video else ("carousel" if carousel else "image"),
            "videoUrl": video_url,
            "imageUrl": image_url,
            "thumbnailUrl": image_url,
            "caption": post.caption or "",
            "createdAt": iso(post.date_utc),
            "url": f"https://www.instagram.com/p/{post.shortcode}/",
            "likeCount": getattr(post, "likes", None),
            "commentCount": getattr(post, "comments", None),
            "owner": {"handle": owner} if owner else None,
            "carouselMedia": carousel,
        }
    except Exception as exc:
        raise HTTPException(502, f"Could not serialize Instagram media: {type(exc).__name__}")


def profile_data(p):
    return {
        "handle": p.username,
        "username": p.username,
        "full_name": p.full_name,
        "biography": p.biography,
        "external_url": p.external_url,
        "profile_pic_url": p.profile_pic_url,
        "is_verified": bool(p.is_verified),
        "is_private": bool(p.is_private),
        "media_count": p.mediacount,
        "follower_count": p.followers,
        "following_count": p.followees,
        "userid": p.userid,
    }


def post_from_url(url: str):
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in ("instagram.com", "www.instagram.com"):
            raise HTTPException(400, "Only HTTPS Instagram post URLs are accepted.")
        match = re.fullmatch(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)/?", parsed.path)
        if not match:
            raise HTTPException(400, "Invalid Instagram post URL.")
        return instaloader.Post.from_shortcode(loader().context, match.group(1))
    except HTTPException:
        raise
    except instaloader.exceptions.TooManyRequestsException:
        raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")
    except Exception as exc:
        raise HTTPException(502, f"Post lookup failed: {type(exc).__name__}")


@app.get("/health")
def health():
    return {"ok": True, "provider": "Instaloader", "version": version("instaloader"), "authenticated": bool(LOGIN_USER and loader().context.is_logged_in)}


@app.get("/v1/instagram/profile")
def profile(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        p = profile_obj(handle)
        posts = []
        try:
            for i, post in enumerate(p.get_posts()):
                if i >= 12:
                    break
                posts.append(media_obj(post))
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached while reading profile posts.")
        x = profile_data(p)
        return {"data": {"profile": x, "posts": posts}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/posts")
def posts(handle: str, authorization: str | None = Header(default=None), limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        p = profile_obj(handle)
        result = []
        for post in p.get_posts():
            result.append(media_obj(post))
            if len(result) >= limit:
                break
        return {"data": {"posts": result, "next_cursor": None, "has_next_page": False}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/reels")
def reels(handle: str, authorization: str | None = Header(default=None), limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        p = profile_obj(handle)
        result = []
        for post in p.get_posts():
            if post.is_video:
                result.append(media_obj(post))
            if len(result) >= limit:
                break
        return {"data": {"reels": result, "next_cursor": None, "has_next_page": False}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/stories")
def stories(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        L = need_login()
        p = profile_obj(handle)
        try:
            items = []
            for story in L.get_stories(userids=[p.userid]):
                for item in story.get_items():
                    is_video = bool(item.is_video)
                    items.append({
                        "id": str(item.mediaid),
                        "mediaType": "video" if is_video else "image",
                        "videoUrl": item.video_url if is_video else None,
                        "imageUrl": item.url,
                        "thumbnailUrl": item.url,
                        "createdAt": iso(item.date_utc),
                        "caption": getattr(item, "caption", "") or "",
                        "url": None,
                    })
            return {"data": {"stories": items}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")


@app.get("/v1/instagram/highlights")
def highlights(handle: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        need_login()
        p = profile_obj(handle)
        result = []
        for item in p.get_highlights():
            result.append({
                "id": str(getattr(item, "unique_id", "")),
                "title": getattr(item, "title", "Highlight"),
                "coverUrl": getattr(item, "cover_url", None),
                "itemsCount": getattr(item, "itemcount", None),
            })
        return {"data": {"highlights": result}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/highlight-stories")
def highlight_stories(highlight_id: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    raise HTTPException(501, "Instaloader requires a profile context to enumerate Highlights; this ID-only route is not available in this bridge yet.")


@app.get("/v1/instagram/hashtag")
def hashtag(tag: str, authorization: str | None = Header(default=None), limit: int = Query(default=24, ge=1, le=50)):
    require_token(authorization)
    with _lock:
        L = need_login()
        try:
            target = instaloader.Hashtag.from_name(L.context, tag.lstrip("#"))
            result = []
            for post in target.get_posts():
                result.append(media_obj(post))
                if len(result) >= limit:
                    break
            return {"data": {"posts": result, "next_cursor": None, "has_next_page": False}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}
        except instaloader.exceptions.TooManyRequestsException:
            raise HTTPException(429, "Instagram rate limit reached. Wait before retrying.")


@app.get("/v1/instagram/comments")
def comments(url: str, authorization: str | None = Header(default=None), limit: int = Query(default=30, ge=1, le=100)):
    require_token(authorization)
    with _lock:
        p = post_from_url(url)
        result = []
        try:
            for item in p.get_comments():
                owner = getattr(item, "owner", None)
                result.append({
                    "id": str(getattr(item, "id", "")),
                    "author": {"handle": getattr(owner, "username", "")},
                    "text": getattr(item, "text", ""),
                    "likeCount": getattr(item, "likes_count", 0),
                    "createdAt": iso(getattr(item, "created_at_utc", None)),
                    "replyCount": 0,
                })
                if len(result) >= limit:
                    break
        except instaloader.exceptions.LoginRequiredException:
            raise HTTPException(401, "Instagram requires a valid session to read comments.")
        return {"data": {"comments": result, "next_cursor": None, "has_next_page": False}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/likers")
def likers(url: str, authorization: str | None = Header(default=None), limit: int = Query(default=50, ge=1, le=100)):
    require_token(authorization)
    with _lock:
        need_login()
        p = post_from_url(url)
        result = []
        try:
            for user in p.get_likes():
                result.append({"username": user.username, "full_name": user.full_name, "profile_pic_url": user.profile_pic_url})
                if len(result) >= limit:
                    break
        except instaloader.exceptions.LoginRequiredException:
            raise HTTPException(401, "Instagram requires a valid session to read likers.")
        return {"data": {"accounts": result, "sampled": len(result) >= limit}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/post")
def post(url: str, authorization: str | None = Header(default=None)):
    require_token(authorization)
    with _lock:
        item = media_obj(post_from_url(url))
        return {"data": {"media": item}, "meta": {"provider": "Instaloader", "creditsCharged": 0}}


@app.get("/v1/instagram/search-user")
def search_user(authorization: str | None = Header(default=None)):
    require_token(authorization)
    raise HTTPException(501, "Instaloader does not provide Instagram account search.")


@app.get("/v1/instagram/trending")
def trending(authorization: str | None = Header(default=None)):
    require_token(authorization)
    raise HTTPException(501, "Instaloader does not provide a global trending Reels feed.")


@app.get("/v1/instagram/hashtag-search")
def hashtag_search(authorization: str | None = Header(default=None)):
    require_token(authorization)
    raise HTTPException(501, "Instaloader does not provide hashtag autocomplete.")


@app.exception_handler(HTTPException)
async def http_error_handler(request, exc):
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail, "provider": "Instaloader"})
