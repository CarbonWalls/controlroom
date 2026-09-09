#!/usr/bin/env python3
"""
mercury3 — discord auto-response + ambient human simulation
- works fully WITHOUT any LLM api (static replies, ambient "ok", attachments);
  uses the LLM when a provider is reachable (hermes gateway model endpoint first)
- loads config from config.json + providers.json, secrets from .env
- channel summary injected into LLM context (tool: [load_more:messages] to fetch older)
- ~500 messages/day ambient filler, classic "ok" weighted, plus replies and attachments
"""
import os
import re
import sys
import json
import time
import base64
import random
import logging
import threading
import subprocess
import asyncio
import queue
import math
from collections import deque

import requests
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))

# ============================================================
#  BOOTSTRAP: .env -> env, then config files
# ============================================================

def load_dotenv(path, override=False):
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if override or k.strip() not in os.environ:
                    os.environ[k.strip()] = v.strip()
    except FileNotFoundError:
        pass

load_dotenv(os.path.join(HERE, ".env"))

def load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception as e:
        print(f"⚠️ bad {path}: {e}")
        return default

CONFIG = load_json(os.path.join(HERE, "config.json"), {})
PROVIDERS = load_json(os.path.join(HERE, "providers.json"), {"providers": []})

def expand(v):
    if isinstance(v, str):
        m = re.fullmatch(r'\$\{(\w+)\}', v)
        if m:
            return os.environ.get(m.group(1), "")
        return v
    if isinstance(v, list):
        return [expand(x) for x in v]
    if isinstance(v, dict):
        return {k: expand(x) for k, x in v.items()}
    return v

LLM_ENDPOINTS = [expand(p) for p in PROVIDERS.get("providers", [])]

TOKEN = os.environ.get("DISCORD_TOKEN""")
CFG_CHANNEL = str(CONFIG.get("channel_id", ""))
CHANNEL_ID = CFG_CHANNEL  # may become env DISCORD_HOME_CHANNEL if config empty
if not CHANNEL_ID:
    CHANNEL_ID = os.environ.get("DISCORD_HOME_CHANNEL", "")
GUILD_REF = str(CONFIG.get("guild_referer_id", "1058047228637360148"))

REPLY_CFG = CONFIG.get("reply", {})
AMBIENT = CONFIG.get("ambient", {})
ATT_CFG = CONFIG.get("attachments", {})
SUM_CFG = CONFIG.get("summary", {})

# ---- hot reload: i file di config si rileggono da soli, niente restart ----
_CFG_FILES = [os.path.join(HERE, f) for f in ("config.json", "providers.json", ".env")]
_CFG_MT = {f: (os.path.getmtime(f) if os.path.exists(f) else 0) for f in _CFG_FILES}

def _derive_cfg():
    """Ricalcola tutte le variabili derivate dai file di config."""
    g = globals()
    g["LLM_ENDPOINTS"] = [expand(p) for p in g["PROVIDERS"].get("providers", [])]
    g["CFG_CHANNEL"] = str(g["CONFIG"].get("channel_id", ""))
    if g["CFG_CHANNEL"]:
        g["CHANNEL_ID"] = g["CFG_CHANNEL"]
    else:
        g["CHANNEL_ID"] = os.environ.get("DISCORD_HOME_CHANNEL", "")
    g["GUILD_REF"] = str(g["CONFIG"].get("guild_referer_id", "1058047228637360148"))
    for key, sec in (("REPLY_CFG", "reply"), ("AMBIENT", "ambient"),
                     ("ATT_CFG", "attachments"), ("SUM_CFG", "summary")):
        g[key] = g["CONFIG"].get(sec, {})
    g["TOKEN"] = os.environ.get("DISCORD_TOKEN", "") or g.get("TOKEN", "")
    g["DEBOUNCE_S"] = float(g["REPLY_CFG"].get("debounce_seconds", 6))
    g["MAX_BATCH"] = int(g["REPLY_CFG"].get("max_batch", 8))
    g["MAX_WAIT_S"] = float(g["REPLY_CFG"].get("max_wait_seconds", 12))
    g["SUMMARY_REFRESH"] = int(g["SUM_CFG"].get("refresh_seconds", 600))
    g["SUMMARY_RECENT"] = int(g["SUM_CFG"].get("recent_lines", 12))

def maybe_reload():
    """Rilegge config.json / providers.json / .env se cambiati. Chiamato dai loop."""
    changed = []
    for f in _CFG_FILES:
        try:
            mt = os.path.getmtime(f)
        except OSError:
            mt = 0
        if mt != _CFG_MT.get(f, 0):
            _CFG_MT[f] = mt
            changed.append(os.path.basename(f))
    if not changed:
        return False
    load_dotenv(os.path.join(HERE, ".env"), override=True)
    globals()["CONFIG"] = load_json(os.path.join(HERE, "config.json"), {})
    globals()["PROVIDERS"] = load_json(os.path.join(HERE, "providers.json"), {"providers": []})
    _derive_cfg()
    print(f"♻️ hot-reload: {', '.join(changed)}", flush=True)
    return True

def config_watchdog():
    """Rilegge i config ogni 3s anche se i loop sono bloccati in call lunghe."""
    while not stop_event.is_set():
        try:
            maybe_reload()
        except Exception as e:
            print(f"⚠️ watchdog config: {e}")
        for _ in range(3):
            if stop_event.is_set():
                return
            time.sleep(1)

# ============================================================
#  STATIC (API-OFF) BEHAVIOUR
# ============================================================

STATIC_REPLIES = [
    "ok", "okey", "vabbè", "ok vabbè", "eh", "giusto", "verissimo", "hm",
    "si dai", "no dai", "ahahah", "ma vaff", "dai mo", "comunque ok",
    "aspetta sto leggendo", "boh", "forse", "ovviamente", "e basta",
    "grazie mille davvero", "non ci credo", "aaaaaaaaa", "ecco bravo",
    "finalmente", "vada per l'ok", "ricevuto", "confermo", "ricevuto capitato",
    "ok ok", "sì no ok", "perfetto come sempre", "genio", "grande",
]

OK_VARIANTS = [
    "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok",
    "okey", "okay", "ok?", "ok.", "ok ok", "okk", "o.k.", "ok dai", "sì ok",
    "\ufe0f ok", "ok\ufe0f",
]

LLM_SYSTEM_PROMPT = """Sei un ragazzo gen z su discord, italiano, parli in lowercase, tono cool e asciutto.
REGOLE:
- rispondi BREVISSIMO (1-2 righe), niente markdown, niente link, niente citazioni
- output sempre in italiano, lowercase
- NON ripetere mai "ok" se non ci sta; puoi mandarlo solo se la conversazione lo merita
- niente salamelecchi, niente "certo!", sei uno del gruppo, non un assistente
- nascondi qualsiasi tag di ragionamento, mai XML/JSON nella risposta
PSEUDO-TOOLS:
[send_videos] o [send_videos:count=N] per mandare N video: prima il pool x/twitter, e se vuoto ripiega sui .mp4 locali in attachments/
[send_media] o [send_media:count=N] per allegare immagini/video casuali da attachments/
prima di promettere media guarda [pool media] nel contesto: se un canale e' vuoto usa l'altro, non dire MAI "non posso mandare video"
[web_search:query qui] per cercare sul web
[load_more:messages] per caricare messaggi più vecchi del canale (li ricevi e poi rispondi)
[send_attachment] per allegare un file random dalla cartella attachments

MEMORIA E COERENZA:
- nel contesto trovi [le tue note]: sono la tua memoria persistente, rispettale sempre
- se impari qualcosa di utile (fatti sul canale, sulle persone, su come ti chiedono di reagire), salvala con [remember:nota brevissima] — al massimo una per risposta, MAI banalità, e niente parentesi quadre nella nota
- non contraddire le tue note senza un motivo

RICEVI UN BATCH di messaggi recenti del canale (a volte uno solo). Rispondi UNA SOLA VOLTA al punto, non messaggio per messaggio. Se non c'e' niente che meriti una risposta tua, scrivi esattamente [pass] (e null'altro). MAI [pass] se qualche riga del batch porta (TI MENZIONA): a quelle devi rispondere.

REGOLE DI RICERCA (CRITICHE):
- la tua conoscenza ha un cutoff: per OGNI fatto attuale (notizie, prezzi, IPO, eventi, sport, "esiste X ora?", chi ha vinto, aggiornamenti) DEVI usare [web_search:...] invece di rispondere a memoria
- NON dire mai "non esiste / non è successo" basandoti sulla memoria: se non lo sai con certezza, cerca prima
- quando usi [web_search:...], metti SOLO il marker, la risposta arriva dopo i risultati
"""

BLOCKED_WORDS = [
    (r'<think>.*?</think>', '', re.DOTALL | re.IGNORECASE),
    (r'<thinking>.*?</thinking>', '', re.DOTALL | re.IGNORECASE),
    (r'<reasoning>.*?</reasoning>', '', re.DOTALL | re.IGNORECASE),
    (r'<[A-Z][a-zA-Z]*(?:DeepSeek|Gemini|Qwen|OpenAI|Claude)[^>]*>.*?</[^>]+>', '', re.DOTALL | re.IGNORECASE),
    (r'thinking to myself[^)\n]*', '', re.IGNORECASE),
    (r'internal monologue[^)\n]*', '', re.IGNORECASE),
    (r'output in lowercase[^\n]*', '', re.IGNORECASE),
]

# ============================================================
#  STATE
# ============================================================

MY_USER_ID = None
try:
    _b = TOKEN.split('.')[0]
    _b += "=" * ((4 - len(_b) % 4) % 4)
    MY_USER_ID = base64.b64decode(_b).decode('utf-8')
    if not MY_USER_ID.isdigit():
        MY_USER_ID = None
except Exception:
    pass

PROCESSED_MAX = 200
processed_messages = deque(maxlen=PROCESSED_MAX)
processed_lock = threading.Lock()

def is_message_processed(msg_id):
    with processed_lock:
        if msg_id in processed_messages:
            return True
        processed_messages.append(msg_id)
        return False

stop_event = threading.Event()
session = None
seq_lock = threading.Lock()
current_seq = None
api_lock = threading.Lock()
last_api_call = 0.0

CONTEXTS_DIR = os.path.join(HERE, "contexts")
MESSAGES_DIR = os.path.join(HERE, "messages")
ATTACH_DIR = os.path.join(HERE, "attachments")
FILES_DIR = os.path.join(HERE, "files")
VIDEO_POOL_FILE = os.path.join(HERE, "video_pool.json")
OUTBOX = os.path.join(HERE, "outbox")  # drop .txt files here and the bot sends them as messages

MAX_CONTEXT_MESSAGES = 40
CTX_WINDOW = int(CONFIG.get("context_window_tokens", 131072))
COMPRESS_RATIO = float(CONFIG.get("compress_ratio", 0.6))
CHARS_PER_TOKEN = 4
MEMORY_FILE = os.path.join(HERE, "memory.md")
MEDIA_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp",
              ".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}
SUMMARY_REFRESH = int(SUM_CFG.get("refresh_seconds", 600))
SUMMARY_RECENT = int(SUM_CFG.get("recent_lines", 12))

video_urls = deque(maxlen=500)
url_lock = threading.Lock()
link_queue = queue.Queue()
seen_urls = set()
seen_urls_lock = threading.Lock()

message_send_times = deque(maxlen=32)
send_lock = threading.Lock()
MESSAGE_COOLDOWN = 2.0

DISCORD_API = "https://discord.com/api/v9"
MAX_MESSAGE_LENGTH = 800
MAX_TOTAL_NEWLINES = 2

# ============================================================
#  DISCORD PLUMBING
# ============================================================

def _props():
    return {
        "os": "Android", "browser": "Android Chrome", "device": "Android",
        "system_locale": "en-US", "has_client_mods": False,
        "browser_user_agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
        "browser_version": "135.0.0.0", "os_version": "", "referrer": "",
        "referring_domain": "", "referrer_current": "https://discord.com/login",
        "referring_domain_current": "discord.com", "release_channel": "stable",
        "client_build_number": 589596, "client_event_source": None,
        "client_launch_id": "ed39d53e-34eb-44f5-88b4-dd3c8aa5bf50",
        "launch_signature": "5801640a-e4cb-40bb-8f3e-86ba9635d794",
        "client_heartbeat_session_id": "22374ca9-1130-4156-b59d-573cdd063606",
        "client_app_state": "focused",
    }

SUPER_PROPERTIES_B64 = base64.b64encode(json.dumps(_props()).encode()).decode()

def generate_nonce():
    now = int(time.time() * 1000) - 1420070400000
    return str((now << 22) + random.randint(0, 2**22 - 1))

def create_session():
    s = requests.Session()
    s.headers.update({
        "Authorization": TOKEN,
        "Content-Type": "application/json",
        "Accept": "*/*",
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
        "X-Super-Properties": SUPER_PROPERTIES_B64,
        "X-Discord-Locale": "it",
        "X-Discord-Timezone": "Europe/Rome",
        "Referer": f"https://discord.com/channels/{GUILD_REF}/{CHANNEL_ID}",
        "Origin": "https://discord.com",
    })
    return s

def wait_send_slot():
    while True:
        with send_lock:
            now = time.time()
            while message_send_times and now - message_send_times[0] > MESSAGE_COOLDOWN * 6:
                message_send_times.popleft()
            if len(message_send_times) < 2 or not message_send_times or now - message_send_times[-1] >= MESSAGE_COOLDOWN:
                return
            time.sleep(0.5)

def split_for_discord(text, max_len=760, max_nl=1):
    """Split into chunks that satisfy the channel auto-mod: <=max_len chars, <=max_nl newlines."""
    paras = [x.strip() for x in re.split(r'\n+', text) if x.strip()]
    chunks, cur = [], ""
    for para in paras:
        while len(para) > max_len:
            cut = para.rfind('.', 0, max_len)
            if cut < 40:
                cut = para.rfind(' ', 0, max_len)
            if cut < 40:
                cut = max_len - 1
            chunks.append(para[:cut + 1].strip())
            para = para[cut + 1:].strip()
        cand = (cur + "\n" + para) if cur else para
        if len(cand) <= max_len and cur.count("\n") < max_nl:
            cur = cand
        else:
            if cur:
                chunks.append(cur)
            cur = para
    if cur:
        chunks.append(cur)
    return chunks

def send_message(content, reply_to=None):
    content = (content or "").strip()
    if not content:
        return None
    try:
        if reply_to is None:  # ambient/outbox: il canale non risponde a se stesso
            pass
        append_channel("assistant", content)
    except Exception:
        pass
    chunks = split_for_discord(content)
    last_id = None
    for i, chunk in enumerate(chunks):
        last_id = _send_one(chunk, reply_to if i == 0 else None)
        if i < len(chunks) - 1:
            time.sleep(random.uniform(1.5, 3.0))
    return last_id

def _send_one(content, reply_to=None):
    wait_send_slot()
    payload = {"content": content, "nonce": generate_nonce(), "tts": False, "flags": 0}
    if reply_to:
        payload["message_reference"] = {"message_id": reply_to, "channel_id": CHANNEL_ID}
    for attempt in range(3):
        try:
            r = session.post(f"{DISCORD_API}/channels/{CHANNEL_ID}/messages", json=payload, timeout=15)
            if r.status_code in (200, 201):
                with send_lock:
                    message_send_times.append(time.time())
                mid = r.json().get("id")
                print(f"  ✅ {content[:60]!r}")
                return mid
            if r.status_code == 429:
                ra = r.json().get("retry_after", 3)
                time.sleep(ra + 0.3)
                continue
            # il msg a che replyavamo e' stato cancellato (o automod): riprova nudo
            if reply_to and r.status_code in (400, 404) and ("referenced" in r.text.lower() or "10008" in r.text):
                print("  ↻ reply-ref cancellato, rimando senza reference")
                payload.pop("message_reference", None)
                try:
                    r2 = session.post(f"{DISCORD_API}/channels/{CHANNEL_ID}/messages", json=payload, timeout=15)
                    if r2.status_code in (200, 201):
                        with send_lock:
                            message_send_times.append(time.time())
                        print(f"  ✅ {content[:60]!r}")
                        return r2.json().get("id")
                except Exception:
                    pass
                return None
            print(f"  ❌ HTTP {r.status_code}: {r.text[:120]}")
            return None
        except Exception as e:
            print(f"  ❌ send err: {e}")
            time.sleep(2)
    return None

def fetch_messages(before=None, limit=50):
    """GET recent (or older with `before`) messages."""
    params = {"limit": min(limit, 100)}
    if before:
        params["before"] = before
    try:
        r = session.get(f"{DISCORD_API}/channels/{CHANNEL_ID}/messages", params=params, timeout=20)
        if r.status_code == 429:
            time.sleep(r.json().get("retry_after", 3))
            r = session.get(f"{DISCORD_API}/channels/{CHANNEL_ID}/messages", params=params, timeout=20)
        if r.status_code == 200:
            return r.json()
        print(f"  ⚠️ fetch HTTP {r.status_code}")
    except Exception as e:
        print(f"  ⚠️ fetch err: {e}")
    return []

def send_file(path, caption=""):
    if not os.path.exists(path):
        return None
    wait_send_slot()
    payload = {"content": caption[:MAX_MESSAGE_LENGTH] if caption else "", "nonce": generate_nonce(), "tts": False, "flags": 0}
    try:
        with open(path, "rb") as f:
            data = f.read()
        # NOTE: plain requests (no session) — the session's Content-Type: application/json
        # header would clobber the multipart boundary and Discord returns 50109.
        r = requests.post(
            f"{DISCORD_API}/channels/{CHANNEL_ID}/messages",
            headers={"Authorization": TOKEN,
                     "User-Agent": session.headers.get("User-Agent", ""),
                     "X-Super-Properties": SUPER_PROPERTIES_B64,
                     "X-Discord-Locale": "it",
                     "X-Discord-Timezone": "Europe/Rome"},
            files={"file": (os.path.basename(path), data, "application/octet-stream")},
            data={"payload_json": json.dumps(payload)},
            timeout=60,
        )
        if r.status_code in (200, 201):
            with send_lock:
                message_send_times.append(time.time())
            print(f"  📎 sent {os.path.basename(path)} ({len(data)//1024} KB)")
            return r.json().get("id")
        print(f"  ❌ file HTTP {r.status_code}: {r.text[:100]}")
    except Exception as e:
        print(f"  ❌ file err: {e}")
    return None

# ============================================================
#  LLM (optional — every failure degrades gracefully)
# ============================================================

def llm_available():
    return any(e.get("url") and e.get("api_key") and e.get("models") for e in LLM_ENDPOINTS)

def call_llm(messages, context="chat"):
    """Try endpoints in order; returns (content, ok). ok=False => no provider reachable => static path."""
    global last_api_call
    with api_lock:
        wait = last_api_call + 2.0 - time.time()
        if wait > 0:
            time.sleep(wait)
        last_api_call = time.time()

    for ep in LLM_ENDPOINTS:
        url = ep.get("url", "")
        key = ep.get("api_key", "")
        models = ep.get("models", [])
        if not url or not key or not models:
            continue
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        for model in models:
            payload = {"model": model, "messages": messages, "stream": False, **ep.get("extra_params", {})}
            try:
                r = requests.post(url, headers=headers, json=payload, timeout=90)
                if r.status_code == 200:
                    msg = r.json()["choices"][0]["message"]
                    content = (msg.get("content") or "").strip()
                    if content:
                        return content, True
                elif r.status_code == 429:
                    time.sleep(r.json().get("retry_after", 4))
                    continue
                elif r.status_code in (401, 403):
                    print(f"  🔒 {ep['name']}/{model}: auth failed, skipping endpoint")
                    break
                else:
                    continue
            except Exception as e:
                print(f"  ⚠️ {ep['name']}/{model}: {str(e)[:80]}")
                continue
    return "", False

def clean_response(text):
    if not text:
        return ""
    for entry in BLOCKED_WORDS:
        if len(entry) == 3:
            text = re.sub(entry[0], entry[1], text, flags=entry[2])
        else:
            text = re.sub(entry[0], entry[1], text)
    text = re.sub(r'https?://\S+', '', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'\1', text)
    text = re.sub(r'`([^`]+)`', r'\1', text)
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()

# ============================================================
#  CONTEXT + SUMMARY
# ============================================================

_summary_cache = {"text": "", "ts": 0.0}
_summary_lock = threading.Lock()

def channel_digest(limit=50):
    """Formatted latest-channel messages; also persisted to messages/ for [load_more:messages]."""
    msgs = fetch_messages(limit=limit)
    if not msgs:
        return "", None
    lines = []
    for m in reversed(msgs):
        author = m.get("author", {}).get("username", "?")
        content = (m.get("content") or "").replace("\n", " ").strip()
        atts = m.get("attachments") or []
        if not content and atts:
            content = f"[{atts[0].get('filename','file')}]"
        if not content:
            continue
        lines.append(f"{author}: {content[:200]}")
    digest = "\n".join(lines[-SUMMARY_RECENT:])
    # persist newest id for pagination
    oldest_id = msgs[-1].get("id") if msgs else None
    return digest, msgs[0].get("id") if msgs else None, oldest_id

def build_summary():
    res = channel_digest(50)
    digest = res[0] if res else ""
    text = ""
    if digest:
        if llm_available():
            s, ok = call_llm(
                [{"role": "system", "content": "Riassumi in 2-3 frasi (lowercase, italiano) di cosa si parla in questo canale discord. Solo il riassunto."},
                 {"role": "user", "content": digest}],
                context="summary")
            text = clean_response(s) if ok else digest
        else:
            text = digest
    with _summary_lock:
        _summary_cache["text"] = text
        _summary_cache["ts"] = time.time()
    return text

def get_summary():
    with _summary_lock:
        if time.time() - _summary_cache["ts"] < SUMMARY_REFRESH and _summary_cache["text"]:
            return _summary_cache["text"]
    return build_summary() or ""

def load_context(user_id):
    os.makedirs(CONTEXTS_DIR, exist_ok=True)
    p = os.path.join(CONTEXTS_DIR, f"{user_id}.json")
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []

def save_context(user_id, hist):
    os.makedirs(CONTEXTS_DIR, exist_ok=True)
    p = os.path.join(CONTEXTS_DIR, f"{user_id}.json")
    try:
        with open(p, "w", encoding="utf-8") as f:
            json.dump(hist[-MAX_CONTEXT_MESSAGES:], f, ensure_ascii=False)
    except Exception:
        pass

# ============================================================
#  VIDEO POOL + PSEUDO TOOLS
# ============================================================

def load_video_pool():
    if os.path.exists(VIDEO_POOL_FILE):
        try:
            with open(VIDEO_POOL_FILE) as f:
                d = json.load(f)
            with url_lock:
                for u in d.values():
                    if u not in video_urls:
                        video_urls.append(u)
            print(f"✅ video pool: {len(video_urls)}")
        except Exception:
            pass

def get_video_urls(count):
    out = []
    with url_lock:
        avail = list(video_urls)
        random.shuffle(avail)
        out = avail[:count]
    return out

def static_pseudo_tools(content):
    """Handle tool markers even without LLM? No: markers only come from LLM. Static path just forwards."""
    return content

def media_pools():
    """(x_pool_n, video_locali[], immagini_locali[]) per il modello e i tool."""
    files = attachments_random_files()
    vids = [f for f in files if os.path.splitext(f)[1].lower() in {".mp4", ".mov", ".webm", ".m4v"}]
    imgs = [f for f in files if os.path.splitext(f)[1].lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}]
    with url_lock:
        n_x = len(video_urls)
    return n_x, vids, imgs

def send_random_videos(count, reply_to=None):
    """pool x prima, mp4 locali come fallback. ritorna quanti ne ha mandati."""
    sent = 0
    n_x, lvids, _ = media_pools()
    if n_x:
        vids = get_video_urls(count)
        if vids:
            send_message(" ".join(f"[\ufe0f]({u})" for u in vids[:5]), reply_to=reply_to)
            sent += len(vids)
    need = count - sent
    if need > 0 and lvids:
        for fp in random.sample(lvids, min(need, len(lvids))):
            send_file(fp)
            sent += 1
            time.sleep(random.uniform(1.5, 3.0))
    return sent

def attachments_random_files():
    try:
        files = [os.path.join(ATTACH_DIR, f) for f in os.listdir(ATTACH_DIR)]
        files = [f for f in files if os.path.isfile(f)]
        return files
    except FileNotFoundError:
        return []

# ============================================================
#  MEMORY PERSISTENTE (stile note dell'agente)
# ============================================================

def load_memory():
    try:
        with open(MEMORY_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""

def add_memory(fact):
    fact = re.sub(r'\s+', ' ', fact).strip()[:200]
    if not fact:
        return
    lines = [l for l in load_memory().splitlines() if l.strip()]
    low = fact.lower()
    if any(low in l.lower() or l.lower().lstrip('- ') in low for l in lines):
        return
    lines.append(f"- {fact}")
    while sum(len(l) for l in lines) > 1600 and len(lines) > 1:
        lines.pop(0)
    try:
        with open(MEMORY_FILE, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        print(f"  🧠 remembered: {fact[:60]}")
    except Exception:
        pass

# ============================================================
#  DOPPIA FINESTRA DI CONTESTO + COMPRESSIONE
# ============================================================

CH_WINDOW_FILE = os.path.join(CONTEXTS_DIR, "channel.json")
ch_lock = threading.Lock()

def est_tokens(msgs):
    return sum(len(str(m.get("content", ""))) for m in msgs) // CHARS_PER_TOKEN

def rolling_compress(tag, hist, keep=16, budget=None):
    """Comprime la storia quando si avvicina alla soglia della window."""
    budget = budget or int(CTX_WINDOW * COMPRESS_RATIO)
    if not hist or est_tokens(hist) <= budget:
        return hist
    has_sum = bool(hist[0].get("is_summary"))
    body = hist[1:] if has_sum else hist
    prev = hist[0].get("content", "") if has_sum else ""
    keep = min(keep, len(body))
    cut = len(body) - keep
    if cut <= 0:
        return hist
    old, recent = body[:cut], body[cut:]
    blob = (("RESTI DEL RIASSUNTO PRECEDENTE: " + prev[-700:] + "\n") if prev else "") + "\n".join(
        f"{m.get('role')}: {str(m.get('content'))[:180]}" for m in old)
    news = ""
    if llm_available():
        s_out, ok = call_llm([
            {"role": "system", "content": "Comprimi questa conversazione discord in 4-6 frasi (italiano, lowercase): fatti detti, umore del canale, nomi, cose in sospeso. Solo il riassunto."},
            {"role": "user", "content": "Riassumi per memoria a lungo termine:\n" + blob[:24000]}],
            context=f"compress-{tag}")
        if ok and s_out:
            news = clean_response(s_out)
    entry = {"role": "system", "is_summary": True,
             "content": f"[storia {tag}: {news or prev or blob[-1500:]}]"}
    return [entry] + recent

def _read_ch():
    try:
        with open(CH_WINDOW_FILE, encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, list) else []
    except Exception:
        return []

def append_channel(role, text):
    text = (text or "").strip()
    if not text:
        return
    text = re.sub(r'\[[^\]]{0,3}\]\(https?://[^)]+\)', '[media]', text)
    text = re.sub(r'https?://\S+', '[link]', text)
    text = re.sub(r'\s+', ' ', text)[:280]
    with ch_lock:
        hist = _read_ch()
        hist.append({"role": role, "content": text})
        if len(hist) > 400:
            hist = hist[-400:]
        try:
            with open(CH_WINDOW_FILE, "w", encoding="utf-8") as f:
                json.dump(hist, f, ensure_ascii=False)
        except Exception:
            pass

def get_channel_window(n=80):
    with ch_lock:
        hist = _read_ch()
    return hist[-n:]

def render_channel_window():
    lines = []
    for m in get_channel_window():
        c = str(m.get("content", ""))
        lines.append(c if m.get("is_summary") else f"{m.get('role')}: {c[:200]}")
    return "\n".join(lines)

def channel_compressor():
    """Thread: comprime la finestra del canale quando piena oltre la soglia."""
    while not stop_event.is_set():
        for _ in range(300):
            if stop_event.is_set():
                return
            time.sleep(1)
        try:
            with ch_lock:
                hist = _read_ch()
            budget = int(CTX_WINDOW * COMPRESS_RATIO * 0.3)
            if hist and (est_tokens(hist) > budget or len(hist) > 160):
                comp = rolling_compress("canale", hist, keep=60, budget=budget)
                if comp != hist:
                    with ch_lock:
                        cur = _read_ch()
                        # riaggiunge cio' che e' arrivato durante la compressione
                        tail_ids = {(m.get("role"), m.get("content")) for m in comp}
                        extra = [m for m in cur[-40:] if (m.get("role"), m.get("content")) not in tail_ids]
                        json.dump(comp + extra, open(CH_WINDOW_FILE, "w", encoding="utf-8"), ensure_ascii=False)
                    print(f"  🗜️ canale compresso: {len(hist)} -> {len(comp)+len(extra)} msg, ~{est_tokens(comp)} tok")
        except Exception as e:
            print(f"  ⚠️ compressor: {e}")

# ============================================================
#  REPLY PIPELINE
# ============================================================

_TOOL_MARKER = re.compile(r'\[(web_search|load_more|send_videos|send_attachment|send_media|remember)[^\]]*\]', re.I)

def process_reply_batch(items):
    """items: [{user_id, uname, content, msg_id}] accumulati nel debounce window.
    UNA chiamata LLM per tutto il batch, UNA risposta (o PASS)."""
    last = items[-1]
    batch_text = "\n".join(
        f"{it['uname']}{it.get('ping') and ' (TI MENZIONA)' or ''}: {it['content'] or '[media]'}" for it in items)
    for it in items:
        h = load_context(it["user_id"])
        h.append({"role": "user", "content": it["content"] or "[attachment]"})
        save_context(it["user_id"], h)
    user_id = last["user_id"]
    msg_id = last["msg_id"]
    hist = load_context(user_id)
    # il thread principale vede il batch; il messaggio del suo autore e' gia'
    # stato salvato nel suo contesto sopra, quindi saltiamo il dup
    if hist and hist[-1].get("role") == "user" and hist[-1].get("content") == (items[-1]["content"] or "[attachment]"):
        hist = hist[:-1]
    hist.append({"role": "user", "content": batch_text if len(items) > 1 else (items[0]["content"] or "[attachment]")})
    content = batch_text

    reply_text = None
    if llm_available():
        summary = get_summary()
        mem = load_memory()
        msgs = [{"role": "system", "content": LLM_SYSTEM_PROMPT},
                {"role": "system", "content": "oggi è il " + time.strftime("%d/%m/%Y") + ", la tua conoscenza potrebbe essere vecchia: cerca."}]
        if mem:
            msgs.append({"role": "system", "content": "[le tue note]:\n" + mem})
        n_x, lv, li = media_pools()
        msgs.append({"role": "system", "content": "[pool media: " + str(n_x) + " video x | " + str(len(lv)) + " video locali | " + str(len(li)) + " immagini locali]"})
        msgs.append({"role": "system", "content": "[ultime del canale] (cronologia recente, tua + altri):\n" + (render_channel_window() or summary or "(vuoto)")})
        hist = rolling_compress(user_id[:8], hist)
        msgs += hist[-MAX_CONTEXT_MESSAGES:]

        out, ok = call_llm(msgs, context="reply")
        if ok and out:
            # tool loop: keep feeding results back until the model produces final prose
            notes = []
            for _round in range(3):
                tool_used = False
                m = re.search(r'\[web_search:([^\]]+)\]', out)
                if m:
                    out = re.sub(r'\[web_search:[^\]]+\]', '', out, flags=re.I).strip()
                    res = _web_search(m.group(1))
                    notes.append({"role": "system", "content": f"risultati web su '{m.group(1)}':\n{res}\nUsali per rispondere ORA, senza ritentare la ricerca."})
                    tool_used = True
                m2 = re.search(r'\[load_more:messages\]', out, re.I)
                if m2:
                    out = re.sub(r'\[load_more[^\]]*\]', '', out, flags=re.I).strip()
                    notes.append({"role": "system", "content": "Messaggi più vecchi del canale (altri 50):\n" + _fetch_older_digest()})
                    tool_used = True
                m3 = re.search(r'\[send_videos(?::count=(\d+))?\]', out, re.I)
                if m3:
                    out = re.sub(r'\[send_videos[^\]]*\]', '', out, flags=re.I).strip()
                    got = send_random_videos(int(m3.group(1) or 1), reply_to=msg_id)
                    if got == 0:
                        notes.append({"role": "system", "content": "tool video: pool x vuoto E nessun mp4 locale"})
                        tool_used = True
                mm = re.search(r'\[remember:([^\]]+)\]', out, re.I)
                if mm:
                    out = re.sub(r'\[remember:[^\]]+\]', '', out, flags=re.I).strip()
                    add_memory(mm.group(1))
                m5 = re.search(r'\[send_media(?::count=\d+)?\]', out, re.I)
                if m5:
                    out = re.sub(r'\[send_media(?::\d+)?\]', '', out, flags=re.I).strip()
                    _, lvids2, limags = media_pools()
                    media = lvids2 + limags
                    if media:
                        for fp in random.sample(media, min(int(m5.group(1) or 1), len(media))):
                            send_file(fp)
                            time.sleep(random.uniform(1.5, 3.0))
                    else:
                        notes.append({"role": "system", "content": "attachments/ vuota, nessun media"})
                        tool_used = True
                m4 = re.search(r'\[send_attachment\]', out, re.I)
                if m4:
                    out = re.sub(r'\[send_attachment\]', '', out, flags=re.I).strip()
                    files = attachments_random_files()
                    media = [f for f in files if os.path.splitext(f)[1].lower() in MEDIA_EXTS]
                    if media:
                        send_file(random.choice(media))
                    elif files:
                        send_file(random.choice(files))
                if not tool_used:
                    break
                out2, ok2 = call_llm(msgs + notes + ([{"role": "assistant", "content": out}] if out else []), context=f"tool{_round}")
                if ok2 and out2:
                    out = out2
                else:
                    break
            reply_text = clean_response(out)
            # hard guarantee: markers never reach discord
            reply_text = _TOOL_MARKER.sub('', reply_text).strip()

    if reply_text is None or reply_text == "":
        # empty (e.g. tool-only turn that yielded nothing final) → fallback static
        reply_text = random.choice(STATIC_REPLIES)

    if reply_text and reply_text.lower().strip(" .") != "[pass]" and reply_text.lower().strip(" .") != "pass":
        send_message(reply_text, reply_to=msg_id)
        hist.append({"role": "assistant", "content": reply_text})
    save_context(user_id, hist)  # hist qui e' gia' compresso

def _fetch_older_digest():
    """Pagination tool: load 50 messages older than the last fetched batch."""
    os.makedirs(MESSAGES_DIR, exist_ok=True)
    state_p = os.path.join(MESSAGES_DIR, "cursor.json")
    cursor = None
    try:
        cursor = json.load(open(state_p)).get("oldest")
    except Exception:
        pass
    if not cursor:
        msgs = fetch_messages(limit=1)
        cursor = msgs[0]["id"] if msgs else None
    if not cursor:
        return "(nessun messaggio)"
    msgs = fetch_messages(before=cursor, limit=50)
    lines = []
    for m in reversed(msgs):
        c = (m.get("content") or "").replace("\n", " ").strip()
        if c:
            lines.append(f"{m.get('author',{}).get('username','?')}: {c[:160]}")
    if msgs:
        try:
            json.dump({"oldest": msgs[-1]["id"]}, open(state_p, "w"))
        except Exception:
            pass
    return "\n".join(lines) or "(fine della cronologia)"

def _web_search(query):
    """DDG html backend (no key) with searx.be fallback; returns title+snippet lines."""
    import html as _html
    # 1) html.duckduckgo.com
    try:
        r = requests.post("https://html.duckduckgo.com/html/",
                          data={"q": query}, timeout=15,
                          headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
        if r.status_code == 200:
            titles = re.findall(r'class="result__a"[^>]*>(.*?)</a>', r.text, re.S)
            snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S)
            out = []
            for i, t in enumerate(titles[:5]):
                t = _html.unescape(re.sub(r'<[^>]+>', '', t)).strip()
                sn = _html.unescape(re.sub(r'<[^>]+>', '', snips[i])).strip() if i < len(snips) else ""
                out.append(f"- {t}: {sn[:240]}")
            if out:
                return "\n".join(out)
    except Exception:
        pass
    # 2) searx fallbacks
    for inst in ("https://searx.be", "https://searx.tiekoetter.com"):
        try:
            r = requests.get(inst + "/search", params={"q": query, "format": "json"}, timeout=10)
            if r.status_code == 200:
                out = [f"- {x.get('title','')}: {x.get('content','')[:240]}" for x in r.json().get("results", [])[:5]]
                if out:
                    return "\n".join(out)
        except Exception:
            continue
    return "(ricerca non disponibile, non inventare il fatto)"

# ============================================================
#  AMBIENT THREAD (~500 msgs/day)
# ============================================================

def ambient_loop():
    rng = random.Random()
    # log-normal-ish gaps around the mean so it looks human
    while not stop_event.is_set():
        maybe_reload()  # target/ok_weight/min_gap si aggiornano da config.json
        base_gap = 86400.0 / max(int(AMBIENT.get("target_messages_per_day", 500)), 1)
        ok_w = float(AMBIENT.get("ok_weight", 0.55))
        min_gap = float(AMBIENT.get("min_gap_seconds", 40))
        gap = max(rng.lognormvariate(math.log(base_gap) - 0.125, 0.5), min_gap)
        # sleep in chunks so we can stop
        end = time.time() + gap
        while time.time() < end and not stop_event.is_set():
            time.sleep(min(5, end - time.time()))
        if stop_event.is_set():
            break
        if rng.random() < ok_w:
            msg = rng.choice(OK_VARIANTS)
        else:
            if llm_available() and rng.random() < 0.25:
                s, ok = call_llm(
                    [{"role": "system", "content": "Sei un utente discord gen z italiano. Scrivi UN brevissimo messaggio casuale e plausibile da mandare nel proprio canale (una parola o 4-5 al massimo, lowercase). Puoi ALMAX usare un solo tool marker: [send_media] per allegare un media random, [remember:nota] se noti qualcosa di memorabile. Output solo messaggio (e marker se serve)."},
                     {"role": "system", "content": "[le tue note]:\n" + (load_memory() or "(nessuna)")},
                     {"role": "user", "content": f"ultime del canale:\n{(render_channel_window() or get_summary())[:900]}"}],
                    context="ambient")
                if ok and s:
                    mm = re.search(r'\[remember:([^\]]+)\]', s)
                    if mm:
                        add_memory(mm.group(1))
                    if "[send_media]" in s.lower():
                        media = [f for f in attachments_random_files() if os.path.splitext(f)[1].lower() in MEDIA_EXTS]
                        if media:
                            send_file(rng.choice(media))
                    s = _TOOL_MARKER.sub('', s).strip()
                    msg = clean_response(s) or rng.choice(STATIC_REPLIES)
                else:
                    msg = rng.choice(STATIC_REPLIES)
            else:
                msg = rng.choice(STATIC_REPLIES)
        if rng.random() < 0.05:
            media = [f for f in attachments_random_files() if os.path.splitext(f)[1].lower() in MEDIA_EXTS]
            if media:
                send_file(rng.choice(media))
                continue
        if msg:
            send_message(msg)

# ============================================================
#  RANDOM ATTACHMENTS THREAD
# ============================================================

def attachment_loop():
    rng = random.Random()
    while not stop_event.is_set():
        maybe_reload()  # mean_gap/max_files si aggiornano da config.json
        mean_gap = float(ATT_CFG.get("mean_gap_seconds", 1200))
        max_files = int(ATT_CFG.get("max_per_attachment", 2))
        gap = max(rng.lognormvariate(math.log(mean_gap), 0.8), 60)
        end = time.time() + gap
        while time.time() < end and not stop_event.is_set():
            time.sleep(min(5, end - time.time()))
        if stop_event.is_set():
            break
        files = attachments_random_files()
        media = [f for f in files if os.path.splitext(f)[1].lower() in MEDIA_EXTS]
        pool = media or files
        if not pool:
            continue
        for _ in range(rng.randint(1, max_files)):
            send_file(rng.choice(pool))
            time.sleep(rng.uniform(2, 6))

# ============================================================
#  OUTBOX (static-mode message source: drop .txt files)
# ============================================================

def outbox_loop():
    os.makedirs(OUTBOX, exist_ok=True)
    while not stop_event.is_set():
        try:
            for name in sorted(os.listdir(OUTBOX)):
                p = os.path.join(OUTBOX, name)
                if not os.path.isfile(p):
                    continue
                try:
                    text = open(p, encoding="utf-8").read().strip()
                    if text:
                        send_message(text)
                    os.remove(p)
                except Exception as e:
                    print(f"⚠️ outbox {name}: {e}")
        except FileNotFoundError:
            pass
        for _ in range(10):
            if stop_event.is_set():
                break
            time.sleep(1)

# ============================================================
#  GATEWAY (WS) + WORKERS
# ============================================================

llm_queue = queue.Queue()

DEBOUNCE_S = float(REPLY_CFG.get("debounce_seconds", 6))
MAX_BATCH = int(REPLY_CFG.get("max_batch", 8))
MAX_WAIT_S = float(REPLY_CFG.get("max_wait_seconds", 12))

def llm_worker():
    """Debounce normale; un messaggio che ti menziona azzera l'attesa."""
    while not stop_event.is_set():
        maybe_reload()
        batch = []
        deadline = None
        try:
            while True:
                uid, content, mid, atts, uname, ping = llm_queue.get(timeout=1)
                batch.append({"user_id": uid, "content": content, "msg_id": mid, "uname": uname, "ping": ping})
                if ping:
                    deadline = time.time()  # flush immediato
                    break
                if deadline is None:
                    deadline = time.time() + DEBOUNCE_S
                if len(batch) >= MAX_BATCH:
                    break
                remaining = deadline - time.time()
                if remaining <= 0:
                    break
        except queue.Empty:
            pass
        if not batch:
            continue
        if not any(b["ping"] for b in batch):
            # si puo' aggiungere altro mentre la deadline scade
            t0 = time.time()
            while time.time() - t0 < MAX_WAIT_S and len(batch) < MAX_BATCH:
                try:
                    while True:
                        uid, content, mid, atts, uname, ping = llm_queue.get_nowait()
                        batch.append({"user_id": uid, "content": content, "msg_id": mid, "uname": uname, "ping": ping})
                        if ping:
                            deadline = time.time()  # il ping interrompe il gathering
                        if len(batch) >= MAX_BATCH or (deadline and time.time() >= deadline):
                            break
                except queue.Empty:
                    if deadline and time.time() >= deadline:
                        break
                    time.sleep(0.3)
        tag = "📣 PING" if any(b["ping"] for b in batch) else "🧵"
        try:
            print(f"{tag} batch di {len(batch)} msg → una reply")
            process_reply_batch(batch)
        except Exception as e:
            print(f"❌ worker: {e}")

async def heartbeat_loop(ws, interval):
    while True:
        await asyncio.sleep(interval)
        with seq_lock:
            seq = current_seq
        try:
            await ws.send(json.dumps({"op": 1, "d": seq}))
        except Exception:
            break

async def gateway_loop():
    global current_seq
    delay = 5
    while not stop_event.is_set():
        try:
            async with websockets.connect("wss://gateway.discord.gg/?v=9&encoding=json", max_size=2**25) as ws:
                print("✅ gateway connesso")
                delay = 5
                hello = json.loads(await ws.recv())
                hb = hello['d']['heartbeat_interval'] / 1000.0
                ident = {"op": 2, "d": {
                    "token": TOKEN,
                    "properties": _props(),
                    "presence": {"status": "online", "since": 0, "activities": [], "afk": False},
                    "compress": False, "large_threshold": 250, "guild_subscriptions": False,
                }}
                await ws.send(json.dumps(ident))
                hb_task = asyncio.create_task(heartbeat_loop(ws, hb))
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                    except Exception:
                        continue
                    op = data.get("op")
                    if op == 0 and "s" in data:
                        with seq_lock:
                            current_seq = data["s"]
                    if op == 7:
                        break
                    if op == 9:
                        if data.get("d") is True:
                            break
                        await ws.send(json.dumps(ident))
                        continue
                    if op == 0 and data.get("t") == "MESSAGE_CREATE":
                        d = data.get("d", {})
                        if d.get("channel_id") != CHANNEL_ID:
                            continue
                        if d.get("author", {}).get("id") == MY_USER_ID:
                            continue
                        mid = d.get("id")
                        content = (d.get("content") or "").strip()
                        atts = d.get("attachments", [])
                        if not mid or is_message_processed(mid):
                            continue
                        if not content and not atts:
                            continue
                        uid = d.get("author", {}).get("id", "anon")
                        uname = d.get("author", {}).get("username", "?")
                        is_ping = bool(MY_USER_ID) and any(
                            (mm.get("id") == MY_USER_ID) for mm in (d.get("mentions") or []))
                        if not content and atts:
                            content = f"[ha mandato {atts[0].get('filename','file')}]"
                        if content:
                            append_channel(uname, content)
                        print(f"📩 {uname}: {content[:60]}")
                        llm_queue.put((uid, content, mid, atts, uname, is_ping))
                hb_task.cancel()
        except Exception as e:
            print(f"⚠️ gateway: {e}")
        await asyncio.sleep(delay)
        delay = min(delay * 2, 60)

def start_gateway():
    asyncio.run(gateway_loop())

# ============================================================
#  MAIN
# ============================================================

_lock_fh = None
def acquire_lock():
    """Single-instance guard: refuse to start if another mercury3 is alive."""
    global _lock_fh
    lock_p = os.path.join(HERE, ".mercury3.lock")
    # "a" not "w": a doomed second instance must NOT truncate the live one's
    # pid before it fails flock (the panel reads this file to find us)
    _lock_fh = open(lock_p, "a")
    try:
        import fcntl
        fcntl.flock(_lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _lock_fh.seek(0)
        _lock_fh.truncate()
        _lock_fh.write(str(os.getpid()))
        _lock_fh.flush()
        return True
    except OSError:
        print("❌ un altro mercury3 è già in esecuzione (lock occupato) — esci.")
        return False

def main():
    global session, CHANNEL_ID
    logging.basicConfig(level=logging.WARNING)
    if not acquire_lock():
        sys.exit(1)
    if not TOKEN:
        print("❌ DISCORD_TOKEN mancante (mettilo in .env)")
        sys.exit(1)
    if not CHANNEL_ID:
        print("❌ channel_id mancante in config.json")
        sys.exit(1)
    for d in (CONTEXTS_DIR, MESSAGES_DIR, FILES_DIR):
        os.makedirs(d, exist_ok=True)
    if not os.path.isdir(ATTACH_DIR):
        print(f"ℹ️ crea {ATTACH_DIR}/ con i file da allegare random (ora vuota)")
        os.makedirs(ATTACH_DIR, exist_ok=True)

    session = create_session()
    load_video_pool()

    print("━" * 58)
    print(f"canale: {CHANNEL_ID}  self: {MY_USER_ID[:6] if MY_USER_ID else '?'}...")
    print(f"LLM: {'✅ ' + str(len(LLM_ENDPOINTS)) + ' endpoint' if llm_available() else '❌ offline (modalità statica)'}")
    try:
        me = session.get(f"{DISCORD_API}/users/@me", timeout=15)
        if me.status_code == 200:
            print(f"login ok: {me.json()['username']}")
        else:
            print(f"⚠️ token HTTP {me.status_code} — il selfbot verrà bannato da discord?")
    except Exception as e:
        print(f"⚠️ check login: {e}")
    print(f"ambient: {AMBIENT.get('target_messages_per_day', 500)}/giorno, ok_weight {AMBIENT.get('ok_weight'):.2f}")
    print(f"attachments: ogni ~{ATT_CFG.get('mean_gap_seconds', 1200)}s da {ATTACH_DIR}/")
    print(f"outbox: metti .txt in {OUTBOX}/ e li manda nel canale")
    print("━" * 58)

    if not _read_ch():
        seed = fetch_messages(limit=80)
        for mm_ in reversed(seed):
            c = (mm_.get("content") or "").strip()
            who = mm_.get("author", {}).get("username", "?")
            if mm_.get("author", {}).get("id") == MY_USER_ID:
                who = "assistant"
            if c:
                append_channel(who, c)
        print(f"🌱 channel window seed: {len(_read_ch())} msg")
    build_summary()
    threading.Thread(target=start_gateway, daemon=True).start()
    threading.Thread(target=llm_worker, daemon=True).start()  # UN solo worker: un burst non va spezzato in due batch
    threading.Thread(target=config_watchdog, daemon=True).start()
    if AMBIENT.get("enabled", True):
        threading.Thread(target=ambient_loop, daemon=True).start()
    if ATT_CFG.get("enabled", True):
        threading.Thread(target=attachment_loop, daemon=True).start()
    threading.Thread(target=channel_compressor, daemon=True).start()
    threading.Thread(target=outbox_loop, daemon=True).start()

    try:
        while not stop_event.is_set():
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n🛑 stop...")
        stop_event.set()

if __name__ == "__main__":
    main()
