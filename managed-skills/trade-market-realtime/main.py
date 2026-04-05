#!/usr/bin/env python3
"""A股实时行情数据 - 使用 AKShare 获取实时市场数据"""

import json
import sys
from datetime import datetime

import akshare as ak
import pandas as pd


def fetch_quote(symbols=None):
    """获取个股实时报价"""
    df = ak.stock_zh_a_spot_em()
    if symbols:
        df = df[df["代码"].isin(symbols)]
    return df


def fetch_limit_up_pool():
    """获取涨停池"""
    today = datetime.now().strftime("%Y%m%d")
    df = ak.stock_zt_pool_em(date=today)
    return df


def fetch_sector_heat(sector=None):
    """获取板块热度"""
    df = ak.stock_board_industry_name_em()
    if sector:
        df = df[df["板块名称"].str.contains(sector, na=False)]
    return df


def fetch_index():
    """获取指数行情"""
    df = ak.stock_zh_index_spot_em()
    return df


def fetch_auction(symbols=None):
    """获取集合竞价数据"""
    df = ak.stock_zh_a_spot_em()
    if symbols:
        df = df[df["代码"].isin(symbols)]
    return df


def fetch_dragon_tiger():
    """获取龙虎榜"""
    today = datetime.now().strftime("%Y%m%d")
    df = ak.stock_lhb_detail_em(date=today)
    return df


def main():
    try:
        raw = sys.stdin.read().strip()
        params = json.loads(raw) if raw else {}

        data_type = params.get("dataType", "quote")
        symbols = params.get("symbols", None)
        sector = params.get("sector", None)

        handlers = {
            "quote": lambda: fetch_quote(symbols),
            "limit_up_pool": lambda: fetch_limit_up_pool(),
            "sector_heat": lambda: fetch_sector_heat(sector),
            "index": lambda: fetch_index(),
            "auction": lambda: fetch_auction(symbols),
            "dragon_tiger": lambda: fetch_dragon_tiger(),
        }

        if data_type not in handlers:
            print(json.dumps({
                "error": f"Unknown dataType: {data_type}",
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare"
            }))
            sys.exit(1)

        df = handlers[data_type]()

        if isinstance(df, pd.DataFrame):
            records = df.to_dict(orient="records")
        else:
            records = df

        result = {
            "data": records,
            "fetchedAt": datetime.now().isoformat(),
            "source": "akshare"
        }
        print(json.dumps(result, ensure_ascii=False, default=str))

    except Exception as e:
        error_result = {
            "error": str(e),
            "fetchedAt": datetime.now().isoformat(),
            "source": "akshare"
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
