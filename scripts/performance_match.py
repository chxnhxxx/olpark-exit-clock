"""Conservative cross-catalogue identity checks for Olympic Park performances."""
import datetime as dt
import html
import re
import unicodedata
import urllib.parse


def normalized(value):
    return ''.join(c for c in unicodedata.normalize('NFKC', html.unescape(value)).casefold() if c.isalnum())


def venue(value):
    text = normalized(value).removeprefix('올림픽공원')
    for label, aliases in (
        ('뮤즈라이브', ('뮤즈라이브',)),
        ('체조경기장', ('kspodome', '체조경기장')),
        ('핸드볼경기장', ('핸드볼경기장', '티켓링크라이브아레나', '펜싱경기장')),
        ('우리금융아트홀', ('우리금융아트홀', '역도경기장')),
    ):
        if any(alias in text for alias in aliases):
            return label
    return text


def match_event(record, events):
    for field in ('url', 'referenceIdentifier', 'source'):
        link = urllib.parse.urlparse(record.get(field) or '')
        if link.hostname in ('www.ksponco.or.kr', 'ksponco.or.kr'):
            key = urllib.parse.parse_qs(link.query).get('evtSeq', [None])[0]
            if key in events:
                return key

    title = normalized(record.get('title') or '')
    places = {venue(record.get(k) or '') for k in ('spatial', 'subjectKeyword')} - {''}
    schedule = unicodedata.normalize('NFKC', record.get('temporalCoverage') or '')
    dates = []
    for y, m, d in re.findall(r'(?<!\d)(20\d\d)\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})(?!\d)', schedule):
        try:
            dates.append(dt.date(int(y), int(m), int(d)).isoformat())
        except ValueError:
            return None
    title_years = re.findall(r'(?<!\d)20\d\d(?!\d)', record.get('title') or '')
    candidates = []
    for key, rows in events.items():
        event = rows[0]
        if normalized(event['title']) != title or venue(event['plc']) not in places:
            continue
        begin, end = event['beginDt'], event['endDt']
        if dates:
            if not all(begin <= day <= end for day in dates):
                continue
        elif begin[:4] not in title_years:
            continue
        candidates.append(key)
    return candidates[0] if len(candidates) == 1 else None

