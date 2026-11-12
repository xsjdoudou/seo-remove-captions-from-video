import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from tencent_smart_erase import SmartEraseConfig
from tencent_smart_erase_logo import LogoEraseClient, logo_parser
from tencent_smart_erase_region import make_areas


class LogoEraseTests(unittest.TestCase):
    def setUp(self):
        self.client = LogoEraseClient(SmartEraseConfig("id", "key", "bucket-123", "na-ashburn"))

    def test_custom_areas(self):
        areas = make_areas([[67, 179, 490, 319], [860, 148, 986, 356]], "pixel")
        with patch.object(self.client, "_request", return_value={"Response": {"TaskId": "task"}}) as request:
            result = self.client.submit_logo("https://example.com/video.mp4", "abc", "custom", "advanced", areas, 0, 0)
        self.assertEqual(result, "task")
        task = request.call_args.args[1]["SmartEraseTask"]
        self.assertEqual(task["Definition"], 0)
        self.assertEqual(task["OutputObjectPath"], "/jogg-smart-erase/abc.mp4")
        self.assertEqual(task["RawParameter"], {
            "EraseType": "watermark",
            "EraseWatermarkConfig": {
                "WatermarkEraseMethod": "custom",
                "WatermarkModel": "advanced",
                "CustomAreas": [{"BeginMs": 0, "EndMs": 0, "Areas": areas}],
            },
        })

    def test_auto_with_and_without_areas(self):
        area = make_areas([[0.1, 0.2, 0.3, 0.4]], "percent")
        for areas in ([], area):
            with self.subTest(areas=areas):
                with patch.object(self.client, "_request", return_value={"Response": {"TaskId": "task"}}) as request:
                    self.client.submit_logo("https://example.com/video.mp4", "abc", "auto", "basic", areas, 0, 0)
                config = request.call_args.args[1]["SmartEraseTask"]["RawParameter"]["EraseWatermarkConfig"]
                self.assertEqual(config.get("AutoAreas"), areas or None)
                self.assertNotIn("CustomAreas", config)

    def test_validation(self):
        for method, areas, begin, end in (("custom", [], 0, 0), ("auto", [], 1, 10), ("custom", [{}], 3, 2)):
            with self.subTest(method=method, begin=begin, end=end), self.assertRaises(ValueError):
                self.client.submit_logo("https://example.com/video.mp4", "", method, "basic", areas, begin, end)

    def test_query_needs_no_area(self):
        args = logo_parser().parse_args(["--bucket", "bucket-123", "--output-region", "na-ashburn", "query", "--task-id", "task"])
        self.assertEqual(args.task_id, "task")


if __name__ == "__main__":
    unittest.main()
