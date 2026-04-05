#!/usr/bin/env python3
"""A股历史K线数据 - 使用 AKShare 获取历史K线"""

import json
import sys
from datetime import datetime

import akshare as ak
import pandas as pd


PERIOD_MAP = {
    "daily": "daily",
    "weekly": "weekly",
    "60min": "60",
    "30min": "30",
    "15min": "15",
    "5min": "5",
}

ADJUST_MAP = {
    "none": "",
    "qfq": "qfq",
    "hfq": "hfq",
}


def main():
    try:
        raw = sys.stdin.read().strip()
        params = json.loads(raw) if raw else {}

        symbol = params.get("symbol")
        if not symbol:
            print(json.dumps({
                "error": "symbol is required",
                "metadata": {"fetchedAt": datetime.now().isoformat()}
            }))
            sys.exit(1)

        period = params.get("period", "daily")
        start_date = params.get("startDate", "20200101")
        end_date = params.get("endDate", datetime.now().strftime("%Y%m%d"))
        adjust_type = params.get("adjustType", "qfq")

        ak_period = PERIOD_MAP.get(period, "daily")
        ak_adjust = ADJUST_MAP.get(adjust_type, "qfq")

        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period=ak_period,
            start_date=start_date,
            end_date=end_date,
            adjust=ak_adjust,
        )

        records = df.to_dict(orient="records")

        result = {
            "klines": records,
            "metadata": {
                "symbol": symbol,
                "period": period,
                "startDate": start_date,
                "endDate": end_date,
                "adjustType": adjust_type,
                "totalBars": len(records),
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
            },
        }
        print(json.dumps(result, ensure_ascii=False, default=str))

    except Exception as e:
        error_result = {
            "error": str(e),
            "metadata": {
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
            },
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
