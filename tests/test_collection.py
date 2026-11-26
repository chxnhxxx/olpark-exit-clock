"""Regressions for recording boundaries, collection failures and secret transport."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
import os
import pathlib
import runpy
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("record_night", ROOT / "scripts/record_night.py")
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)


@mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""})
class RecordingTests(unittest.TestCase):
    def test_midnight_boundary_and_delayed_runs(self):
        previous = dt.date(2026, 12, 31)
        for hour, minute in ((0, 29), (0, 30), (0, 31), (12, 59)):
            stamp = dt.datetime(2027, 1, 1, hour, minute, tzinfo=recorder.KST)
            self.assertEqual(recorder.record_day(stamp), previous)
        stamp = dt.datetime(2027, 1, 1, 13, tzinfo=recorder.KST)
        self.assertEqual(recorder.record_day(stamp), stamp.date())

    def test_only_0030_sample_is_recorded_at_boundary(self):
        stamp = dt.datetime(2027, 1, 1, 0, 30, tzinfo=recorder.KST)
        with mock.patch.object(recorder, "now_kst", side_effect=[stamp, stamp, stamp + dt.timedelta(minutes=1)]), \
             mock.patch.object(recorder, "shows_on", return_value=[{"title": "밤 공연"}]), \
             mock.patch.object(recorder, "fetch", return_value=1000), \
             mock.patch.object(recorder.time, "sleep"), \
             mock.patch.object(recorder, "merge_and_push") as save:
            recorder.main()
            self.assertEqual(save.call_args.args[0], dt.date(2026, 12, 31))
            self.assertEqual(save.call_args.args[2], {1470: 1000})

    def test_outside_collection_window_does_not_start_a_new_night(self):
        stamp = dt.datetime(2027, 1, 1, 0, 31, tzinfo=recorder.KST)
        with mock.patch.object(recorder, "now_kst", return_value=stamp), \
             mock.patch.object(recorder, "fetch") as fetch:
            recorder.main()
            fetch.assert_not_called()

    def test_all_failures_raise_and_partial_samples_are_saved(self):
        stamp = dt.datetime(2026, 11, 27, 21, tzinfo=recorder.KST)
        for responses in ([TimeoutError()] * 3, [1000, TimeoutError(), TimeoutError()]):
            ticks = [stamp, stamp, stamp + dt.timedelta(minutes=1),
                     stamp + dt.timedelta(minutes=2), stamp + dt.timedelta(minutes=3)]
            with mock.patch.object(recorder, "RUN_MINUTES", 3), \
                 mock.patch.object(recorder, "now_kst", side_effect=ticks), \
                 mock.patch.object(recorder, "shows_on", return_value=[{"title": "밤 공연"}]), \
                 mock.patch.object(recorder, "fetch", side_effect=responses), \
                 mock.patch.object(recorder.time, "sleep"), \
                 mock.patch.object(recorder, "merge_and_push") as save:
                with self.assertRaises(RuntimeError):
                    recorder.main()
                self.assertEqual(save.call_count, int(isinstance(responses[0], int)))

    def test_all_ui_venues_are_included(self):
        halls = ["KSPO DOME", "올림픽홀", "핸드볼경기장", "우리금융아트홀",
                 "K-아트홀", "88잔디마당", "뮤즈라이브"]
        events = [dict(evtSeq=i, title=name, plc=name, beginDt="2026-11-27",
                       endDt="2026-11-27") for i, name in enumerate(halls, 1)]
        text = json.dumps({"months": {"202611": [events]}})
        with mock.patch.object(pathlib.Path, "read_text", return_value=text):
            self.assertEqual(len(recorder.shows_on(dt.date(2026, 11, 27))), len(halls))


@mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""})
class EnrichmentTests(unittest.TestCase):
    def test_kopis_retries_only_https(self):
        source = (ROOT / "scripts/kopis_enrich.py").read_text(encoding="utf-8-sig")
        scope = {}
        with mock.patch.dict(os.environ, {"KOPIS_SERVICE_KEY": "fake-test-key"}):
            exec(compile(source.split("# --- official schedule")[0], "kopis", "exec"), scope)
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<dbs/>"
        with mock.patch.object(scope["OPENER"], "open", side_effect=[urllib.error.URLError("offline"), response]) as request, \
             mock.patch("time.sleep"):
            scope["get"]("pblprfr")
        self.assertTrue(all(call.args[0].full_url.startswith("https://")
                            for call in request.call_args_list))
        with self.assertRaises(RuntimeError):
            scope["HTTPSRedirectHandler"]().redirect_request(
                None, None, 302, "redirect", {}, "http://www.kopis.or.kr")

    def run_ticket(self, body=None, error=None):
        snapshot = {"months": {"202611": [[{
            "evtSeq": 1, "title": "공연", "ndTm": "",
            "evtLink": "https://nol.yanolja.com/ticket/products/123",
        }]]}}
        with tempfile.TemporaryDirectory() as folder:
            prior = pathlib.Path.cwd()
            os.chdir(folder)
            try:
                pathlib.Path("schedule.json").write_text(json.dumps(snapshot), encoding="utf-8")
                response = mock.MagicMock()
                response.__enter__.return_value.read.return_value = body or b""
                with mock.patch("urllib.request.urlopen", return_value=response, side_effect=error), \
                     mock.patch("time.sleep"):
                    runpy.run_path(str(ROOT / "scripts/ticket_runtime.py"))
                return json.loads(pathlib.Path("schedule.json").read_text(encoding="utf-8"))
            finally:
                os.chdir(prior)

    def test_ticket_total_failure_and_format_failure_raise(self):
        with self.assertRaises(RuntimeError):
            self.run_ticket(error=TimeoutError())
        with self.assertRaises(RuntimeError):
            self.run_ticket(body=b"<html>changed page</html>")

    def test_missing_runtime_and_valid_runtime(self):
        result = self.run_ticket(body=b'{"runningTime":""}')
        self.assertEqual(result["months"]["202611"][0][0]["ndTm"], "")
        result = self.run_ticket(body=b'{"runningTime":"120"}')
        self.assertEqual(result["months"]["202611"][0][0]["ndTm"], "120분")


if __name__ == "__main__":
    with mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": ""}), contextlib.redirect_stdout(io.StringIO()):
        unittest.main()
