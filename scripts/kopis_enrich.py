"""Check KOPIS coverage for the four Olympic Park halls and fill missing running times.

Reads KOPIS_SERVICE_KEY from the environment and never prints it.
Writes a coverage report to stdout (and to $GITHUB_STEP_SUMMARY when set).
Only fills `ndTm` when the official schedule left it empty and exactly one
KOPIS record matches by hall, overlapping dates and a similar title.
"""
from performance_match import normalized, venue
import datetime as dt
import json
import os
import pathlib
import re
import time
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

KEY = os.environ["KOPIS_SERVICE_KEY"]
BASES = ("https://www.kopis.or.kr/openApi/restful/", "http://www.kopis.or.kr/openApi/restful/")
HALLS = {"체조경기장": "KSPO DOME", "올림픽홀": "올림픽홀",
         "핸드볼경기장": "티켓링크 라이브 아레나", "우리금융아트홀": "우리금융아트홀"}
FACILITY_QUERIES = ("올림픽공원",)


def get(path, **params):
    query = urllib.parse.urlencode(dict(service=KEY, **params))
    last = ""
    for attempt in range(4):
        base = BASES[attempt % len(BASES)]
        req = urllib.request.Request(base + path + "?" + query, headers={"User-Agent": "Mozilla/5.0 olpark-exit-clock"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
            break
        except urllib.error.HTTPError as e:  # never echo the URL: it holds the key
            snippet = e.read()[:200].decode("utf-8", "replace").replace(KEY, "***")
            last = f"HTTP {e.code} ({base.split('/')[0]}) {snippet!r}"
        except Exception as e:
            last = f"{type(e).__name__} ({base.split('/')[0]})"
        print("KOPIS 재시도:", path.split('/')[0], last)
        time.sleep(5 + attempt * 10)
    else:
        raise RuntimeError(f"KOPIS 요청 실패 ({path.split('/')[0]}): {last}")
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise RuntimeError("KOPIS 응답이 XML이 아니에요. 서비스키를 확인해 주세요.") from None
    code = root.findtext(".//returncode")
    if code and code not in ("00", "0"):
        raise RuntimeError(f"KOPIS 오류 코드 {code}: {root.findtext('.//errmsg') or ''}")
    return root


def hall(name):
    label = venue(name or "")
    if label not in HALLS and "올림픽홀" in normalized(name or "") and "뮤즈라이브" not in normalized(name or ""):
        label = "올림픽홀"
    return label if label in HALLS else None


def kdate(text):
    return (text or "").strip().replace(".", "-")


def runtime_minutes(text):
    t = (text or "").replace(" ", "")
    h = re.search(r"(\d+)시간", t)
    m = re.search(r"(\d+)분", t)
    total = (int(h.group(1)) * 60 if h else 0) + (int(m.group(1)) if m else 0)
    return total if 30 <= total <= 400 else None


def strip_title(s):
    s = re.sub(r"\[[^\]]*서울[^\]]*\]|［[^］]*서울[^］]*］", "", s or "")
    return normalized(re.sub(r"20\d\d", "", s))


def similarity(a, b):
    a, b = strip_title(a), strip_title(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    grams = lambda s: {s[i:i + 2] for i in range(len(s) - 1)} or {s}
    x, y = grams(a), grams(b)
    return len(x & y) / len(x | y)


# --- official schedule -------------------------------------------------------
path = pathlib.Path("schedule.json")
snapshot = json.loads(path.read_text(encoding="utf-8-sig"))
official = {}
for month in snapshot["months"].values():
    for group in month:
        for ev in group if isinstance(group, list) else [group]:
            official.setdefault(str(ev["evtSeq"]), []).append(ev)
official = {k: v for k, v in official.items() if hall(v[0].get("plc"))}

# --- KOPIS records at the four halls ----------------------------------------
today = dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=9)
first = dt.date(today.year, today.month, 1)
months = []
for k in (-1, 0, 1, 2):
    y, m = divmod(first.month - 1 + k, 12)
    start = dt.date(first.year + y, m + 1, 1)
    end = (dt.date(start.year + (start.month == 12), start.month % 12 + 1, 1) - dt.timedelta(days=1))
    months.append((start, end))

records = {}
for start, end in months:
    for fac in FACILITY_QUERIES:
        page = 1
        while True:
            root = get("pblprfr", stdate=start.strftime("%Y%m%d"), eddate=end.strftime("%Y%m%d"),
                       cpage=page, rows=100, shprfnmfct=fac)
            rows = root.findall(".//db")
            if page == 1:
                names = sorted({(db.findtext("fcltynm") or "")[:30] for db in rows})[:6]
                print(f"KOPIS 목록 {start:%Y-%m} '{fac}': {len(rows)}건 {names} root={root.tag} {ET.tostring(root)[:120] if not rows else ''}")
            for db in rows:
                rid = db.findtext("mt20id")
                if rid and "올림픽공원" in (db.findtext("fcltynm") or ""):
                    records[rid] = {c.tag: (c.text or "").strip() for c in db}
            if len(rows) < 100 or page >= 20:
                break
            page += 1

for rid, rec in records.items():
    d = get("pblprfr/" + rid).find(".//db")
    if d is not None:
        rec["prfruntime"] = (d.findtext("prfruntime") or "").strip()
        rec["dtguidance"] = (d.findtext("dtguidance") or "").strip()
        rec["fcltynm"] = (d.findtext("fcltynm") or rec.get("fcltynm") or "").strip()
    time.sleep(0.3)
    rec["hall"] = hall(rec.get("fcltynm"))
    rec["from"], rec["to"] = kdate(rec.get("prfpdfrom")), kdate(rec.get("prfpdto"))
    rec["minutes"] = runtime_minutes(rec.get("prfruntime"))
records = {r: rec for r, rec in records.items() if rec["hall"]}

# --- match official shows to KOPIS -------------------------------------------
lines, matched, filled, used = [], {}, [], set()
for key, evs in official.items():
    ev = evs[0]
    h = hall(ev["plc"])
    cands = []
    for rid, rec in records.items():
        if rec["hall"] != h or rec["to"] < ev["beginDt"] or rec["from"] > ev["endDt"]:
            continue
        s = similarity(ev["title"], rec.get("prfnm"))
        if s >= 0.35:
            cands.append((s, rid))
    cands.sort(reverse=True)
    if len({normalized(records[r].get("prfnm", "")) for _, r in cands}) == 1:
        cands = cands[:1]  # KOPIS sometimes splits one run into one record per day
    if cands and (len(cands) == 1 or cands[0][0] - cands[1][0] >= 0.15):
        rid = cands[0][1]
        matched[key] = rid
        used.add(rid)
        rec = records[rid]
        had = bool(str(ev.get("ndTm") or "").strip())
        if not had and rec["minutes"]:
            for e in evs:
                e["ndTm"] = f"{rec['minutes']}분"
                e["ndTmSource"] = "KOPIS " + rid
            filled.append(key)
        lines.append(f"| {ev['beginDt']} | {HALLS[h]} | {ev['title'][:28]} | {rec.get('prfnm', '')[:28]} | {cands[0][0]:.2f} | "
                     f"{ev.get('ndTm') if had else '(없음)'} | {rec.get('prfruntime') or '(없음)'} |")
    else:
        lines.append(f"| {ev['beginDt']} | {HALLS[h]} | {ev['title'][:28]} | (매칭 없음{', 후보 ' + str(len(cands)) if cands else ''}) | | "
                     f"{ev.get('ndTm') or '(없음)'} | |")

window = (months[0][0].isoformat(), months[2][1].isoformat())
in_window = {r: rec for r, rec in records.items() if rec["to"] >= window[0] and rec["from"] <= window[1]}
missing_official = [rec for r, rec in in_window.items() if r not in used]
with_rt = sum(1 for rec in in_window.values() if rec["minutes"])
blank_before = [k for k, v in official.items() if not str(v[0].get("ndTm") or "").strip() or k in filled]

report = [
    "## KOPIS 공연정보 점검",
    f"- 기간: {window[0]} ~ {window[1]} (지난달부터 3개월), 올림픽공원 4개 공연장",
    f"- KOPIS 공연 수: {len(in_window)}건, 러닝타임 있음: {with_rt}건 ({with_rt / len(in_window) * 100:.0f}%)" if in_window else "- KOPIS 공연 수: 0건",
    f"- 공식 일정 공연 수: {len(official)}건, KOPIS와 매칭: {len(matched)}건 ({len(matched) / len(official) * 100:.0f}%)" if official else "- 공식 일정 공연 수: 0건",
    f"- 공식 러닝타임이 비어 있던 공연: {len(blank_before)}건, KOPIS로 채움: {len(filled)}건",
    "",
    "| 시작일 | 공연장 | 공식 제목 | KOPIS 제목 | 유사도 | 공식 러닝타임 | KOPIS 러닝타임 |",
    "|---|---|---|---|---|---|---|",
    *lines,
    "",
    f"### 공식 일정에 없는 KOPIS 공연 ({len(missing_official)}건)",
    *[f"- {r['from']}~{r['to']} {HALLS[r['hall']]} {r.get('prfnm', '')[:40]} ({r.get('prfruntime') or '러닝타임 없음'})"
      for r in sorted(missing_official, key=lambda r: r["from"])],
]
text = "\n".join(report)
print(text)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
        f.write(text + "\n")
pathlib.Path("kopis_report.md").write_text(text + "\n", encoding="utf-8")

if filled:
    path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
