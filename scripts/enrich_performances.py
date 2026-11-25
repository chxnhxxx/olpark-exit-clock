"""Enrich the park schedule with KCISA performances whose identity can be verified."""
import json
import os
import pathlib
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

path = pathlib.Path("schedule.json")
snapshot = json.loads(path.read_text(encoding="utf-8-sig"))
events = {}
for month in snapshot["months"].values():
    for group in month:
        for event in group if isinstance(group, list) else [group]:
            events.setdefault(str(event["evtSeq"]), []).append(event)

page, count = 1, 0
matched, enriched = set(), set()
while True:
    query = urllib.parse.urlencode(dict(serviceKey=os.environ["KCISA_SERVICE_KEY"],
                                        numOfRows=100, pageNo=page))
    url = "https://api.kcisa.kr/openapi/service/rest/meta/KSCperf?" + query
    with urllib.request.urlopen(url, timeout=40) as response:
        root = ET.fromstring(response.read())
    if root.findtext(".//resultCode") not in ("00", "0000", "0"):
        raise RuntimeError("공연정보 API 응답 코드를 확인해 주세요.")
    items = root.findall(".//item")
    count += len(items)
    for item in items:
        title = (item.findtext("title") or "").strip()
        event_id = None
        for field in ("url", "referenceIdentifier", "source"):
            link = urllib.parse.urlparse(item.findtext(field) or "")
            if link.hostname in ("www.ksponco.or.kr", "ksponco.or.kr"):
                event_id = urllib.parse.parse_qs(link.query).get("evtSeq", [None])[0]
                if event_id in events:
                    break
        if event_id not in events:
            # Only dated, venue-specific titles can identify a run without a shared ID.
            ids = [key for key, rows in events.items() if rows[0]["title"].strip() == title
                   and rows[0]["beginDt"][:4] in title and rows[0]["plc"].strip()
                   in " ".join(item.findtext(f) or "" for f in ("spatial", "subjectKeyword"))]
            if len(ids) != 1:
                continue
            event_id = ids[0]
        matched.add(event_id)
        for event in events[event_id]:
            genre = (item.findtext("subjectCategory") or "").strip()
            duration = (item.findtext("extent") or "").strip()
            if genre and event.get("cultureGenre") != genre:
                event["cultureGenre"] = genre
                enriched.add(event_id)
            if not str(event.get("ndTm") or "").strip() and re.fullmatch(r"(약\s*)?\d{1,3}\s*분", duration):
                event["ndTm"] = duration
                enriched.add(event_id)
    total = int(root.findtext(".//totalCount") or 0)
    if not items or (total and count >= total) or (not total and len(items) < 100):
        break
    page += 1

if enriched:
    path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"KCISA records={count}, matched events={len(matched)}, enriched events={len(enriched)}")
