"""Read Feishu with runner-only credentials; write plaintext only into RUNNER_TEMP."""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from xml.sax.saxutils import escape
import caldav

ORIGIN = 'https://caldav.feishu.cn'
SHANGHAI = dt.timezone(dt.timedelta(hours=8))
original_request = caldav.request


def safe_request(method, url, *args, **kwargs):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or parsed.netloc != 'caldav.feishu.cn':
        raise ValueError('Unexpected CalDAV host')
    return original_request(method, url, *args, **kwargs)


def strict_multiget(base, auth, url, hrefs):
    result = []
    for offset in range(0, len(hrefs), 20):
        batch = hrefs[offset:offset + 20]
        body = caldav.REPORT_MULTIGET.format(hrefs=''.join('<d:href>'+escape(h)+'</d:href>' for h in batch))
        _, text = caldav.request('REPORT', url, body, {'Depth': '1'}, auth)
        got = caldav.extract_calendar_data(text)
        if len(got) != len(batch):
            raise RuntimeError('Incomplete calendar response')
        result.extend(got)
    return result


caldav.request = safe_request
caldav.fetch_by_multiget = strict_multiget


def collect(username, password):
    now = dt.datetime.now(SHANGHAI).replace(microsecond=0)
    start, end = now - dt.timedelta(days=365), now + dt.timedelta(days=220)
    stamp = lambda x: x.astimezone(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    auth = (username, password)
    calendars = caldav.discover_calendars(ORIGIN, auth)
    if not calendars:
        raise RuntimeError('No calendars found')
    events, seen = [], set()
    for calendar in calendars:
        texts, _ = caldav.fetch_ics_texts(ORIGIN, auth, calendar['href'], stamp(start), stamp(end))
        for text in texts:
            for event in caldav.build_events(calendar['name'], text, start.replace(tzinfo=None), end.replace(tzinfo=None)):
                if event['id'] in seen:
                    continue
                seen.add(event['id'])
                for field in ('start', 'end'):
                    event[field] = dt.datetime.fromisoformat(event[field]).replace(tzinfo=SHANGHAI).isoformat()
                events.append(event)
    if len(events) > 5000:
        raise RuntimeError('Calendar event limit exceeded; snapshot was not truncated')
    events.sort(key=lambda e: e['start'])
    return {'meta': {'source': 'caldav', 'complete': True, 'syncedAt': now.isoformat(),
                     'rangeStart': start.isoformat(), 'rangeEnd': end.isoformat(),
                     'calendars': [c['name'] for c in calendars], 'count': len(events)}, 'events': events}


def retain_published(filename='feishu.enc.json'):
    """Keep the previous ciphertext during site edits before Secrets are configured."""
    url = f'https://zhangning521.github.io/calendar/{filename}?retain={int(time.time())}'
    try:
        with urllib.request.urlopen(url, timeout=25) as response:
            raw = response.read(24 * 1024 * 1024 + 1)
        value = json.loads(raw)
        if len(raw) > 24 * 1024 * 1024 or value.get('algorithm') != 'AES-256-GCM' or value.get('version') != 1:
            raise ValueError('Invalid previously published ciphertext')
    except urllib.error.HTTPError as error:
        if error.code == 404:
            print('No previous cloud snapshot.')
            return
        raise
    target = Path('_site/calendar') / filename
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output')
    parser.add_argument('--retain-published', action='store_true')
    parser.add_argument('--retain-published-tasks', action='store_true')
    args = parser.parse_args()
    os.environ['TZ'] = 'Asia/Shanghai'
    if hasattr(time, 'tzset'):
        time.tzset()
    try:
        if args.retain_published:
            retain_published()
            return 0
        if args.retain_published_tasks:
            retain_published('feishu-tasks.enc.json')
            return 0
        username, password, phrase = (os.environ.get(k, '') for k in ('FEISHU_CALDAV_USERNAME', 'FEISHU_CALDAV_PASSWORD', 'CALENDAR_PASSPHRASE'))
        if not username or not password or len(phrase) < 16 or not args.output:
            raise ValueError('Set FEISHU_CALDAV_USERNAME, FEISHU_CALDAV_PASSWORD and CALENDAR_PASSPHRASE (at least 16 characters)')
        data = collect(username, password)
        target = Path(args.output)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        target.chmod(0o600)
        print('CalDAV read completed. Plaintext is temporary and will be encrypted before deployment.')
        return 0
    except Exception:
        # Do not print HTTP responses, calendar titles, account names or credential-bearing traces.
        print('::error::Calendar update failed. Check the three Secrets, CalDAV authorization and network access. The last deployed site and calendar are retained.')
        return 1


if __name__ == '__main__':
    sys.exit(main())
