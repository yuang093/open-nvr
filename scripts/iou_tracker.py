"""Greedy IOU tracker for static airplane detection.

Why greedy: airplane count is low (1-5), frame rate is slow (5 min),
DeepSORT is overkill. Greedy IOU matching is good enough.
"""
from __future__ import annotations
from typing import TypedDict


class Detection(TypedDict):
    id: str
    box: list[float]  # [x1, y1, x2, y2]


def box_iou(a: list[float], b: list[float]) -> float:
    """Compute intersection-over-union for two boxes [x1,y1,x2,y2]."""
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    inter = (ix2 - ix1) * (iy2 - iy1)
    area_a = (ax2 - ax1) * (ay2 - ay1)
    area_b = (bx2 - bx1) * (by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def greedy_iou_match(
    prev: list[Detection],
    curr: list[Detection],
    iou_thresh: float = 0.3,
) -> tuple[list[tuple[str, str]], list[str], list[str]]:
    """Greedy IOU match between previous and current detections.

    Returns:
        pairs: list of (prev_id, curr_id) that matched
        unmatched_prev: prev_ids with no match (candidates for departure)
        unmatched_curr: curr_ids with no match (candidates for arrival)
    """
    if not prev:
        return [], [], [d["id"] for d in curr]
    if not curr:
        return [], [d["id"] for d in prev], []

    ious = []
    for p in prev:
        row = []
        for c in curr:
            iou = box_iou(p["box"], c["box"])
            row.append(iou)
        ious.append(row)

    matched_p: set[int] = set()
    matched_c: set[int] = set()
    pairs: list[tuple[str, str]] = []

    while True:
        best_iou = 0.0
        best_pi = -1
        best_ci = -1
        for pi, p in enumerate(prev):
            if pi in matched_p:
                continue
            for ci, c in enumerate(curr):
                if ci in matched_c:
                    continue
                if ious[pi][ci] > best_iou and ious[pi][ci] >= iou_thresh:
                    best_iou = ious[pi][ci]
                    best_pi = pi
                    best_ci = ci
        if best_pi < 0:
            break
        pairs.append((prev[best_pi]["id"], curr[best_ci]["id"]))
        matched_p.add(best_pi)
        matched_c.add(best_ci)

    unmatched_prev = [prev[i]["id"] for i in range(len(prev)) if i not in matched_p]
    unmatched_curr = [curr[i]["id"] for i in range(len(curr)) if i not in matched_c]
    return pairs, unmatched_prev, unmatched_curr


class Tracker:
    """2-frame confirmation tracker.

    Each track needs to be detected N consecutive frames to be confirmed as 'arrived'.
    Each confirmed track needs to be missing N consecutive frames to fire 'departed'.

    Tracks that are never confirmed (transient false positives) are removed after
    a single miss without firing any event. This keeps state clean and avoids
    re-promoting the same id later -- re-detecting an old id starts a fresh
    confirmation cycle from pending=1.
    """

    def __init__(self, confirmation_frames: int = 2):
        self.confirmation_frames = confirmation_frames
        self._state: dict[str, dict[str, int]] = {}

    def update(self, detections: list[Detection]) -> list[dict]:
        """Process new frame detections, return arrival/departure events."""
        events: list[dict] = []
        seen_ids: set[str] = set()

        for d in detections:
            tid = d["id"]
            seen_ids.add(tid)
            state = self._state.get(tid)
            if state is None:
                self._state[tid] = {"pending": 1, "misses": 0}
            else:
                state["pending"] += 1
                state["misses"] = 0
                if state["pending"] >= self.confirmation_frames:
                    ev = self._maybe_fire_arrived(tid, state)
                    if ev:
                        events.append(ev)

        for tid in list(self._state.keys()):
            if tid in seen_ids:
                continue
            state = self._state[tid]
            if state["pending"] >= self.confirmation_frames:
                state["misses"] += 1
                if state["misses"] >= self.confirmation_frames:
                    ev = self._maybe_fire_departed(tid, state)
                    if ev:
                        events.append(ev)
                        del self._state[tid]
            else:
                del self._state[tid]

        return events

    def _maybe_fire_arrived(self, tid: str, state: dict) -> dict | None:
        if state.get("arrived_fired"):
            return None
        state["arrived_fired"] = True
        return {"class": "aeroplane", "track_id": tid, "event": "arrived"}

    def _maybe_fire_departed(self, tid: str, state: dict) -> dict | None:
        if state.get("departed_fired"):
            return None
        state["departed_fired"] = True
        return {"class": "aeroplane", "track_id": tid, "event": "departed"}
