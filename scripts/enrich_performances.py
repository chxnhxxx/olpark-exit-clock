"""Match public performance metadata to the park schedule by its official event ID."""
import json
import os
import pathlib
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

for page in range(1, 6):
    query = urllib.parse.urlencode(dict(serviceKey=os.environ["KCISA_SERVICE_KEY"],
                                        numOfRows=100, pageNo=page))
    with urllib.request.urlopen("https://api.kcisa.kr/openapi/service/rest/meta/KSCperf?" + query, timeout=20) as response:
        root = ET.fromstring(response.read())
    code = root.findtext(".//resultCode")
    if code not in ("00", "0000", "0"):
        raise RuntimeError("공연정보 API 응답 코드를 확인해 주세요.")
    items = root.findall(".//item")
    for item in items:
        link = urllib.parse.urlparse(item.findtext("url") or "")
        if link.hostname not in ("www.ksponco.or.kr", "ksponco.or.kr"):
            continue
        event_id = urllib.parse.parse_qs(link.query).get("evtSeq", [""])[0]
        for event in events.get(event_id, []):
            event["cultureGenre"] = item.findtext("subjectCategory") or ""
            if not event.get("ndTm") and item.findtext("extent"):
                event["ndTm"] = item.findtext("extent")
    if len(items) < 100:
        break
path.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
