import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from tencent_smart_erase import SmartEraseConfig
from tencent_smart_erase_region import RegionEraseClient, make_areas, region_parser


class RegionEraseTests(unittest.TestCase):
    def setUp(self):
        self.client = RegionEraseClient(SmartEraseConfig("id", "key", "bucket-123", "na-ashburn"))

    def test_request_contains_custom_subtitle_regions(self):
        areas = make_areas([[0.1, 0.7, 0.9, 0.95], [0.2, 0.4, 0.8, 0.6]], "percent")
        with patch.object(self.client, "_request", return_value={"Response": {"TaskId": "task"}}) as request:
            task_id = self.client.submit_region("https://example.com/in.mp4", "session", areas, 0, 0, "standard")
        self.assertEqual(task_id, "task")
        payload = request.call_args.args[1]
        self.assertEqual(payload["InputInfo"]["UrlInputInfo"]["Url"], "https://example.com/in.mp4")
        task = payload["SmartEraseTask"]
        self.assertEqual(task["Definition"], 0)
        self.assertEqual(task["OutputObjectPath"], "/jogg-smart-erase/session.mp4")
        config = task["RawParameter"]["EraseSubtitleConfig"]
        self.assertEqual(config["SubtitleEraseMethod"], "custom")
        self.assertEqual(config["CustomAreas"], [{"BeginMs": 0, "EndMs": 0, "Areas": areas}])
        self.assertEqual(areas[0]["Unit"], 1)

    def test_pixel_and_timed_area(self):
        areas = make_areas([[100, 1200, 900, 1500]], "pixel")
        with patch.object(self.client, "_request", return_value={"Response": {"TaskId": "task"}}) as request:
            self.client.submit_region("https://example.com/in.mp4", "", areas, 100, 5000, "area")
        config = request.call_args.args[1]["SmartEraseTask"]["RawParameter"]["EraseSubtitleConfig"]
        self.assertEqual(config["SubtitleModel"], "area")
        self.assertEqual(config["CustomAreas"][0]["EndMs"], 5000)
        self.assertEqual(areas[0]["Unit"], 2)

    def test_invalid_coordinates_and_times(self):
        for area in ([0, 0, 1, 0.9], [0.5, 0.1, 0.4, 0.5], [0, 0, float("nan"), 0.5]):
            with self.subTest(area=area), self.assertRaises(ValueError):
                make_areas([area], "percent")
        for begin, end in ((1, 0), (-1, 2), (100, 100)):
            with self.subTest(begin=begin, end=end), self.assertRaises(ValueError):
                self.client.submit_region("https://example.com/in.mp4", "", [{}], begin, end, "standard")

    def test_query_does_not_require_area(self):
        args = region_parser().parse_args(["--bucket", "bucket-123", "--output-region", "na-ashburn", "query", "--task-id", "task"])
        self.assertEqual(args.task_id, "task")


if __name__ == "__main__":
    unittest.main()
