"""Synthetic data-processing workload. Runs inside the sandbox."""
import json
import pandas as pd

INPUT = "/workspace/input.csv"
RESULT = "/workspace/result.csv"
SUMMARY = "/workspace/summary.json"

frame = pd.read_csv(INPUT)
frame["selected"] = frame["value"] >= 500

grouped = (
    frame.groupby("category", as_index=False)
    .agg(rows=("id", "count"), value_sum=("value", "sum"), value_mean=("value", "mean"))
    .sort_values("category")
)
grouped.to_csv(RESULT, index=False)

summary = {
    "rows": int(len(frame)),
    "filteredRows": int(frame["selected"].sum()),
    "categories": int(grouped.shape[0]),
    "maxValue": int(frame["value"].max()),
    "meanValue": float(frame["value"].mean()),
}
with open(SUMMARY, "w", encoding="utf-8") as handle:
    json.dump(summary, handle, sort_keys=True)
print(json.dumps(summary, sort_keys=True))
