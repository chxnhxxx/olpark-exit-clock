"""Fill missing runtimes from official_runtime.json (values read from the agency's parking-forecast page).
Only events whose official schedule list has no runtime are touched; a published runtime always wins."""
import json, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
over = {k: v for k, v in json.loads((root / "official_runtime.json").read_text(encoding="utf-8")).items() if not k.startswith("_")}
path = root / "schedule.json"
doc = json.loads(path.read_text(encoding="utf-8"))
filled = []
for items in doc.get("months", {}).values():
    for e in items:
        o = over.get(str(e.get("evtSeq")))
        if not o or str(e.get("ndTm") or "").strip() and not e.get("ndTmSource"):
            continue  # no override, or the official list already publishes a runtime
        e["ndTm"] = o["ndTm"]
        e["ndTmSource"] = f"기관 주차 안내 {o['checked']}"
        filled.append(e["title"][:30])
path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"기관 주차 안내 소요시간 반영 {len(filled)}건", *filled, sep="\n- ")
