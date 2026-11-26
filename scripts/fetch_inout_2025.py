"""Collect the 2025 Olympic Park vehicle in/out records (KCISA API_CPM_008, data.go.kr 15159093)
and keep only per-minute counts by day and gate. Raw rows are never written to disk.

Env: KCISA_INOUT_KEY (never printed), PAGE_SIZE (default 1000), RUN_MINUTES (default 320),
     PROBE=1 prints the shape of the first rows and exits.
State lives in inout2025/ on the data branch, so each run resumes from the next page.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

KEY = os.environ.get("KCISA_INOUT_KEY", "").strip()
URL = "https://api.kcisa.kr/openapi/API_CPM_008/request"
SIZE = int(os.environ.get("PAGE_SIZE", "1000"))
DEADLINE = time.time() + int(os.environ.get("RUN_MINUTES", "320")) * 60
REPO = os.environ.get("DATA_REPO", ".")
OUT = pathlib.Path(REPO) / "inout2025"
STATE, AGG = OUT / "state.json", OUT / "agg.json"


def redact(text):
    return text.replace(KEY, "***") if KEY else text


def call(page, size):
    query = urllib.parse.urlencode({"serviceKey": KEY, "numOfRows": size, "pageNo": page})
    last = ""
    for attempt in range(7):
        req = urllib.request.Request(URL + "?" + query, headers={"Accept": "application/json", "User-Agent": "olpark-exit-clock"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code} {redact(e.read()[:160].decode('utf-8', 'replace'))!r}"
            if e.code in (401, 403):
                raise SystemExit("인증 실패: KCISA_INOUT_KEY가 이 API(API_CPM_008)에 승인된 키인지 확인해 주세요. " + last)
        except Exception as e:  # timeouts, resets
            last = type(e).__name__
        wait = min(180, 5 * 3 ** attempt)
        print(f"  page {page} 재시도 {attempt + 1}: {last}, {wait}s 대기", flush=True)
        time.sleep(wait)
    return None


def items(body):
    text = body.decode("utf-8", "replace").strip()
    if text.startswith("{"):
        doc = json.loads(text)
        resp = doc.get("response", doc)
        b = resp.get("body", {})
        its = b.get("items", {})
        rows = its.get("item", its) if isinstance(its, dict) else its
        rows = rows if isinstance(rows, list) else [rows] if rows else []
        return rows, int(b.get("totalCount") or 0)
    root = ET.fromstring(text)
    rows = [{c.tag: (c.text or "").strip() for c in it} for it in root.iter("item")]
    return rows, int(root.findtext(".//totalCount") or 0)


STAMP = re.compile(r"(20\d\d)[-./]?(\d\d)[-./]?(\d\d)[ T]?(\d\d):?(\d\d)(?::?\d\d)?")


def parse(row):
    """Return [(kind, day, gate, 'HH:MM')] for the entry and the exit found in one row."""
    desc = " ".join(str(row.get(k, "")) for k in ("DESCRIPTION", "SUB_DESCRIPTION"))
    out = []
    # Split the text into the part about the entry and the part about the exit.
    parts = re.split(r"(?=출구|출차)", desc, maxsplit=1)
    for kind, part in zip(("in", "out"), parts if len(parts) == 2 else [desc, ""]):
        m = STAMP.search(part)
        if not m:
            continue
        y, mo, d, h, mi = m.groups()
        g = re.search(r"(?:입구|출구|게이트|GATE)\s*(?:게이트)?\s*[:：]?\s*([^\s,/|]+)", part, re.I)
        out.append((kind, f"{y}-{mo}-{d}", g.group(1) if g else "?", f"{h}:{mi}"))
    return out


def git(*args):
    return subprocess.run(["git", *args], check=False, capture_output=True, text=True, cwd=REPO)


def save(state, agg):
    OUT.mkdir(exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    AGG.write_text(json.dumps(agg, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    if os.environ.get("NO_PUSH"):
        return
    git("add", "inout2025")
    if git("diff", "--cached", "--quiet").returncode:
        git("commit", "-m", f"2025 입출차 집계 {state['next_page'] - 1}/{state.get('pages', '?')}쪽")
        for _ in range(5):
            if git("push", "origin", "HEAD:" + os.environ.get("DATA_BRANCH", "data-inout-2025")).returncode == 0:
                break
            time.sleep(10)


def main():
    if not KEY:
        raise SystemExit("KCISA_INOUT_KEY 시크릿이 없어요.")
    if os.environ.get("PROBE"):
        body = call(1, 3)
        rows, total = items(body)
        print("totalCount", total, "keys", sorted(rows[0]) if rows else None)
        for r in rows:
            print({k: (v[:300] if isinstance(v, str) else v) for k, v in r.items() if k.upper() not in ("URL",)})
            print("parsed ->", parse(r))
        return
    state = json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"next_page": 1, "rows": 0, "parsed": 0, "unparsed": 0, "size": SIZE}
    if state.get("size") != SIZE:
        raise SystemExit(f"PAGE_SIZE를 바꾸면 쪽 번호가 어긋나요. 기존 {state.get('size')}로 실행해 주세요.")
    agg = json.loads(AGG.read_text(encoding="utf-8")) if AGG.exists() else {"in": {}, "out": {}, "unparsed_samples": []}
    if state.get("done"):
        print("이미 다 모았어요.", state)
        return
    page, since = state["next_page"], 0
    while time.time() < DEADLINE:
        body = call(page, SIZE)
        if body is None:
            print("계속 실패해서 여기까지 저장하고 다음 실행에서 이어받아요.")
            break
        rows, total = items(body)
        if total:
            state["total"], state["pages"] = total, -(-total // SIZE)
        for r in rows:
            got = parse(r)
            if not got:
                state["unparsed"] += 1
                if len(agg["unparsed_samples"]) < 5:
                    agg["unparsed_samples"].append(str(r.get("DESCRIPTION", ""))[:200])
                continue
            state["parsed"] += 1
            for kind, day, gate, hm in got:
                slot = agg[kind].setdefault(day, {}).setdefault(gate, {})
                slot[hm] = slot.get(hm, 0) + 1
        state["rows"] += len(rows)
        state["next_page"] = page = page + 1
        since += 1
        if not rows or page > state.get("pages", page):
            state["done"] = True
            break
        if since >= 40:
            save(state, agg)
            print(f"{page - 1}/{state.get('pages')}쪽, {state['rows']:,}행, 해석 실패 {state['unparsed']:,}", flush=True)
            since = 0
        time.sleep(1.2)
    save(state, agg)
    print("저장:", {k: v for k, v in state.items()})


if __name__ == "__main__":
    main()
