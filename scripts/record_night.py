"""Record the park's live parking total once a minute on show days (Seoul time).

Run by .github/workflows/record.yml every 30 minutes between 13:00 and 00:30 KST.
Each run samples for up to RUN_MINUTES, then merges into records/YYYY-MM-DD.json
(deduplicated by minute), so overlapping or delayed runs never lose data.
"""
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

API = "https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504"
HALLS = re.compile(r"KSPO|체조|올림픽\s*홀|핸드볼|라이브\s*아레나|우리\s*금융|역도")
RUN_MINUTES = int(os.environ.get("RUN_MINUTES", "40"))
KST = dt.timezone(dt.timedelta(hours=9))
END_OF_DAY = 24 * 60 + 30  # stop recording 00:30 the next morning


def now_kst():
    return dt.datetime.now(KST)


def record_day(t):
    # 00:00-00:30 still belongs to the previous show night.
    return (t - dt.timedelta(minutes=30)).date() if t.hour == 0 and t.minute < 30 else t.date()


def minute_of(t, day):
    return int((t - dt.datetime.combine(day, dt.time(), KST)).total_seconds() // 60)


def shows_on(day):
    snap = json.loads(pathlib.Path("schedule.json").read_text(encoding="utf-8-sig"))
    iso, items, seen = day.isoformat(), [], set()
    for month in snap["months"].values():
        for group in month:
            for ev in group if isinstance(group, list) else [group]:
                if (ev.get("beginDt", "") <= iso <= ev.get("endDt", "") and ev.get("delYn") != "Y"
                        and HALLS.search(ev.get("plc") or "") and ev.get("evtSeq") not in seen):
                    seen.add(ev.get("evtSeq"))
                    items.append({k: ev.get(k) for k in ("evtSeq", "title", "plc", "beginDt", "endDt", "tm", "ndTm", "ndTmSource")})
    return items


def fetch():
    req = urllib.request.Request(API, headers={"User-Agent": "olpark-exit-clock recorder"})
    with urllib.request.urlopen(req, timeout=20) as r:
        value = json.loads(r.read())[0]["parking_sum"]
    return int(value)


def merge_and_push(day, shows, samples):
    path = pathlib.Path(f"records/{day.isoformat()}.json")
    for attempt in range(6):
        subprocess.run(["git", "fetch", "-q", "origin", "main"], check=True)
        subprocess.run(["git", "reset", "-q", "--hard", "origin/main"], check=True)
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        merged = {m: v for m, v in old.get("samples", [])}
        merged.update(samples)
        doc = {
            "day": day.isoformat(),
            "source": "한국체육산업개발 실시간 주차현황 API(parkingorsApi.do), 세 주차장 합계, GitHub Actions에서 1분 간격 수집",
            "unit": "samples = [그날 0시부터 지난 분, 주차 중 대수]",
            "shows": shows or old.get("shows", []),
            "samples": sorted([m, v] for m, v in merged.items()),
        }
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        index_path = pathlib.Path("records/index.json")
        index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {"days": []}
        entry = {"day": day.isoformat(), "count": len(doc["samples"]),
                 "first": doc["samples"][0][0], "last": doc["samples"][-1][0],
                 "titles": [s["title"] for s in doc["shows"]]}
        index["days"] = sorted([d for d in index["days"] if d["day"] != entry["day"]] + [entry], key=lambda d: d["day"], reverse=True)
        index_path.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        subprocess.run(["git", "add", "records"], check=True)
        if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode == 0:
            return
        subprocess.run(["git", "commit", "-q", "-m", f"공연 밤 주차 실측 기록 {day.isoformat()}"], check=True)
        if subprocess.run(["git", "push", "-q", "origin", "HEAD:main"]).returncode == 0:
            print(f"saved {len(samples)} new samples, {len(doc['samples'])} total")
            return
        time.sleep(5 + attempt * 5)
    sys.exit("push failed")


def main():
    start = now_kst()
    day = record_day(start)
    shows = shows_on(day)
    if not shows and os.environ.get("FORCE") != "1":
        print(f"{day}: 올림픽공원 4개 공연장 공연 없음, 기록 안 함")
        return
    print(f"{day}: " + " / ".join(s["title"] for s in shows))
    samples, errors = {}, 0
    deadline = start + dt.timedelta(minutes=RUN_MINUTES)
    while True:
        t = now_kst()
        m = minute_of(t, day)
        if t >= deadline or m > END_OF_DAY:
            break
        try:
            samples[m] = fetch()
        except Exception as e:
            errors += 1
            print(f"{t:%H:%M} 실패 {type(e).__name__}")
        time.sleep(60 - time.time() % 60 + 1)
    print(f"수집 {len(samples)}분, 실패 {errors}회")
    if samples:
        merge_and_push(day, shows, samples)


if __name__ == "__main__":
    main()
