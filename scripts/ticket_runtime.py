"""Fill empty running times from the NOL ticket product page the official schedule links to.

Only shows whose official `ndTm` is still empty are fetched, one request each.
nol.yanolja.com/robots.txt allows /ticket/products/ (checked 2026-11-26).
Other ticket sites are skipped: Interpark disallows all bots, YES24 and Melon publish no robots.txt.
"""
import json
import os
import pathlib
import re
import time
import urllib.request

path = pathlib.Path("schedule.json")
snapshot = json.loads(path.read_text(encoding="utf-8-sig"))
UA = "Mozilla/5.0 (compatible; olpark-exit-clock/1.0; +https://chxnhxxx.github.io/olpark-exit-clock/)"

seen, filled, tried, failures = {}, [], [], []
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
    product = re.search(r"/ticket/products/(\d+)", link)
    if not product:
        failures.append(f"{seq}: 상품 번호를 읽을 수 없음")
        continue
    pid = product.group(1)
    url = f"https://nol.yanolja.com/ticket/products/{pid}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
            page = r.read().decode("utf-8", "replace")
    except Exception as e:
        failures.append(f"NOL {pid}: {type(e).__name__}")
        continue
    m = re.search(r'runningTime\\?"\s*:\s*\\?"(\d*)', page)
    minutes = int(m.group(1)) if m and m.group(1) else 0
    if not m or (minutes and not 30 <= minutes <= 400):
        failures.append(f"NOL {pid}: 러닝타임 응답 형식 확인 필요")
        continue
    tried.append(f"{ev['title'][:30]} → NOL {pid}: {minutes or '없음'}")
    if 30 <= minutes <= 400:
        for e in evs:
            e["ndTm"] = f"{minutes}분"
            e["ndTmSource"] = f"NOL티켓 {url}"
        filled.append(seq)
    time.sleep(2)

print("예매처 러닝타임 확인:", *tried, f"채움 {len(filled)}건", sep="\n- ")
summary = f"NOL 대상 {len(tried) + len(failures)}건, 응답 확인 {len(tried)}건, 실패 {len(failures)}건, 보강 {len(filled)}건"
print(summary)
for failure in failures:
    print(failure)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as report:
        report.write(summary + "\n")
if filled:
    path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
if failures and not tried:
    raise RuntimeError("NOL 러닝타임 조회 대상 전체 실패")
