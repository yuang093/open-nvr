"""Unit tests for iou_tracker.greedy_iou_match"""
from scripts.iou_tracker import greedy_iou_match, box_iou, Tracker


def test_box_iou_identical():
    assert box_iou([0, 0, 10, 10], [0, 0, 10, 10]) == 1.0


def test_box_iou_disjoint():
    assert box_iou([0, 0, 10, 10], [20, 20, 30, 30]) == 0.0


def test_box_iou_partial():
    # overlap = 25, union = 175
    iou = box_iou([0, 0, 10, 10], [5, 5, 15, 15])
    assert abs(iou - 25 / 175) < 0.001


def test_match_empty_prev():
    """No previous tracks -> all current are unmatched (new arrivals)."""
    pairs, unmatched_prev, unmatched_curr = greedy_iou_match([], [
        {"id": "a", "box": [0, 0, 10, 10]}
    ], iou_thresh=0.3)
    assert pairs == []
    assert unmatched_prev == []
    assert unmatched_curr == ["a"]


def test_match_empty_curr():
    """No current -> all prev are unmatched (departures)."""
    pairs, unmatched_prev, unmatched_curr = greedy_iou_match([
        {"id": "a", "box": [0, 0, 10, 10]}
    ], [], iou_thresh=0.3)
    assert pairs == []
    assert unmatched_prev == ["a"]
    assert unmatched_curr == []


def test_match_one_to_one():
    """Same airplane should match across frames."""
    pairs, up, uc = greedy_iou_match([
        {"id": "a", "box": [0, 0, 100, 100]}
    ], [
        {"id": "b", "box": [5, 5, 105, 105]}
    ], iou_thresh=0.3)
    assert len(pairs) == 1
    assert pairs[0] == ("a", "b")
    assert up == []
    assert uc == []


def test_match_below_threshold():
    """Non-overlapping tracks should not match."""
    pairs, up, uc = greedy_iou_match([
        {"id": "a", "box": [0, 0, 10, 10]}
    ], [
        {"id": "b", "box": [100, 100, 110, 110]}
    ], iou_thresh=0.3)
    assert pairs == []
    assert up == ["a"]
    assert uc == ["b"]


def test_tracker_2frame_confirmation_arrival():
    """Track needs 2 consecutive frames before becoming 'confirmed'."""
    t = Tracker(confirmation_frames=2)
    arrived = t.update([{"id": "x1", "box": [0, 0, 100, 100]}])
    assert arrived == []
    arrived = t.update([{"id": "x1", "box": [0, 0, 100, 100]}])
    assert arrived == [{"class": "aeroplane", "track_id": "x1", "event": "arrived"}]


def test_tracker_2frame_confirmation_departure():
    """Track needs 2 consecutive misses before 'departed'."""
    t = Tracker(confirmation_frames=2)
    t.update([{"id": "a", "box": [0, 0, 100, 100]}])
    t.update([{"id": "a", "box": [0, 0, 100, 100]}])
    departed = t.update([])
    assert departed == []
    departed = t.update([])
    assert len(departed) == 1
    assert departed[0]["event"] == "departed"
    assert departed[0]["track_id"] == "a"


def test_unconfirmed_track_removed_on_miss():
    """Transient false positive: track seen once and not confirmed is
    dropped after a single miss without firing any event."""
    t = Tracker(confirmation_frames=2)
    events = t.update([{"id": "transient", "box": [0, 0, 50, 50]}])
    assert events == []
    events = t.update([])
    assert events == []


def test_unconfirmed_track_does_not_affect_subsequent_arrival():
    """A transient miss-then-recover should not count toward confirmation."""
    t = Tracker(confirmation_frames=2)
    t.update([{"id": "x", "box": [0, 0, 50, 50]}])
    t.update([])
    events = t.update([{"id": "x", "box": [0, 0, 50, 50]}])
    assert events == []
    events = t.update([{"id": "x", "box": [0, 0, 50, 50]}])
    assert len(events) == 1
    assert events[0]["event"] == "arrived"
