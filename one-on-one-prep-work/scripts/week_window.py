#!/usr/bin/env python3
"""Compute the deterministic weekly One-on-One collection window."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime, time, timedelta
from typing import Iterable
from zoneinfo import ZoneInfo


BASE_END = datetime(2026, 7, 17, 15, 0, tzinfo=ZoneInfo("Asia/Shanghai"))
BASE_WEEK_NUMBER = 2


@dataclass(frozen=True)
class Window:
    start: datetime
    end: datetime
    week_number: int
    title: str

    def contains(self, value: datetime) -> bool:
        return self.start <= value.astimezone(self.start.tzinfo) < self.end

    def to_json(self) -> dict:
        payload = asdict(self)
        payload["start"] = self.start.isoformat()
        payload["end"] = self.end.isoformat()
        return payload


def scheduled_friday_end(anchor: datetime, timezone_name: str) -> datetime:
    timezone = ZoneInfo(timezone_name)
    local = anchor.replace(tzinfo=timezone) if anchor.tzinfo is None else anchor.astimezone(timezone)
    days_since_friday = (local.weekday() - 4) % 7
    friday = local.date() - timedelta(days=days_since_friday)
    candidate = datetime.combine(friday, time(15, 0), tzinfo=timezone)
    if local < candidate:
        candidate -= timedelta(days=7)
    return candidate


def compute_window(anchor: datetime, timezone_name: str = "Asia/Shanghai") -> Window:
    end = scheduled_friday_end(anchor, timezone_name)
    base_end = BASE_END.astimezone(ZoneInfo(timezone_name))
    week_offset = (end.date() - base_end.date()).days // 7
    week_number = BASE_WEEK_NUMBER + week_offset
    return Window(end - timedelta(days=7), end, week_number, f"Week-{week_number}")


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--at", default=datetime.now().astimezone().isoformat())
    parser.add_argument("--timezone", default="Asia/Shanghai")
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    print(json.dumps(compute_window(datetime.fromisoformat(args.at), args.timezone).to_json(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
