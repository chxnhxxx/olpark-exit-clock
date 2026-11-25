"""Fill empty running times from the NOL ticket product page the official schedule links to.

Only shows whose official `ndTm` is still empty are fetched, one request each.
nol.yanolja.com/robots.txt allows /ticket/products/ (checked 2026-11-26).
Other ticket sites are skipped: Interpark disallows all bots, YES24 and Melon publish no robots.txt.
"""
import json
import pathlib
import re
import time
import urllib.request

path = pathlib.Path("schedule.json")
snapshot = json.loads(path.read_text(encoding="utf-8-sig"))
UA = "Mozilla/5.0 (compatible; olpark-exit-clock/1.0; +https://chxnhxxx.github.io/olpark-exit-clock/)"

seen, filled, tried = {}, [], []
for month in snapshot["months"].values():
    for group in month:
        for ev in group if isinstance(group, list) else [group]:
            seen.setdefault(ev["evtSeq"], []).append(ev)

for seq, evs in seen.items():
    ev = evs[0]
    if str(ev.get("ndTm") or "").strip():
        continue
    link = next((u for u in (ev.get("evtLink"), ev.get("rsvLink")) if u and "nol.yanolja.com/ticket/products/" in u), None)
    if not link:
        continue
    pid = re.search(r"/ticket/products/(\d+)", link).group(1)
    url = f"https://nol.yanolja.com/ticket/products/{pid}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
            page = r.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"NOL {pid}: {type(e).__name__}")
        continue
    m = re.search(r'runningTime\\?"\s*:\s*\\?"(\d*)', page)
    minutes = int(m.group(1)) if m and m.group(1) else 0
    tried.append(f"{ev['title'][:30]} → NOL {pid}: {minutes or '없음'}")
    if 30 <= minutes <= 400:
        for e in evs:
            e["ndTm"] = f"{minutes}분"
            e["ndTmSource"] = f"NOL티켓 {url}"
        filled.append(seq)
    time.sleep(2)

print("예매처 러닝타임 확인:", *tried, f"채움 {len(filled)}건", sep="\n- ")
if filled:
    path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
