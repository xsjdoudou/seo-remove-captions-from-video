#!/usr/bin/env python3
"""Call Tencent Cloud MPS SmartErase without the Tencent Cloud SDK.

The credentials are intentionally read only from environment variables:

    export TENCENT_SECRET_ID='...'
    export TENCENT_SECRET_KEY='...'

Example:
    python tencent_smart_erase.py \
        --bucket jogg-superres-1305113514 \
        --output-region na-ashburn \
        run --input-url 'https://example.com/input.mp4'

The input URL must be reachable by Tencent Cloud MPS. The output bucket must
be a COS bucket that the Tencent Cloud account can write to.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
import re
import sys
import time
from typing import Any
from urllib.parse import quote, urlparse
import uuid

import requests


DEFAULT_ENDPOINT = "https://mps.tencentcloudapi.com"
DEFAULT_MPS_REGION = "ap-guangzhou"
DEFAULT_DEFINITION = 101
DEFAULT_OUTPUT_PREFIX = "jogg-smart-erase"
DEFAULT_REQUEST_TIMEOUT = 30
DEFAULT_POLL_INTERVAL = 5.0
DEFAULT_POLL_TIMEOUT = 3600.0
DEFAULT_SIGNED_URL_SECONDS = 3600
BUCKET_OR_REGION = re.compile(r"^[a-z0-9-]+$")


class TencentSmartEraseError(RuntimeError):
    """A Tencent Cloud MPS or COS request failed."""


@dataclass(frozen=True)
class SmartEraseConfig:
    secret_id: str
    secret_key: str
    bucket: str
    output_region: str
    mps_region: str = DEFAULT_MPS_REGION
    endpoint: str = DEFAULT_ENDPOINT
    definition: int = DEFAULT_DEFINITION
    output_prefix: str = DEFAULT_OUTPUT_PREFIX
    request_timeout: int = DEFAULT_REQUEST_TIMEOUT
    poll_interval: float = DEFAULT_POLL_INTERVAL
    poll_timeout: float = DEFAULT_POLL_TIMEOUT
    signed_url_seconds: int = DEFAULT_SIGNED_URL_SECONDS

    @classmethod
    def from_args(cls, args: argparse.Namespace) -> "SmartEraseConfig":
        secret_id = os.getenv("TENCENT_SECRET_ID", "").strip()
        secret_key = os.getenv("TENCENT_SECRET_KEY", "").strip()
        if not secret_id or not secret_key:
            raise TencentSmartEraseError(
                "missing credentials; export TENCENT_SECRET_ID and "
                "TENCENT_SECRET_KEY before running the script"
            )
        bucket = args.bucket.strip()
        output_region = args.output_region.strip()
        if not BUCKET_OR_REGION.fullmatch(bucket):
            raise TencentSmartEraseError("--bucket must contain only lowercase letters, digits, and hyphens")
        if not BUCKET_OR_REGION.fullmatch(output_region):
            raise TencentSmartEraseError("--output-region must contain only lowercase letters, digits, and hyphens")
        if args.definition <= 0:
            raise TencentSmartEraseError("--definition must be a positive integer")
        return cls(
            secret_id=secret_id,
            secret_key=secret_key,
            bucket=bucket,
            output_region=output_region,
            mps_region=args.mps_region,
            endpoint=args.endpoint,
            definition=args.definition,
            output_prefix=args.output_prefix.strip("/") or DEFAULT_OUTPUT_PREFIX,
            request_timeout=args.request_timeout,
            poll_interval=args.poll_interval,
            poll_timeout=args.poll_timeout,
            signed_url_seconds=args.signed_url_seconds,
        )


class TencentSmartEraseClient:
    def __init__(self, config: SmartEraseConfig) -> None:
        self.config = config

    def submit(self, input_url: str, session_id: str) -> str:
        """Submit a SmartErase task and return the Tencent task ID."""
        if not input_url.strip():
            raise ValueError("--input-url cannot be empty")
        session_id = session_id.strip() or uuid.uuid4().hex
        output_path = f"/{self.config.output_prefix}/{session_id}.mp4"
        response = self._request(
            "ProcessMedia",
            {
                "InputInfo": {
                    "Type": "URL",
                    "UrlInputInfo": {"Url": input_url},
                },
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
                    "Definition": self.config.definition,
                    "OutputObjectPath": output_path,
                },
            },
        )
        task_id = str((response.get("Response") or {}).get("TaskId") or "").strip()
        if not task_id:
            raise TencentSmartEraseError("ProcessMedia returned no TaskId")
        return task_id

    def describe(self, task_id: str) -> dict[str, Any]:
        """Return a normalized task result, preserving the output path."""
        response = self._request("DescribeTaskDetail", {"TaskId": task_id})
        result = response.get("Response") or {}
        workflow = result.get("WorkflowTask") or {}
        erase_result = workflow.get("SmartEraseTaskResult") or {}
        workflow_code = workflow.get("ErrCode")
        result_code = erase_result.get("ErrCodeExt")
        result_status = str(erase_result.get("Status") or "").upper()
        if _is_error_code(workflow_code) or result_status == "FAIL" or result_code:
            raise TencentSmartEraseError(
                f"SmartErase task failed: task_id={task_id} "
                f"workflow_code={workflow_code!r} result_code={result_code!r} "
                f"message={erase_result.get('Message') or workflow.get('Message') or ''}"
            )

        status = str(result.get("Status") or "").upper()
        if status in {"WAITING", "PROCESSING"}:
            return {"status": "running", "task_id": task_id}
        if status != "FINISH":
            raise TencentSmartEraseError(
                f"unknown SmartErase status: task_id={task_id} status={status!r}"
            )
        if result_status != "SUCCESS":
            raise TencentSmartEraseError(
                f"SmartErase finished unsuccessfully: task_id={task_id} "
                f"status={result_status!r}"
            )

        output = erase_result.get("Output") or {}
        storage = output.get("OutputStorage") or {}
        cos = storage.get("CosOutputStorage") or {}
        path = str(output.get("Path") or "").strip()
        bucket = str(cos.get("Bucket") or "").strip()
        region = str(cos.get("Region") or "").strip()
        if storage.get("Type") != "COS" or not path or not bucket or not region:
            raise TencentSmartEraseError(
                f"SmartErase finished without a valid COS output: task_id={task_id}"
            )
        return {
            "status": "completed",
            "task_id": task_id,
            "path": path,
            "bucket": bucket,
            "region": region,
            "video_url": self.signed_url(bucket, region, path),
        }

    def wait(self, task_id: str) -> dict[str, Any]:
        """Poll until the task completes or the configured timeout is reached."""
        deadline = time.monotonic() + self.config.poll_timeout
        while time.monotonic() <= deadline:
            result = self.describe(task_id)
            if result["status"] != "running":
                return result
            print(f"task {task_id} is still processing", file=sys.stderr)
            time.sleep(self.config.poll_interval)
        raise TimeoutError(f"SmartErase task timed out: task_id={task_id}")

    def signed_url(self, bucket: str, region: str, path: str) -> str:
        """Create a temporary COS GET URL for the completed output."""
        if not BUCKET_OR_REGION.fullmatch(bucket) or not BUCKET_OR_REGION.fullmatch(region):
            raise TencentSmartEraseError("invalid COS bucket or region")
        parsed = urlparse(path)
        if parsed.scheme or parsed.netloc:
            expected_host = f"{bucket}.cos.{region}.myqcloud.com"
            if parsed.scheme != "https" or parsed.netloc != expected_host or parsed.username:
                raise TencentSmartEraseError("MPS returned an unexpected COS output URL")
            path = parsed.path
        key = path.lstrip("/")
        if not key:
            raise TencentSmartEraseError("COS output path is empty")
        start = int(time.time())
        end = start + self.config.signed_url_seconds
        key_time = f"{start};{end}"
        http_string = f"get\n/{quote(key, safe='/~')}\n\n\n"
        sign_key = hmac.new(
            self.config.secret_key.encode(), key_time.encode(), hashlib.sha1
        ).hexdigest()
        string_to_sign = f"sha1\n{key_time}\n{_sha1(http_string.encode())}\n"
        signature = hmac.new(
            sign_key.encode(), string_to_sign.encode(), hashlib.sha1
        ).hexdigest()
        query = (
            f"q-sign-algorithm=sha1&q-ak={quote(self.config.secret_id, safe='')}"
            f"&q-sign-time={key_time}&q-key-time={key_time}"
            f"&q-header-list=&q-url-param-list=&q-signature={signature}"
        )
        return f"https://{bucket}.cos.{region}.myqcloud.com/{quote(key, safe='/~')}?{query}"

    def _request(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        endpoint = self.config.endpoint
        parsed_endpoint = urlparse(endpoint)
        if parsed_endpoint.scheme != "https" or not parsed_endpoint.netloc or parsed_endpoint.path not in ("", "/"):
            raise TencentSmartEraseError(f"invalid MPS endpoint: {endpoint}")
        host = parsed_endpoint.netloc
        timestamp = int(time.time())
        date = datetime.fromtimestamp(timestamp, tz=timezone.utc).strftime("%Y-%m-%d")
        payload_bytes = json.dumps(
            payload, ensure_ascii=False, separators=(",", ":")
        ).encode()
        canonical_headers = f"content-type:application/json\nhost:{host}\n"
        signed_headers = "content-type;host"
        canonical_request = "\n".join(
            ["POST", "/", "", canonical_headers, signed_headers, _sha256(payload_bytes)]
        )
        scope = f"{date}/mps/tc3_request"
        string_to_sign = "\n".join(
            ["TC3-HMAC-SHA256", str(timestamp), scope, _sha256(canonical_request.encode())]
        )
        signing_key = _hmac(
            _hmac(_hmac(f"TC3{self.config.secret_key}".encode(), date), "mps"),
            "tc3_request",
        )
        signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()
        authorization = (
            f"TC3-HMAC-SHA256 Credential={self.config.secret_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        )
        try:
            http_response = requests.post(
                endpoint,
                data=payload_bytes,
                headers={
                    "Authorization": authorization,
                    "Content-Type": "application/json",
                    "Host": host,
                    "X-TC-Action": action,
                    "X-TC-Version": "2019-06-12",
                    "X-TC-Timestamp": str(timestamp),
                    "X-TC-Region": self.config.mps_region,
                },
                timeout=self.config.request_timeout,
            )
            http_response.raise_for_status()
            body = http_response.json()
        except requests.RequestException as exc:
            raise TencentSmartEraseError(f"MPS {action} network request failed: {exc}") from exc
        except ValueError as exc:
            raise TencentSmartEraseError(
                f"MPS {action} returned non-JSON: {http_response.text[:500]}"
            ) from exc
        error = (body.get("Response") or {}).get("Error")
        if error:
            raise TencentSmartEraseError(f"MPS {action} failed: {error}")
        return body


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Tencent Cloud MPS SmartErase client")
    parser.add_argument("--bucket", required=True, help="COS output bucket")
    parser.add_argument("--output-region", required=True, help="COS output region")
    parser.add_argument("--mps-region", default=os.getenv("TENCENT_MPS_REGION", DEFAULT_MPS_REGION))
    parser.add_argument("--endpoint", default=os.getenv("TENCENT_MPS_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--definition", type=int, default=DEFAULT_DEFINITION)
    parser.add_argument("--output-prefix", default=DEFAULT_OUTPUT_PREFIX)
    parser.add_argument("--request-timeout", type=int, default=DEFAULT_REQUEST_TIMEOUT)
    parser.add_argument("--poll-interval", type=float, default=DEFAULT_POLL_INTERVAL)
    parser.add_argument("--poll-timeout", type=float, default=DEFAULT_POLL_TIMEOUT)
    parser.add_argument("--signed-url-seconds", type=int, default=DEFAULT_SIGNED_URL_SECONDS)

    subparsers = parser.add_subparsers(dest="command", required=True)
    submit = subparsers.add_parser("submit", help="submit a task and print its task ID")
    submit.add_argument("--input-url", required=True)
    submit.add_argument("--session-id", default="", help="optional id used in the output object path")

    query = subparsers.add_parser("query", help="query a previously submitted task")
    query.add_argument("--task-id", required=True)

    run = subparsers.add_parser("run", help="submit and poll a task until completion")
    run.add_argument("--input-url", required=True)
    run.add_argument("--session-id", default="", help="optional id used in the output object path")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        client = TencentSmartEraseClient(SmartEraseConfig.from_args(args))
        if args.command == "submit":
            print(json.dumps({"task_id": client.submit(args.input_url, args.session_id)}, ensure_ascii=False))
        elif args.command == "query":
            print(json.dumps(client.describe(args.task_id), ensure_ascii=False))
        else:
            task_id = client.submit(args.input_url, args.session_id)
            result = client.wait(task_id)
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except (TencentSmartEraseError, TimeoutError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


def _is_error_code(value: Any) -> bool:
    return value not in (None, 0, "0", "")


def _sha1(value: bytes) -> str:
    return hashlib.sha1(value).hexdigest()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _hmac(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


if __name__ == "__main__":
    raise SystemExit(main())
