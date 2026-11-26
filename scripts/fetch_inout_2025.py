"""Collect the pages of the 2025 Olympic Park vehicle in/out records (KCISA API_CPM_008, data.go.kr 15159093)
that are still missing, and keep only per-minute counts. Raw rows are never written to disk.

scripts/inout2025_todo.json lists the missing 2,500-row pages (the rest were collected earlier) and a
check page whose LOCAL_ID fingerprint must match, so the page order is confirmed before collecting.

Output on the data branch (inout2025/):
  state.json  done pages, row counts, parse failures
  park.json   {"YYYY-MM-DD": [entries per minute x1440, exits per minute x1440]}
  gates.json  {"YYYY-MM-DD|in|gate": {"5-minute slot": n}}
Env: KCISA_INOUT_KEY (never printed), RUN_MINUTES (default 320), PROBE=1 prints 3 rows and exits.
"""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

KEY = os.environ.get("KCISA_INOUT_KEY", "").strip()
URL = "https://api.kcisa.kr/openapi/API_CPM_008/request"
DEADLINE = time.time() + int(os.environ.get("RUN_MINUTES", "320")) * 60
PLAN = json.loads(pathlib.Path(__file__).with_name("inout2025_todo.json").read_text(encoding="utf-8"))
SIZE = PLAN["size"]
REPO = os.environ.get("DATA_REPO", ".")
OUT = pathlib.Path(REPO) / "inout2025"
ROW = re.compile(r"입구:([^,]*), 입차시간:(\d{4}-\d\d-\d\d \d\d:\d\d)[\d:]*(?:, 출구:([^,]*), 출차시간:(\d{4}-\d\d-\d\d \d\d:\d\d))?")


def redact(text):
    return text.replace(KEY, "***") if KEY else text


def call(page, size=SIZE):
    query = urllib.parse.urlencode({"serviceKey": KEY, "numOfRows": size, "pageNo": page})
    last = ""
    for attempt in range(7):
        req = urllib.request.Request(URL + "?" + query, headers={"Accept": "application/json", "User-Agent": "olpark-exit-clock"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                doc = json.loads(r.read().decode("utf-8", "replace"))
            body = doc.get("response", doc).get("body", doc)
            its = body.get("items", {})
            rows = its.get("item", its) if isinstance(its, dict) else its
            return rows if isinstance(rows, list) else [rows] if rows else []
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {redact(e.read()[:160].decode('utf-8', 'replace'))!r}"
            if e.code in (401, 403):
                raise SystemExit("인증 실패: KCISA_INOUT_KEY가 API_CPM_008에 승인된 키인지 확인해 주세요. " + last)
        except Exception as e:  # timeouts, resets, truncated JSON
            last = type(e).__name__
        wait = min(240, 5 * 3 ** attempt)
        print(f"  {page}쪽 재시도 {attempt + 1}: {last}, {wait}s 대기", flush=True)
        time.sleep(wait)
    return None


def load(name, default):
    p = OUT / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else default


def git(*args):
    return subprocess.run(["git", *args], check=False, capture_output=True, text=True, cwd=REPO)


def save(state, park, gates):
    OUT.mkdir(exist_ok=True)
    (OUT / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    (OUT / "park.json").write_text(json.dumps(park, separators=(",", ":")), encoding="utf-8")
    (OUT / "gates.json").write_text(json.dumps(gates, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if os.environ.get("NO_PUSH"):
        return
    git("add", "inout2025")
    if git("diff", "--cached", "--quiet").returncode:
        git("commit", "-m", f"2025 입출차 집계 {len(state['done'])}/{len(PLAN['todo'])}쪽")
        for _ in range(5):
            if git("push", "origin", "HEAD:data-inout-2025").returncode == 0:
                return
            time.sleep(10)


def main():
    if not KEY:
        raise SystemExit("KCISA_INOUT_KEY 시크릿이 없어요.")
    if os.environ.get("PROBE"):
        rows = call(1, 3)
        print("행 수", len(rows), "필드", sorted(rows[0]) if rows else None)
        for r in rows:
            m = ROW.search(r.get("DESCRIPTION", ""))
            print(r.get("TITLE"), "->", m.groups() if m else "해석 실패")
        return
    state = load("state.json", {"done": [], "rows": 0, "unparsed": 0, "checked": False})
    park, gates = load("park.json", {}), load("gates.json", {})
    if not state["checked"]:
        rows = call(PLAN["check"]["page"], PLAN["check"]["size"])
        sha = hashlib.sha256(",".join(r["LOCAL_ID"] for r in rows or []).encode()).hexdigest()[:16]
        if sha != PLAN["check"]["sha"]:
            raise SystemExit("쪽 순서가 이전 수집과 달라요. 남은 쪽만 이어 받으면 중복·누락이 생길 수 있어 멈춰요.")
        state["checked"] = True
        print("쪽 순서 확인: 이전 수집과 같아요.")
    todo = [p for p in PLAN["todo"] if p not in set(state["done"])]
    since = 0
    for page in todo:
        if time.time() > DEADLINE:
            break
        rows = call(page)
        if rows is None:
            print("계속 실패해서 여기까지 저장하고 다음 실행에서 이어받아요.")
            break
        for r in rows:
            m = ROW.search(r.get("DESCRIPTION", ""))
            if not m:
                state["unparsed"] += 1
                continue
            gi, ti, go, to = m.groups()
            for k, (g, t) in enumerate(((gi, ti), (go, to))):
                if not t:
                    continue
                day, minute = t[:10], int(t[11:13]) * 60 + int(t[14:16])
                park.setdefault(day, [[0] * 1440, [0] * 1440])[k][minute] += 1
                slot = gates.setdefault(f"{day}|{'in' if k == 0 else 'out'}|{g}", {})
                slot[str(minute // 5)] = slot.get(str(minute // 5), 0) + 1
        state["rows"] += len(rows)
        state["done"].append(page)
        since += 1
        if since >= 40:
            save(state, park, gates)
            print(f"{len(state['done'])}/{len(PLAN['todo'])}쪽, {state['rows']:,}행", flush=True)
            since = 0
        time.sleep(6)  # KCISA allows one call per 5 seconds
    state["complete"] = len(state["done"]) >= len(PLAN["todo"])
    save(state, park, gates)
    print("저장:", {k: (len(v) if isinstance(v, list) else v) for k, v in state.items()})


if __name__ == "__main__":
    main()
