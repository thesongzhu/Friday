#!/usr/bin/env python3
"""板块资金流向 - 使用 AKShare 获取板块和资金流向数据"""

import json
import sys
from datetime import datetime

import akshare as ak
import pandas as pd


def fetch_sector_rank(top_n=10):
    """行业板块排名"""
    df = ak.stock_board_industry_name_em()
    df = df.head(top_n)
    return df


def fetch_concept_rank(top_n=10):
    """概念板块排名"""
    df = ak.stock_board_concept_name_em()
    df = df.head(top_n)
    return df


def fetch_industry_flow(top_n=10):
    """个股资金流排名"""
    df = ak.stock_individual_fund_flow_rank(indicator="今日")
    df = df.head(top_n)
    return df


def fetch_northbound():
    """北向资金净流入"""
    df = ak.stock_hsgt_north_net_flow_in_em()
    return df


def main():
    try:
        raw = sys.stdin.read().strip()
        params = json.loads(raw) if raw else {}

        flow_type = params.get("flowType", "sector_rank")
        top_n = int(params.get("topN", 10))

        handlers = {
            "sector_rank": lambda: fetch_sector_rank(top_n),
            "concept_rank": lambda: fetch_concept_rank(top_n),
            "industry_flow": lambda: fetch_industry_flow(top_n),
            "northbound": lambda: fetch_northbound(),
        }

        if flow_type not in handlers:
            print(json.dumps({
                "error": f"Unknown flowType: {flow_type}",
                "flowData": {"fetchedAt": datetime.now().isoformat()},
                "rankings": [],
                "trendChange": [],
            }))
            sys.exit(1)

        df = handlers[flow_type]()

        if isinstance(df, pd.DataFrame):
            records = df.to_dict(orient="records")
        else:
            records = df

        result = {
            "rankings": records,
            "flowData": {
                "flowType": flow_type,
                "topN": top_n,
                "totalRecords": len(records),
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
            },
            "trendChange": [],
        }
        print(json.dumps(result, ensure_ascii=False, default=str))

    except Exception as e:
        error_result = {
            "error": str(e),
            "rankings": [],
            "flowData": {"fetchedAt": datetime.now().isoformat(), "source": "akshare"},
            "trendChange": [],
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
