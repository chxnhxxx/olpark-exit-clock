"""Record the park's live parking total once a minute on show days (Seoul time).

Run by .github/workflows/record.yml every 30 minutes between 13:00 and 00:30 KST.
Each run samples for up to RUN_MINUTES, then merges into records/YYYY-MM-DD.json
(deduplicated by minute), so overlapping or delayed runs never lose data.
"""
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import time
import urllib.request

API = "https://www.ksponco.or.kr/online/main/parkingorsApi.do?apiKey=PARKING21803504"
RUN_MINUTES = int(os.environ.get("RUN_MINUTES", "40"))
KST = dt.timezone(dt.timedelta(hours=9))
END_OF_DAY = 24 * 60 + 30  # stop recording 00:30 the next morning


def now_kst():
    return dt.datetime.now(KST)


def record_day(t):
    # Runs delayed into the morning still belong to the previous show night.
    return (t - dt.timedelta(days=1)).date() if t.hour < 13 else t.date()


def minute_of(t, day):
    return int((t - dt.datetime.combine(day, dt.time(), KST)).total_seconds() // 60)


def shows_on(day):
    snap = json.loads(pathlib.Path("schedule.json").read_text(encoding="utf-8-sig"))
    iso, items, seen = day.isoformat(), [], set()
    for month in snap["months"].values():
        for group in month:
            for ev in group if isinstance(group, list) else [group]:
                if (ev.get("beginDt", "") <= iso <= ev.get("endDt", "") and ev.get("delYn") != "Y"
                        and str(ev.get("plc") or "").strip()):
                    key = ev.get("evtSeq") or (ev.get("title"), ev.get("plc"))
                    if key in seen:
                        continue
                    seen.add(key)
                    items.append({k: ev.get(k) for k in ("evtSeq", "title", "plc", "beginDt", "endDt", "tm", "ndTm", "ndTmSource")})
    return items


def fetch():
    req = urllib.request.Request(API, headers={"User-Agent": "olpark-exit-clock recorder"})
    with urllib.request.urlopen(req, timeout=20) as r:
        value = json.loads(r.read())[0]["parking_sum"]
    if isinstance(value, bool) or not str(value).strip().isdigit():
        raise ValueError("invalid parking count")
    return int(value)


def morning_floor(day, old=None):
    path = pathlib.Path("records/floor.json")
    if path.exists():
        floor = json.loads(path.read_text(encoding="utf-8"))
        for h in floor.get("history", []):
            if h.get("day") == day.isoformat():
                return h["count"]
    return (old or {}).get("floor")


def night_log(day, shows, samples):
    """Ask engine.js what the app shows now (first range, confirmed time, cleared time)."""
    try:
        doc = {"day": day.isoformat(), "shows": shows, "samples": sorted([m, v] for m, v in samples.items())}
        if (floor := morning_floor(day)) is not None:
            doc["floor"] = floor
        out = subprocess.run(["node", "scripts/night_log.cjs"], input=json.dumps(doc, ensure_ascii=False),
                             capture_output=True, text=True, timeout=30, encoding="utf-8")
        return json.loads(out.stdout) if out.returncode == 0 and out.stdout.strip() else {}
    except Exception as e:  # never let logging stop the recording
        print(f"판단 기록 실패 {type(e).__name__}")
        return {}


def log_decisions(log, now, verdict):
    """Keep each decision the first time it appears, stamped with the wall-clock minute it was made."""
    for key in ("onset", "firstRange", "confirmed", "cleared"):
        if key in verdict and key not in log:
            log[key] = {"value": verdict[key], "loggedAt": f"{now:%H:%M}"}
            print(f"{now:%H:%M} 판단 기록 {key}: {verdict[key]}")


def merge_and_push(day, shows, samples, decisions=None):
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
            **({"floor": f} if (f := morning_floor(day, old)) is not None else {}),
            "samples": sorted([m, v] for m, v in merged.items()),
        }
        # decisions made live on this night: keep whichever run logged each one first
        logged = dict(old.get("decisions", {}))
        for key, entry in (decisions or {}).items():
            if key not in logged or entry["loggedAt"] < logged[key]["loggedAt"]:
                logged[key] = entry
        if logged:
            doc["decisions"] = logged
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


def save_floor(t):
    """Once each morning: the API count with the lots empty, used by the app as the queue floor."""
    count = fetch()
    path = pathlib.Path("records/floor.json")
    for attempt in range(6):
        subprocess.run(["git", "fetch", "-q", "origin", "main"], check=True)
        subprocess.run(["git", "reset", "-q", "--hard", "origin/main"], check=True)
        old = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        history = [h for h in old.get("history", []) if h.get("day") != t.date().isoformat()][-13:]
        entry = {"day": t.date().isoformat(), "at": f"{t:%H:%M}", "count": count}
        doc = {**entry, "note": "05시 무렵 실시간 주차 대수(주차장이 거의 빈 시각). 출차 대기열 계산의 기준값", "history": history + [entry]}
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        subprocess.run(["git", "add", str(path)], check=True)
        if subprocess.run(["git", "diff", "--cached", "--quiet"]).returncode == 0:
            return
        subprocess.run(["git", "commit", "-q", "-m", f"아침 기준 주차 대수 {entry['day']}"], check=True)
        if subprocess.run(["git", "push", "-q", "origin", "HEAD:main"]).returncode == 0:
            print(f"floor {count} saved")
            return
        time.sleep(5 + attempt * 5)
    sys.exit("push failed")


def main():
    start = now_kst()
    if 4 <= start.hour < 8:
        save_floor(start)
        return
    day = record_day(start)
    stop = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(0, 31), KST)
    if start >= stop:
        print("기록 시간 밖: 공연 밤 기록은 다음 날 00:30분까지 수집합니다.")
        return
    shows = shows_on(day)
    if not shows and os.environ.get("FORCE") != "1":
        print(f"{day}: 올림픽공원 등록 공연 없음, 기록 안 함")
        return
    print(f"{day}: " + " / ".join(s["title"] for s in shows))
    samples, errors = {}, 0
    old_path = pathlib.Path(f"records/{day.isoformat()}.json")
    known = {m: v for m, v in json.loads(old_path.read_text(encoding="utf-8")).get("samples", [])} if old_path.exists() else {}
    decisions = {}
    deadline = min(start + dt.timedelta(minutes=RUN_MINUTES), stop)
    while True:
        t = now_kst()
        m = minute_of(t, day)
        if t >= deadline or m > END_OF_DAY:
            break
        try:
            samples[m] = fetch()
            log_decisions(decisions, t, night_log(day, shows, {**known, **samples}))
        except Exception as e:
            errors += 1
            print(f"{t:%H:%M} 실패 {type(e).__name__}")
        time.sleep(60 - time.time() % 60 + 1)
    print(f"수집 {len(samples)}분, 실패 {errors}회")
    if samples:
        merge_and_push(day, shows, samples, decisions)
    attempts = len(samples) + errors
    summary = f"주차 기록 {day}: 수집 {len(samples)}분 / 실패 {errors}회"
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as report:
            report.write(summary + "\n")
    if not samples or (attempts and errors / attempts > 0.5):
        raise RuntimeError("주차 수집 실패: 표본이 없거나 실패율이 50%를 초과했습니다.")


if __name__ == "__main__":
    main()
