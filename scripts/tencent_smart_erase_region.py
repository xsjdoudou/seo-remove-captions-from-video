#!/usr/bin/env python3
"""Tencent MPS subtitle erasure for explicitly selected rectangular regions.

Credentials and output options are the same as tencent_smart_erase.py.
Coordinates start at the top-left corner. Repeat --area to erase multiple
rectangles for the same time interval.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import uuid

from tencent_smart_erase import (
    SmartEraseConfig,
    TencentSmartEraseClient,
    TencentSmartEraseError,
    build_parser,
)


def make_areas(rectangles: list[list[float]], unit: str) -> list[dict]:
    areas = []
    for left, top, right, bottom in rectangles:
        values = (left, top, right, bottom)
        if not all(math.isfinite(value) and value >= 0 for value in values):
            raise ValueError("area coordinates must be finite and non-negative")
        if left >= right or top >= bottom:
            raise ValueError("each area must have left < right and top < bottom")
        if unit == "percent" and any(value >= 1 for value in values):
            raise ValueError("percent coordinates must be in [0, 1)")
        areas.append({
            "LeftTopX": left,
            "LeftTopY": top,
            "RightBottomX": right,
            "RightBottomY": bottom,
            "Unit": 1 if unit == "percent" else 2,
        })
    return areas


class RegionEraseClient(TencentSmartEraseClient):
    def submit_region(
        self, input_url: str, session_id: str, areas: list[dict],
        begin_ms: int, end_ms: int, model: str,
    ) -> str:
        if not input_url.strip():
            raise ValueError("--input-url cannot be empty")
        if not areas:
            raise ValueError("at least one area is required")
        if begin_ms < 0 or end_ms < 0 or (begin_ms, end_ms) != (0, 0) and end_ms <= begin_ms:
            raise ValueError("use 0,0 for the whole video or 0 <= begin-ms < end-ms")
        session_id = session_id.strip() or uuid.uuid4().hex
        response = self._request("ProcessMedia", {
            "InputInfo": {"Type": "URL", "UrlInputInfo": {"Url": input_url}},
            "OutputStorage": {
                "Type": "COS",
                "CosOutputStorage": {
                    "Bucket": self.config.bucket,
                    "Region": self.config.output_region,
                },
            },
            "OutputDir": "/",
            "SessionId": session_id,
            "SessionContext": session_id,
            "SmartEraseTask": {
                "Definition": 0,
                "RawParameter": {
                    "EraseType": "subtitle",
                    "EraseSubtitleConfig": {
                        "SubtitleEraseMethod": "custom",
                        "SubtitleModel": model,
                        "CustomAreas": [{
                            "BeginMs": begin_ms,
                            "EndMs": end_ms,
                            "Areas": areas,
                        }],
                    },
                },
                "OutputObjectPath": f"/{self.config.output_prefix}/{session_id}.mp4",
            },
        })
        task_id = str((response.get("Response") or {}).get("TaskId") or "").strip()
        if not task_id:
            raise TencentSmartEraseError("ProcessMedia returned no TaskId")
        return task_id


def region_parser() -> argparse.ArgumentParser:
    parser = build_parser()
    parser.description = "Tencent Cloud MPS subtitle erasure in specified areas"
    definition = parser._option_string_actions.pop("--definition")
    parser._remove_action(definition)
    parser.set_defaults(definition=101)
    subparsers = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
    for name in ("submit", "run"):
        command = subparsers.choices[name]
        command.add_argument(
            "--area", nargs=4, type=float, action="append", required=True,
            metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
            help="rectangle coordinates; repeat for multiple areas",
        )
        command.add_argument("--unit", choices=("percent", "pixel"), default="percent")
        command.add_argument("--begin-ms", type=int, default=0)
        command.add_argument("--end-ms", type=int, default=0)
        command.add_argument("--model", choices=("standard", "area"), default="standard")
    return parser


def main() -> int:
    args = region_parser().parse_args()
    try:
        client = RegionEraseClient(SmartEraseConfig.from_args(args))
        if args.command == "query":
            result = client.describe(args.task_id)
        else:
            task_id = client.submit_region(
                args.input_url, args.session_id, make_areas(args.area, args.unit),
                args.begin_ms, args.end_ms, args.model,
            )
            result = {"task_id": task_id} if args.command == "submit" else client.wait(task_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TencentSmartEraseError, TimeoutError, ValueError) as exc:
        # 和 tencent_smart_erase.py 的 main 保持一致：stderr 那行给人看，
        # --json-errors 额外往 stdout 写一个结构化对象，web 后端据此决定
        # 重试还是把任务判死。两边行为不一致的话，同一个腾讯云故障在自动模式下
        # 会被重试、在框选模式下却直接判死——而原因只是这个脚本少了几行。
        if getattr(args, "json_errors", False):
            print(
                json.dumps(
                    {
                        "error": {
                            "message": str(exc),
                            "retryable": bool(getattr(exc, "retryable", False))
                            or isinstance(exc, TimeoutError),
                        }
                    },
                    ensure_ascii=False,
                )
            )
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
