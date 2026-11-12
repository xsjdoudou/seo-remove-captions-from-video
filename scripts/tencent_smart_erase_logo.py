#!/usr/bin/env python3
"""Tencent MPS video logo removal using its watermark erasure feature."""

from __future__ import annotations

import argparse
import json
import sys
import uuid

from tencent_smart_erase import (
    SmartEraseConfig,
    TencentSmartEraseClient,
    TencentSmartEraseError,
    build_parser,
)
from tencent_smart_erase_region import make_areas


class LogoEraseClient(TencentSmartEraseClient):
    def submit_logo(
        self, input_url: str, session_id: str, method: str, model: str,
        areas: list[dict], begin_ms: int, end_ms: int,
    ) -> str:
        if not input_url.strip():
            raise ValueError("--input-url cannot be empty")
        if method not in ("auto", "custom") or model not in ("basic", "advanced"):
            raise ValueError("invalid watermark method or model")
        if begin_ms < 0 or end_ms < 0 or (
            (begin_ms, end_ms) != (0, 0) and end_ms <= begin_ms
        ):
            raise ValueError("use 0,0 for the whole video or 0 <= begin-ms < end-ms")
        config = {"WatermarkEraseMethod": method, "WatermarkModel": model}
        if method == "custom":
            if not areas:
                raise ValueError("custom mode requires at least one --area")
            config["CustomAreas"] = [{"BeginMs": begin_ms, "EndMs": end_ms, "Areas": areas}]
        else:
            if begin_ms or end_ms:
                raise ValueError("--begin-ms and --end-ms are only supported in custom mode")
            if areas:
                config["AutoAreas"] = areas

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
                    "EraseType": "watermark",
                    "EraseWatermarkConfig": config,
                },
                "OutputObjectPath": f"/{self.config.output_prefix}/{session_id}.mp4",
            },
        })
        task_id = str((response.get("Response") or {}).get("TaskId") or "").strip()
        if not task_id:
            raise TencentSmartEraseError("ProcessMedia returned no TaskId")
        return task_id


def logo_parser() -> argparse.ArgumentParser:
    parser = build_parser()
    parser.description = "Tencent Cloud MPS video logo/watermark removal"
    definition = parser._option_string_actions.pop("--definition")
    parser._remove_action(definition)
    parser.set_defaults(definition=101)
    subparsers = next(action for action in parser._actions if isinstance(action, argparse._SubParsersAction))
    for name in ("submit", "run"):
        command = subparsers.choices[name]
        command.add_argument("--method", choices=("auto", "custom"), default="custom")
        command.add_argument("--model", choices=("basic", "advanced"), default="advanced")
        command.add_argument(
            "--area", nargs=4, type=float, action="append", default=[],
            metavar=("LEFT", "TOP", "RIGHT", "BOTTOM"),
            help="rectangle coordinates; repeat for multiple areas",
        )
        command.add_argument("--unit", choices=("percent", "pixel"), default="percent")
        command.add_argument("--begin-ms", type=int, default=0)
        command.add_argument("--end-ms", type=int, default=0)
    return parser


def main() -> int:
    args = logo_parser().parse_args()
    try:
        client = LogoEraseClient(SmartEraseConfig.from_args(args))
        if args.command == "query":
            result = client.describe(args.task_id)
        else:
            task_id = client.submit_logo(
                args.input_url, args.session_id, args.method, args.model,
                make_areas(args.area, args.unit), args.begin_ms, args.end_ms,
            )
            result = {"task_id": task_id} if args.command == "submit" else client.wait(task_id)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TencentSmartEraseError, TimeoutError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
