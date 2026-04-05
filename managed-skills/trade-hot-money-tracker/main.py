#!/usr/bin/env python3
"""游资追踪器 - 使用 AKShare 追踪龙虎榜游资席位活动"""

import json
import sys
from collections import Counter, defaultdict
from datetime import datetime

import akshare as ak
import pandas as pd


def get_lhb_detail(date_str):
    """获取龙虎榜明细"""
    df = ak.stock_lhb_detail_em(start_date=date_str, end_date=date_str)
    return df


def get_lhb_stock_statistic(recent_days="5"):
    """获取龙虎榜个股统计"""
    df = ak.stock_lhb_stock_statistic_em(symbol="近" + recent_days + "日排行")
    return df


def filter_by_seats(df, seat_names):
    """按席位名称过滤"""
    if not seat_names or df.empty:
        return df
    mask = pd.Series(False, index=df.index)
    for col in df.columns:
        if "营业部" in str(col) or "席位" in str(col):
            for seat in seat_names:
                mask = mask | df[col].astype(str).str.contains(seat, na=False)
    return df[mask]


def filter_by_symbol(df, symbol):
    """按股票代码过滤"""
    if not symbol or df.empty:
        return df
    code_cols = [c for c in df.columns if "代码" in str(c)]
    if code_cols:
        return df[df[code_cols[0]].astype(str) == symbol]
    return df


def find_overlaps(df):
    """查找多席位重叠标的"""
    overlaps = []
    if df.empty:
        return overlaps

    code_cols = [c for c in df.columns if "代码" in str(c)]
    name_cols = [c for c in df.columns if "名称" in str(c) and "营业部" not in str(c)]
    seat_cols = [c for c in df.columns if "营业部" in str(c) or "席位" in str(c)]

    if not code_cols or not seat_cols:
        return overlaps

    code_col = code_cols[0]
    name_col = name_cols[0] if name_cols else None

    stock_seats = defaultdict(set)
    for _, row in df.iterrows():
        stock_code = str(row[code_col])
        for sc in seat_cols:
            seat_val = str(row.get(sc, ""))
            if seat_val and seat_val != "nan":
                stock_seats[stock_code].add(seat_val)

    for stock_code, seats in stock_seats.items():
        if len(seats) >= 2:
            entry = {
                "symbol": stock_code,
                "seatCount": len(seats),
                "seats": list(seats)[:10],
            }
            if name_col:
                matching = df[df[code_col].astype(str) == stock_code]
                if not matching.empty:
                    entry["name"] = str(matching.iloc[0].get(name_col, ""))
            overlaps.append(entry)

    overlaps.sort(key=lambda x: x["seatCount"], reverse=True)
    return overlaps


def compute_top_seats(df):
    """统计最活跃席位"""
    seat_cols = [c for c in df.columns if "营业部" in str(c) or "席位" in str(c)]
    if not seat_cols or df.empty:
        return []

    counter = Counter()
    for col in seat_cols:
        for val in df[col].dropna().astype(str):
            if val and val != "nan":
                counter[val] += 1

    top = [{"seatName": name, "appearances": count} for name, count in counter.most_common(20)]
    return top


def main():
    try:
        raw = sys.stdin.read().strip()
        params = json.loads(raw) if raw else {}

        date_str = params.get("date", datetime.now().strftime("%Y%m%d"))
        seat_names = params.get("seatNames", None)
        symbol = params.get("symbol", None)

        # Fetch dragon-tiger board detail
        df_detail = get_lhb_detail(date_str)

        # Apply filters
        filtered = df_detail.copy()
        if seat_names:
            filtered = filter_by_seats(filtered, seat_names)
        if symbol:
            filtered = filter_by_symbol(filtered, symbol)

        # Compute analytics
        top_seats = compute_top_seats(df_detail)
        seat_activity = filtered.to_dict(orient="records") if not filtered.empty else []
        overlaps = find_overlaps(df_detail)

        result = {
            "topSeats": top_seats,
            "seatActivity": seat_activity,
            "overlaps": overlaps,
            "metadata": {
                "date": date_str,
                "totalRecords": len(df_detail),
                "filteredRecords": len(filtered),
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
            },
        }
        print(json.dumps(result, ensure_ascii=False, default=str))

    except Exception as e:
        error_result = {
            "error": str(e),
            "topSeats": [],
            "seatActivity": [],
            "overlaps": [],
            "metadata": {
                "fetchedAt": datetime.now().isoformat(),
                "source": "akshare",
            },
        }
        print(json.dumps(error_result, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
